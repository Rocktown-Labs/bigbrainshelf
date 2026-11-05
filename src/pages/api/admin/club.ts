import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { ensureClubTable, clubPlanOf } from "../../../lib/club";
import {
  CLUB_PRICE_CENTS,
  CLUB_ANNUAL_PRICE_CENTS,
  AUDIO_CLUB_PRICE_CENTS,
  AUDIO_CLUB_ANNUAL_PRICE_CENTS,
} from "../../../lib/offers";
import {
  clubMemberCycleEligible,
  ensureClubCycleTables,
  getClubBox,
  listEligibleClubBooks,
  resolveClubBoxForAdmin,
  setClubBoxPack,
  updateClubBoxByAdmin,
} from "../../../lib/club-cycles";
import { clubAnchorDateString, memberCycleWindowDates } from "../../../lib/club-cycle-dates";
import { chicagoDateString } from "../../../lib/offers";
import { enqueueClubCycleEmail, CLUB_BOX_SHIPPED_KIND } from "../../../lib/club-emails";
import { markSeen } from "../../../lib/seen";
import { flushOutbox } from "../../../lib/email";
import { loadBooksByAnySlug, normalizePackState, parsePackState } from "../../../lib/orders";
import { boxContentsComplete, packLinesForBox, packProgress } from "../../../lib/packing";
import { buyDestinationLabel, buyUspsLabelForDestination, destinationFromStored, getDestinationLabelQuote, pickupStateFor, requestPickup, shippoStatus } from "../../../lib/shippo";
import { coverDerivative } from "../../../lib/derivatives";
import { adminMediaUrl } from "../../../lib/media";
import { getOrMintSerial, listSerialsForBox, serialLabel } from "../../../lib/serials";

// Admin Book Club queue. Gated by the middleware's admin session cookie,
// with the locals.user check as defense in depth (same pattern as
// /api/admin/orders).
//
// GET -> all club signups (newest first) + counts per shelf and status,
//        plus Book Club V2 cycle boxes (upcoming and recent), per-status
//        box counts, and the eligible book list for override controls.
// GET ?box_id= -> the unified fulfillment payload for ONE box (admin
//        redesign S4): the box, its member, its pack checklist, label
//        and pickup state, and the eligible books for the pick step.
// POST { action: "update_box", box_id, book_slug?, slot?, clear?,
//        status?, carrier?, tracking_number?, label_url? } -> resolve
//        a box slot to a book (or clear it with clear: true), change
//        its fulfilment status, or attach tracking. Marking a box
//        shipped enqueues the member's shipped email with tracking.
//        Marking shipped is gated here: the box needs a purchased
//        label and a fully ticked pack checklist.
// POST { action: "set_pack", box_id, pack } -> persist pack ticks.
// POST { action: "box_label_quote", box_id } -> Shippo rate preview
//        for the box's one parcel to the member's club address.
// POST { action: "buy_box_label", box_id, shipment_id, rate_id } ->
//        buy the quoted label and store it on the box row.
// POST { action: "buy_box_label_usps", box_id } -> one-click USPS
//        label (quote and buy in one call; shipping is inside the
//        club price, so there is no rate for the operator to pick).
// POST { action: "schedule_pickup", box_id } -> Shippo pickup for the
//        box's label (USPS Priority-class / DHL Express only).

