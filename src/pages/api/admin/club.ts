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
  listEligibleClubBooks,
  updateClubBoxByAdmin,
} from "../../../lib/club-cycles";
import { clubAnchorDateString, memberCycleWindowDates } from "../../../lib/club-cycle-dates";
import { chicagoDateString } from "../../../lib/offers";
import { enqueueClubCycleEmail, CLUB_BOX_SHIPPED_KIND } from "../../../lib/club-emails";
import { markSeen } from "../../../lib/seen";
import { flushOutbox } from "../../../lib/email";

// Admin Book Club queue. Gated by the middleware's admin session cookie,
// with the locals.user check as defense in depth (same pattern as
// /api/admin/orders).
//
// GET -> all club signups (newest first) + counts per shelf and status,
//        plus Book Club V2 cycle boxes (upcoming and recent), per-status
//        box counts, and the eligible book list for override controls.
// POST { action: "update_box", box_id, book_slug?, status?, carrier?,
//        tracking_number?, label_url? } -> resolve a box to a book,
//        change its fulfilment status, or attach tracking. Marking a box
//        shipped enqueues the member's shipped email with tracking.

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
    // Ships-to snapshot: the most recent physical order's address,
    // lifted out so the drawer shows it once instead of per order.
    let shipping: any = null;
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
  if (body.action !== "update_box" || !body.box_id) {
    return Response.json({ error: "Unknown action." }, { status: 400 });
  }
  const result = await updateClubBoxByAdmin(e.DB, {
    boxId: String(body.box_id),
    bookSlug: body.book_slug ? String(body.book_slug) : null,
    slot: body.slot === 2 || body.slot === "2" ? 2 : undefined,
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