export const GET: APIRoute = async ({ locals, url }) => {
  if (!(locals as any)?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const e = env as any;
  await ensureClubTable(e.DB);
  // Single member for /admin/club/[id]: the full signup row, the
  // member's boxes, and their store orders by email. Opening the
  // member is what clears them from the sidebar badge (a failed
  // payment keeps counting on the state rule).
  const memberId = url.searchParams.get("member_id");
  if (memberId) {
    const member = await e.DB.prepare("SELECT * FROM club_signups WHERE id = ?").bind(memberId).first();
    if (!member) return Response.json({ error: "member not found" }, { status: 404 });
    await markSeen(e.DB, "club_signups", memberId);
    let boxes: any[] = [];
    try {
      const b = await e.DB.prepare(
        "SELECT * FROM club_cycle_boxes WHERE signup_id = ? ORDER BY ship_date ASC LIMIT 100"
      ).bind(memberId).all();
      boxes = (b.results || []) as any[];
    } catch { /* cycle tables may not exist yet */ }
    let orders: any[] = [];
    try {
      const o = await e.DB.prepare(
        "SELECT id, amount, currency, status, physical_status, created_at, items, book_slugs, ship_name, ship_address, shipping_cents FROM orders WHERE email = ? ORDER BY created_at DESC LIMIT 20"
      ).bind(String((member as any).email || "")).all();
      orders = (o.results || []) as any[];
      // What they actually bought, in public titles (never slugs),
      // plus lifetime spend on completed orders: the member view
      // answers "have they ordered, and what" at a glance.
      const { orderItemLabels } = await import("../../../lib/orders");
      const labels = await orderItemLabels(e.DB, orders as any).catch(() => new Map());
      for (const ord of orders as any[]) {
        ord.items_display = labels.get(ord.id) || [];
        delete ord.items;
        delete ord.book_slugs;
      }
    } catch { /* orders are a bonus, never a blocker */ }
    const totalSpent = (orders as any[])
      .filter((o) => o.status === "complete")
      .reduce((sum, o) => sum + (Number(o.amount) || 0), 0);
    // Ships-to snapshot: the member's own club address first (it is
    // collected at club checkout and stored on the signup row), then
    // the most recent physical order's address for members from
    // before that collection existed. Lifted out so the drawer shows
    // it once instead of per order.
    let shipping: any = null;
    if ((member as any).ship_name || (member as any).ship_address) {
      let addr: any = (member as any).ship_address;
      if (typeof addr === "string") { try { addr = JSON.parse(addr); } catch { addr = { raw: addr }; } }
      shipping = { name: (member as any).ship_name || "", address: addr, source: "club" };
    }
    for (const ord of orders as any[]) {
      if (!shipping && (ord.ship_name || ord.ship_address)) {
        let addr: any = ord.ship_address;
        if (typeof addr === "string") { try { addr = JSON.parse(addr); } catch { addr = { raw: addr }; } }
        shipping = { name: ord.ship_name || "", address: addr };
      }
      delete ord.ship_name;
      delete ord.ship_address;
    }
    // The linked store account (CG, 2026-10-31: "know everything
    // about this customer"): identity, standing, and the account's
    // own Stripe customer, which is distinct from the club's.
    let account: any = null;
    try {
      await e.DB.prepare("ALTER TABLE user ADD COLUMN stripe_customer_id TEXT").run().catch(() => {});
      const byId = (member as any).user_id
        ? await e.DB.prepare("SELECT id, name, email, emailVerified, role, banned, createdAt, stripe_customer_id FROM user WHERE id = ?").bind(String((member as any).user_id)).first().catch(() => null)
        : null;
      account = byId || await e.DB.prepare("SELECT id, name, email, emailVerified, role, banned, createdAt, stripe_customer_id FROM user WHERE lower(email) = lower(?)").bind(String((member as any).email || "")).first().catch(() => null);
    } catch { /* account link is a bonus */ }
    // Reviews this customer has written, any status.
    let reviews: any[] = [];
    try {
      const rv = await e.DB.prepare(
        `SELECT r.rating, r.status, r.created_at, b.title AS book_title
           FROM reviews r LEFT JOIN books b ON b.slug = r.book_slug
          WHERE r.user_id = ? OR lower(r.user_email) = lower(?)
          ORDER BY r.created_at DESC LIMIT 10`
      ).bind(String((member as any).user_id || ""), String((member as any).email || "")).all();
      reviews = (rv.results || []) as any[];
    } catch { /* reviews are a bonus */ }
    return Response.json({ member, boxes, orders, total_spent_cents: totalSpent, shipping, account, reviews });
  }
  // Single box for the unified fulfillment view (/admin/orders/box/[id]).
  const boxId = url.searchParams.get("box_id");
  if (boxId) {
    await ensureClubCycleTables(e.DB);
    let box = await e.DB.prepare(
      `SELECT b.*, s.name AS member_name, s.email AS member_email
       FROM club_cycle_boxes b JOIN club_signups s ON s.id = b.signup_id
       WHERE b.id = ?`
    ).bind(boxId).first() as any;
    if (!box) return Response.json({ error: "box not found" }, { status: 404 });
    // A Mystery box never waits on a human to pick its books (CG,
    // 2026-11-05): fill any unresolved surprise slot on the spot,
    // with the lock-time rules, before the payload is built. A
    // resolver failure must never break the page, so it is logged
    // and swallowed.
    if (box.status === "awaiting_selection" || box.status === "needs_attention") {
      try {
        const fullMember = await e.DB.prepare(
          "SELECT * FROM club_signups WHERE id = ?"
        ).bind(String(box.signup_id)).first();
        if (fullMember) {
          const resolved = await resolveClubBoxForAdmin(e.DB, box, fullMember);
          // getClubBox rows lack the member join fields above; keep them.
          if (resolved) box = { ...resolved, member_name: box.member_name, member_email: box.member_email };
        }
      } catch (err) {
        console.error("club box auto-resolve failed", boxId, err);
      }
    }
    const member = await e.DB.prepare(
      "SELECT id, name, email, ship_name, ship_address FROM club_signups WHERE id = ?"
    ).bind(String(box.signup_id)).first();
    const slotSlugs = [
      String(box.resolved_book_slug || box.selected_book_slug || ""),
      String(box.second_resolved_book_slug || box.second_selected_book_slug || ""),
    ].filter(Boolean);
    const books = await loadBooksByAnySlug(e.DB, slotSlugs, "slug, title, cover_key, public_slug").catch(() => new Map());
    // Copy serials (CG, 2026-11-05): once the box's books are set,
    // each physical copy mints its number (slot 1 the gift set,
    // slot 2 the printed book) so the operator sees it while
    // packing. Idempotent; a mint failure never breaks the page.
    let serials: any[] = [];
    try {
      if (boxContentsComplete(box)) {
        const slotFormats: [string, string][] = [
          [String(box.resolved_book_slug || box.selected_book_slug || ""), "giftset"],
          [String(box.second_resolved_book_slug || box.second_selected_book_slug || ""), "printed"],
        ];
        for (let i = 0; i < slotFormats.length; i++) {
          const [slug, format] = slotFormats[i];
          if (!slug) continue;
          await getOrMintSerial(e.DB, {
            bookSlug: slug,
            grantKey: `club-box:${boxId}:${slug}:slot${i + 1}`,
            format,
            clubBoxId: boxId,
          });
        }
      }
      const rows = await listSerialsForBox(e.DB, boxId);
      serials = rows.map((s) => ({ slug: s.bookSlug, label: serialLabel(s.volume, s.serial), code: s.code, format: s.format }));
    } catch { /* serials are a display extra, never a blocker */ }
    const packState = parsePackState(box.pack_json);
    const packLines = packLinesForBox(box, books as Map<string, any>);
    const eligible = await listEligibleClubBooks(e.DB).catch(() => []);
    const eligibleBooks = (eligible as any[]).map((b) => ({
      ...b,
      // Admin-only response: the fallback rides the gated admin media
      // route, not the media host's immutable raw URL, so a replaced
      // cover is what the picker shows on the next load.
      cover:
        coverDerivative(String(b.slug), "card", b.cover_key) ||
        (b.cover_key ? adminMediaUrl(b.cover_key) : null),
    }));
    return Response.json({
      box,
      member,
      contents_complete: boxContentsComplete(box),
      pack_lines: packLines,
      pack_state: packState,
      pack_progress: packProgress(packLines, packState),
      pickup: pickupStateFor(box),
      serials,
      eligibleBooks,
      shippo: shippoStatus(e),
    });
  }
  const rows = await e.DB.prepare(
    "SELECT id, name, email, shelf, status, created_at, plan, club_plan, user_id, paid_at, first_ship_date, stripe_subscription_id, subscription_status, payment_failed_at FROM club_signups ORDER BY created_at DESC LIMIT 500"
  ).all();
  const signups = (rows.results || []) as any[];
  const byShelf: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  // Period counts for the PHYSICAL club (the founding cap and the
  // quarterly revenue math are physical-only concepts).
  let paidQuarterly = 0;
  let paidAnnual = 0;
  // Audio Club counts by its own periods (monthly | annual).
  let paidAudioMonthly = 0;
  let paidAudioAnnual = 0;
  for (const s of signups) {
    byShelf[s.shelf] = (byShelf[s.shelf] || 0) + 1;
    byStatus[s.status] = (byStatus[s.status] || 0) + 1;
    if (s.status === "paid") {
      if (clubPlanOf(s) === "audio") {
        if (s.plan === "annual") paidAudioAnnual += 1;
        else paidAudioMonthly += 1;
      } else if (s.plan === "annual") paidAnnual += 1;
      else paidQuarterly += 1;
    }
  }
  const paidCount = paidQuarterly + paidAnnual;
  const paidAudioCount = paidAudioMonthly + paidAudioAnnual;
  // Quarterly revenue equivalent (physical club): quarterly members pay
  // CLUB_PRICE_CENTS per quarter; annual members count as a quarter of
  // CLUB_ANNUAL_PRICE_CENTS per quarter.
  const quarterlyRevenueCents =
    paidQuarterly * CLUB_PRICE_CENTS + paidAnnual * Math.round(CLUB_ANNUAL_PRICE_CENTS / 4);
  // Audio Club monthly revenue equivalent: monthly members pay
  // AUDIO_CLUB_PRICE_CENTS per month; annual members count as a twelfth
  // of AUDIO_CLUB_ANNUAL_PRICE_CENTS per month.
  const audioMonthlyRevenueCents =
    paidAudioMonthly * AUDIO_CLUB_PRICE_CENTS +
    paidAudioAnnual * Math.round(AUDIO_CLUB_ANNUAL_PRICE_CENTS / 12);

  // Book Club V2 cycles: boxes that still need a decision or fulfilment
  // first (oldest ship date first), then the most recent finished ones.
  // Bounded at 300 rows; cycle generation in the scheduler is likewise
  // bounded, so this stays cheap at volume.
  await ensureClubCycleTables(e.DB);
  const boxRows = await e.DB.prepare(
    `SELECT b.*, s.name AS member_name, s.email AS member_email, s.subscription_status AS member_subscription_status,
            sel.title AS selected_title, res.title AS resolved_title,
            sel2.title AS second_selected_title, res2.title AS second_resolved_title
     FROM club_cycle_boxes b
     JOIN club_signups s ON s.id = b.signup_id
     LEFT JOIN books sel ON sel.slug = b.selected_book_slug
     LEFT JOIN books res ON res.slug = b.resolved_book_slug
     LEFT JOIN books sel2 ON sel2.slug = b.second_selected_book_slug
     LEFT JOIN books res2 ON res2.slug = b.second_resolved_book_slug
     ORDER BY CASE WHEN b.status IN ('needs_attention','awaiting_selection','locked','preparing','shipped') THEN 0 ELSE 1 END,
              b.ship_date ASC, b.created_at ASC
     LIMIT 300`
  ).all();
  const boxes = (boxRows.results || []) as any[];
  const boxByStatus: Record<string, number> = {};
  for (const b of boxes) boxByStatus[b.status] = (boxByStatus[b.status] || 0) + 1;
  // "Boxes to pack" stat: the work waiting on the operator — boxes
  // flagged needs_attention at any date, plus boxes whose ship date
  // has arrived and that are still in a packing state. Counted over
  // the whole table, not just the returned window.
  const packRow = await e.DB.prepare(
    `SELECT COUNT(*) AS n FROM club_cycle_boxes
      WHERE status = 'needs_attention'
         OR (ship_date <= ? AND status IN ('awaiting_selection', 'locked', 'preparing'))`
  ).bind(chicagoDateString()).first() as any;
  const boxesToPack = Number(packRow?.n || 0);
  const eligibleBooks = await listEligibleClubBooks(e.DB);

  // Each member's next box due date, for the members table. Cycles are
  // purchase-anchored, so this is per member: the earliest box still
  // open (awaiting a pick, locked, or in fulfilment) wins; a member
  // whose next box has not been minted yet (the scheduler creates it
  // when its due date arrives) falls back to their anchored schedule.
  const OPEN_BOX_STATUSES = ["awaiting_selection", "needs_attention", "locked", "preparing"];
  const allBoxRows = await e.DB.prepare(
    "SELECT signup_id, ship_date, status FROM club_cycle_boxes ORDER BY ship_date ASC LIMIT 2000"
  ).all();
  const openBoxByMember = new Map<string, any>();
  const boxDatesByMember = new Map<string, Set<string>>();
  for (const b of (allBoxRows.results || []) as any[]) {
    const sid = String(b.signup_id);
    if (!boxDatesByMember.has(sid)) boxDatesByMember.set(sid, new Set());
    boxDatesByMember.get(sid)!.add(String(b.ship_date));
    if (OPEN_BOX_STATUSES.includes(String(b.status)) && !openBoxByMember.has(sid)) {
      openBoxByMember.set(sid, b);
    }
  }
  const todayStr = chicagoDateString();
  for (const s of signups) {
    const open = openBoxByMember.get(String(s.id));
    if (open) {
      s.next_box_due = String(open.ship_date);
      s.next_box_status = String(open.status);
    } else if (clubMemberCycleEligible(s)) {
      const dates = memberCycleWindowDates(clubAnchorDateString(s), todayStr, 2);
      const existing = boxDatesByMember.get(String(s.id)) || new Set<string>();
      const next = dates.find((d) => !existing.has(d)) || dates[dates.length - 1];
      s.next_box_due = next;
      s.next_box_status = "upcoming";
    } else {
      s.next_box_due = null;
      s.next_box_status = null;
    }
  }

  return Response.json({
    signups,
    byShelf,
    byStatus,
    total: signups.length,
    paidCount,
    paidQuarterly,
    paidAnnual,
    paidAudioCount,
    paidAudioMonthly,
    paidAudioAnnual,
    quarterlyRevenueCents,
    audioMonthlyRevenueCents,
    boxesToPack,
    boxes,
    boxByStatus,
    eligibleBooks,
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  if (!(locals as any)?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const e = env as any;
  const SITE = e.BETTER_AUTH_URL || "https://bigbrainshelf.com";
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  if (!body.box_id) {
    return Response.json({ error: "Unknown action." }, { status: 400 });
  }
  const boxId = String(body.box_id);

  if (body.action === "set_pack") {
    const pack = normalizePackState(body.pack);
    if (!pack) return Response.json({ error: "pack must be an object of line ticks" }, { status: 400 });
    const box = await getClubBox(e.DB, boxId).catch(() => null);
    if (!box) return Response.json({ error: "box not found" }, { status: 404 });
    await setClubBoxPack(e.DB, boxId, pack);
    return Response.json({ ok: true });
  }

  if (body.action === "buy_box_label_usps") {
    await ensureClubCycleTables(e.DB);
    const box = await getClubBox(e.DB, boxId);
    if (!box) return Response.json({ error: "box not found" }, { status: 404 });
    if (box.label_url) return Response.json({ error: "A label has already been bought for this box." }, { status: 400 });
    const member = await e.DB.prepare(
      "SELECT ship_name, ship_address FROM club_signups WHERE id = ?"
    ).bind(String(box.signup_id)).first() as any;
    const parsed = destinationFromStored(member?.ship_name, member?.ship_address);
    if (!parsed.ok) {
      return Response.json({ error: `This member's saved address is missing ${parsed.missing.join(", ")}. Fix the address before buying a label.` }, { status: 400 });
    }
    try {
      // One parcel: the club book's gift set plus the second book.
      const label = await buyUspsLabelForDestination(e, parsed.dest, [{ format: "giftset" }, { format: "printed" }]);
      await e.DB.prepare(
        `UPDATE club_cycle_boxes SET carrier = ?, carrier_service = ?, tracking_number = ?, label_url = ?,
           label_cost_cents = ?, shippo_shipment_id = ?, shippo_transaction_id = ?, updated_at = ? WHERE id = ?`
      ).bind(label.carrier, label.service, label.trackingNumber, label.labelUrl, label.amountCents, label.shipmentId, label.transactionId, Date.now(), boxId).run();
      const updated = await getClubBox(e.DB, boxId);
      return Response.json({ ok: true, label, box: updated });
    } catch (err: any) {
      return Response.json({ error: String(err?.message || "Label purchase failed.") }, { status: 400 });
    }
  }

  if (body.action === "box_label_quote" || body.action === "buy_box_label") {
    await ensureClubCycleTables(e.DB);
    const box = await getClubBox(e.DB, boxId);
    if (!box) return Response.json({ error: "box not found" }, { status: 404 });
    if (box.label_url) return Response.json({ error: "A label has already been bought for this box." }, { status: 400 });
    if (body.action === "box_label_quote") {
      const member = await e.DB.prepare(
        "SELECT ship_name, ship_address FROM club_signups WHERE id = ?"
      ).bind(String(box.signup_id)).first() as any;
      const parsed = destinationFromStored(member?.ship_name, member?.ship_address);
      if (!parsed.ok) {
        return Response.json({ error: `This member's saved address is missing ${parsed.missing.join(", ")}. Fix the address before buying a label.` }, { status: 400 });
      }
      try {
        // One parcel: the club book's gift set plus the second book.
        const quote = await getDestinationLabelQuote(e, parsed.dest, [{ format: "giftset" }, { format: "printed" }]);
        return Response.json({ ok: true, quote });
      } catch (err: any) {
        return Response.json({ error: String(err?.message || "Could not get rates.") }, { status: 400 });
      }
    }
    try {
      const label = await buyDestinationLabel(e, {
        shipmentId: String(body.shipment_id || ""),
        rateId: String(body.rate_id || ""),
      });
      await e.DB.prepare(
        `UPDATE club_cycle_boxes SET carrier = ?, carrier_service = ?, tracking_number = ?, label_url = ?,
           label_cost_cents = ?, shippo_shipment_id = ?, shippo_transaction_id = ?, updated_at = ? WHERE id = ?`
      ).bind(label.carrier, label.service, label.trackingNumber, label.labelUrl, label.amountCents, label.shipmentId, label.transactionId, Date.now(), boxId).run();
      const updated = await getClubBox(e.DB, boxId);
      return Response.json({ ok: true, label, box: updated });
    } catch (err: any) {
      return Response.json({ error: String(err?.message || "Label purchase failed.") }, { status: 400 });
    }
  }

  if (body.action === "schedule_pickup") {
    await ensureClubCycleTables(e.DB);
    const box = await getClubBox(e.DB, boxId);
    if (!box) return Response.json({ error: "box not found" }, { status: 404 });
    if (!box.label_url || !box.shippo_transaction_id) {
      return Response.json({ error: "Buy the shipping label first, then request the pickup." }, { status: 400 });
    }
    const state = pickupStateFor(box as any);
    if (!state.eligible) {
      return Response.json({ error: "Shippo pickups cover USPS Priority-class and DHL Express labels only. This label is pack and drop off." }, { status: 400 });
    }
    if (box.pickup_confirmation) {
      return Response.json({ ok: true, pickup: { confirmation: String(box.pickup_confirmation), windowLabel: String(box.pickup_window || "") } });
    }
    try {
      const r = await requestPickup(e, { carrier: String(box.carrier || ""), transactionId: String(box.shippo_transaction_id) });
      await e.DB.prepare(
        "UPDATE club_cycle_boxes SET pickup_confirmation = ?, pickup_window = ?, pickup_scheduled_at = ?, updated_at = ? WHERE id = ?"
      ).bind(r.confirmation, r.windowLabel, Date.now(), Date.now(), boxId).run();
      return Response.json({ ok: true, pickup: { confirmation: r.confirmation, windowLabel: r.windowLabel } });
    } catch (err: any) {
      return Response.json({ error: String(err?.message || "Could not schedule the pickup.") }, { status: 400 });
    }
  }

  if (body.action !== "update_box") {
    return Response.json({ error: "Unknown action." }, { status: 400 });
  }
  // Ship gate (admin redesign S4): a box ships only with a purchased
  // label and a fully ticked pack checklist, mirroring the
  // store-order gate in /api/admin/orders. (The old extra "label
  // printed" tick went away in the 2026-11-05 fulfillment cleanup:
  // buying the label is the step, printing it is not a checklist
  // item of its own.)
  if (body.status === "shipped") {
    const box = await getClubBox(e.DB, boxId).catch(() => null);
    if (!box) return Response.json({ error: "box not found" }, { status: 404 });
    if (!(body.label_url || box.label_url)) {
      return Response.json({ error: "Buy the shipping label first. A box cannot ship without a label." }, { status: 400 });
    }
    if (!boxContentsComplete(box)) {
      return Response.json({ error: "Pick the books for this box first." }, { status: 400 });
    }
    const slotSlugs = [
      String(box.resolved_book_slug || box.selected_book_slug || ""),
      String(box.second_resolved_book_slug || box.second_selected_book_slug || ""),
    ].filter(Boolean);
    const books = await loadBooksByAnySlug(e.DB, slotSlugs, "slug, title, cover_key, public_slug").catch(() => new Map());
    const progress = packProgress(packLinesForBox(box, books as Map<string, any>), parsePackState((box as any).pack_json));
    if (!progress.complete) {
      return Response.json({ error: `Pack the box first: ${progress.done} of ${progress.total} items are ticked.` }, { status: 400 });
    }
  }
  const result = await updateClubBoxByAdmin(e.DB, {
    boxId: String(body.box_id),
    bookSlug: body.book_slug ? String(body.book_slug) : null,
    slot: body.slot === 2 || body.slot === "2" ? 2 : undefined,
    clear: body.clear === true,
    status: body.status ? String(body.status) : null,
    carrier: body.carrier ? String(body.carrier) : null,
    trackingNumber: body.tracking_number ? String(body.tracking_number) : null,
    labelUrl: body.label_url ? String(body.label_url) : null,
  });
  if (!result.ok) return Response.json({ error: result.error || "Could not update the box." }, { status: 400 });
  // Marking a box shipped notifies the member with the tracking details
  // (idempotent per box through the outbox dedupe key).
  if (result.box?.status === "shipped") {
    try {
      await enqueueClubCycleEmail(e.DB, SITE, result.box, CLUB_BOX_SHIPPED_KIND);
      await flushOutbox(e.DB, e, 10, SITE);
    } catch (err: any) {
      console.error("club shipped email failed", err?.message || err);
    }
  }
  return Response.json({ ok: true, box: result.box });
};
