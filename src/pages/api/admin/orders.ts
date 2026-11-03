import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { setPhysicalStatus, orderItemLabels, orderPickList, shortOrderId, ensureOrderPackColumns, parsePackState, normalizePackState, setOrderPack } from "../../../lib/orders";
import { flushOutbox } from "../../../lib/email";
import { shippoStatus, ensureOrderLabelColumns, ensureOrderQuoteColumns, ensureOrderTrackingColumns, ensureOrderPickupColumns, getLabelQuote, buyLabelForOrder, schedulePickupForOrder, pickupStateFor } from "../../../lib/shippo";
import { packLinesForGroups, packProgress, getPackingQueue } from "../../../lib/packing";
import { downloadCountsForOrder, resetDownloadsForOrder, DOWNLOAD_LIMIT } from "../../../lib/download-guard";
import { markSeen } from "../../../lib/seen";

// Admin order operations. Gated by the middleware's admin session cookie,
// with the locals.user check as defense in depth (same pattern as
// /api/admin-download).
//
// GET  -> recent orders + outbox counts
// POST { action: "set_physical_status", order_id, status }
//      advances a printed pre-order and enqueues its one update email,
//      then attempts to flush the outbox.
// POST { action: "retry_emails" }
//      attempts every pending email (the manual retry path for the outbox;
//      automatic flushes also happen on each webhook delivery).
// POST { action: "label_quote", order_id }
//      Shippo rates-only preview: creates the shipment, picks the
//      rate by the 2-day fulfillment rule (chooseRate) and returns
//      it for the admin to confirm. Never purchases anything.
// POST { action: "buy_label", order_id, shipment_id?, rate_id? }
//      buys the quoted label (or a fresh rate picked by the 2-day
//      fulfillment rule) and stores it on the order. It does NOT move
//      the fulfillment stage (owner, 2026-10-29): the operator marks
//      packed and shipped as physical reality happens, and the Mark
//      shipped step fires the shipped email with the stored tracking.
// POST { action: "reset_downloads", order_id }
//      clears the order's per-file download counts (support's reset
//      for the 5-downloads-per-purchase budget in lib/download-guard).
//      The detail GET reports the counts as download_counts, with
//      book titles resolved, plus the budget as download_limit.
// POST { action: "set_pack", order_id, pack }
//      persists the pack checklist ticks (lib/packing line keys) on
//      the order row, so the pack step survives reloads.
// POST { action: "schedule_pickup", order_id }
//      schedules a carrier pickup for the order's purchased label via
//      Shippo (USPS Priority-class / DHL Express labels only; see
//      pickupEligibleFor in lib/shippo.ts).
//
// The detail GET also carries the order's pack checklist (pack_lines
// + pack_state + pack_progress) and pickup state (pickup), and the
// list GET carries the packing shelf queue (packing) for the orders
// page and dashboard. Mark shipped (set_physical_status -> shipped)
// is gated HERE, at the API layer: the order must have a purchased
// label and a fully ticked pack checklist (label confirmation
// included). The lib transition itself stays ungated so the tracking
// poll and tests keep their plain semantics.

function guard(locals: any) {
  return !(locals as any)?.user;
}

export const GET: APIRoute = async ({ locals, url }) => {
  if (guard(locals)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const e = env as any;
  await ensureOrderLabelColumns(e.DB).catch(() => {});
  await ensureOrderQuoteColumns(e.DB).catch(() => {});
  await ensureOrderTrackingColumns(e.DB).catch(() => {});
  await ensureOrderPackColumns(e.DB).catch(() => {});
  await ensureOrderPickupColumns(e.DB).catch(() => {});

  // Single-order detail for /admin/orders/[id]: the full row, its
  // resolved item titles, and that order's email history from the
  // outbox (kind, status, attempts, timestamps — never bodies).
  const detailId = url.searchParams.get("order_id");
  if (detailId) {
    const order = await e.DB.prepare(
      "SELECT id, email, book_slugs, items, amount, currency, status, physical_status, stripe_session_id, created_at, ship_name, ship_address, shipping_cents, quoted_carrier, quoted_service, carrier, carrier_service, tracking_number, label_url, label_cost_cents, shippo_transaction_id, pack_json, pickup_confirmation, pickup_window, pickup_scheduled_at, tracking_status FROM orders WHERE id = ?"
    ).bind(detailId).first();
    if (!order) return Response.json({ error: "order not found" }, { status: 404 });
    // Opening an order is what clears it from the sidebar badge
    // (a still-pending order keeps counting on the state rule).
    await markSeen(e.DB, "orders", detailId);
    const labels = await orderItemLabels(e.DB, [order]).catch(() => new Map());
    (order as any).items_display = labels.get((order as any).id) || [];
    const pick = await orderPickList(e.DB, [order]).catch(() => new Map());
    (order as any).items_detail = pick.get((order as any).id) || [];
    // Pack checklist + pickup state for the fulfillment view.
    const packState = parsePackState((order as any).pack_json);
    const packLines = packLinesForGroups(((order as any).items_detail || []) as any[]);
    (order as any).pack_lines = packLines;
    (order as any).pack_state = packState;
    (order as any).pack_progress = packProgress(packLines, packState);
    (order as any).pickup = pickupStateFor(order as any);
    (order as any).short_id = shortOrderId(String((order as any).id));
    let emails: any[] = [];
    try {
      const mail = await e.DB.prepare(
        "SELECT kind, to_email, subject, status, attempts, created_at, sent_at, last_error FROM email_outbox WHERE order_id = ? ORDER BY created_at ASC LIMIT 100"
      ).bind(detailId).all();
      emails = (mail.results || []) as any[];
    } catch { /* outbox columns still migrating; history is best-effort */ }
    // Download budget state for this order (lib/download-guard): how
    // many times each purchased file has been downloaded, with the
    // book named by title, never by internal slug.
    let download_counts: any[] = [];
    try {
      const rows = await downloadCountsForOrder(e.DB, detailId);
      if (rows.length) {
        const slugs = [...new Set(rows.map((r) => r.slug))];
        const titleRows = await e.DB.prepare(
          `SELECT slug, title FROM books WHERE slug IN (${slugs.map(() => "?").join(",")})`
        ).bind(...slugs).all();
        const titles = new Map(((titleRows.results || []) as any[]).map((b) => [String(b.slug), String(b.title || b.slug)]));
        download_counts = rows.map((r) => ({
          slug: r.slug,
          title: titles.get(r.slug) || r.slug,
          file_kind: r.file_kind,
          count: r.download_count,
          limit: DOWNLOAD_LIMIT,
        }));
      }
    } catch { /* counts table still migrating; the section is best-effort */ }
    return Response.json({ order, emails, shippo: shippoStatus(e), download_counts, download_limit: DOWNLOAD_LIMIT });
  }

  const outbox = await e.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM email_outbox GROUP BY status"
  ).all();
  const counts: Record<string, number> = {};
  for (const r of (outbox.results || []) as any[]) counts[r.status] = r.n;
  // Stat cards and tab counts for the orders page, computed over the
  // whole table (not just the list window): printed work waiting,
  // recent order volume, and completed-only revenue for the last 30
  // days. Tab classification (owner, 2026-10-29): "tofulfill" is paid
  // work still in the building (physical_status received, in print,
  // or packed); "fulfilled" is printed orders shipped or delivered PLUS
  // completed digital/audio-only orders, which fulfill automatically
  // on payment (they are exactly the complete orders whose
  // physical_status IS NULL, because that column is only set when a
  // completed order contains printed items). Pending orders are not
  // work yet and live under "all" only.
  const nowSec = Math.floor(Date.now() / 1000);
  const statRow = await e.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM orders WHERE status = 'complete' AND physical_status IN ('preorder_received', 'in_print', 'packed')) AS to_fulfill,
       (SELECT COUNT(*) FROM orders WHERE status = 'complete' AND (physical_status IN ('shipped', 'delivered') OR physical_status IS NULL)) AS fulfilled,
       (SELECT COUNT(*) FROM orders WHERE created_at >= ?) AS orders_7d,
       (SELECT COUNT(*) FROM orders) AS orders_total,
       (SELECT COALESCE(SUM(amount), 0) FROM orders WHERE status = 'complete' AND created_at >= ?) AS revenue_30d`
  ).bind(nowSec - 7 * 86400, nowSec - 30 * 86400).first() as any;
  const tabCounts = {
    toFulfill: Number(statRow?.to_fulfill || 0),
    fulfilled: Number(statRow?.fulfilled || 0),
    all: Number(statRow?.orders_total || 0),
  };
  // Filter tabs + server pagination (25 per page) so the list stays
  // fast at volume. No tab param lands on the default tab: To fulfill
  // when there is work waiting, otherwise All.
  const TAB_WHERE: Record<string, string> = {
    tofulfill: "status = 'complete' AND physical_status IN ('preorder_received', 'in_print', 'packed')",
    fulfilled: "status = 'complete' AND (physical_status IN ('shipped', 'delivered') OR physical_status IS NULL)",
    all: "1 = 1",
  };
  const rawTab = String(url.searchParams.get("tab") || "");
  const tab = TAB_WHERE[rawTab] ? rawTab : tabCounts.toFulfill > 0 ? "tofulfill" : "all";
  const total = tab === "tofulfill" ? tabCounts.toFulfill : tab === "fulfilled" ? tabCounts.fulfilled : tabCounts.all;
  const PAGE_SIZE = 25;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(url.searchParams.get("page") || 1) || 1), pages);
  const orders = await e.DB.prepare(
    `SELECT id, email, book_slugs, items, amount, currency, status, physical_status, stripe_session_id, created_at, ship_name, ship_address, shipping_cents, quoted_carrier, quoted_service, carrier, carrier_service, tracking_number, label_url, label_cost_cents FROM orders WHERE ${TAB_WHERE[tab]} ORDER BY created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`
  ).all();
  // Items are displayed by book TITLE with a format label, resolved
  // here against the books table (the same pattern the confirmation
  // email uses). The internal slug never reaches the page as a label.
  const orderRows = (orders.results || []) as any[];
  const labels = await orderItemLabels(e.DB, orderRows).catch(() => new Map());
  const picks = await orderPickList(e.DB, orderRows).catch(() => new Map());
  for (const o of orderRows) {
    o.items_display = labels.get(o.id) || [];
    o.items_pick = picks.get(o.id) || [];
    o.short_id = shortOrderId(String(o.id));
  }
  // The packing shelf ("What do we pack and ship?"): store orders and
  // club boxes awaiting fulfillment, for the section above the tabs.
  const packing = await getPackingQueue(e.DB).catch(() => []);
  return Response.json({
    orders: orderRows,
    packing,
    outbox: counts,
    tab,
    page,
    pageSize: PAGE_SIZE,
    total,
    pages,
    tabCounts,
    stats: {
      toFulfill: Number(statRow?.to_fulfill || 0),
      orders7d: Number(statRow?.orders_7d || 0),
      ordersTotal: Number(statRow?.orders_total || 0),
      revenue30dCents: Number(statRow?.revenue_30d || 0),
    },
    // Shippo setup state for the orders page: configured = key present,
    // ready = nothing missing at all, missing = the exact worker vars
    // still needed (rendered as a checklist on the page).
    shippo: shippoStatus(e),
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  if (guard(locals)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const e = env as any;
  const SITE = e.BETTER_AUTH_URL || "https://bigbrainshelf.com";
  const body = await request.json().catch(() => ({}));
  const action = String(body?.action || "");

  if (action === "set_physical_status") {
    const orderId = String(body?.order_id || "");
    const status = String(body?.status || "");
    // Ship gate (admin redesign S4): an order ships only with a
    // purchased label and a fully ticked pack checklist, label
    // confirmation included. Enforced here so every caller (detail
    // page, list advance, kebab) gets the same plain refusal.
    if (status === "shipped") {
      await ensureOrderPackColumns(e.DB).catch(() => {});
      const row = await e.DB.prepare("SELECT id, items, book_slugs, label_url, pack_json FROM orders WHERE id = ?")
        .bind(orderId).first() as any;
      if (!row) return Response.json({ error: "order not found" }, { status: 404 });
      if (!row.label_url) {
        return Response.json({ error: "Buy the shipping label first. An order cannot ship without a label." }, { status: 400 });
      }
      const pick = await orderPickList(e.DB, [row]).catch(() => new Map());
      const lines = packLinesForGroups(pick.get(row.id) || []);
      const progress = packProgress(lines, parsePackState(row.pack_json));
      if (!progress.labelPrinted) {
        return Response.json({ error: "Tick \"Shipping label printed\" in the pack checklist first: the label has to be on the box before it ships." }, { status: 400 });
      }
      if (!progress.complete) {
        return Response.json({ error: `Pack the box first: ${progress.done} of ${progress.total} items are ticked.` }, { status: 400 });
      }
    }
    const result = await setPhysicalStatus(e.DB, SITE, orderId, status);
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    const flush = await flushOutbox(e.DB, e, 10, SITE).catch(() => null);
    return Response.json({ ok: true, order: result.order, flush });
  }
  if (action === "set_pack") {
    const orderId = String(body?.order_id || "");
    if (!orderId) return Response.json({ error: "order_id required" }, { status: 400 });
    const pack = normalizePackState(body?.pack);
    if (!pack) return Response.json({ error: "pack must be an object of line ticks" }, { status: 400 });
    const exists = await e.DB.prepare("SELECT id FROM orders WHERE id = ?").bind(orderId).first();
    if (!exists) return Response.json({ error: "order not found" }, { status: 404 });
    await setOrderPack(e.DB, orderId, pack);
    return Response.json({ ok: true });
  }
  if (action === "schedule_pickup") {
    const orderId = String(body?.order_id || "");
    await ensureOrderPickupColumns(e.DB).catch(() => {});
    const order = await e.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
    if (!order) return Response.json({ error: "order not found" }, { status: 404 });
    try {
      const pickup = await schedulePickupForOrder(e.DB, e, order);
      return Response.json({ ok: true, pickup });
    } catch (err: any) {
      return Response.json({ error: String(err?.message || "Could not schedule the pickup.") }, { status: 400 });
    }
  }
  if (action === "retry_emails") {
    const flush = await flushOutbox(e.DB, e, 50, SITE);
    return Response.json({ ok: true, flush });
  }
  if (action === "reset_downloads") {
    const orderId = String(body?.order_id || "");
    if (!orderId) return Response.json({ error: "order_id required" }, { status: 400 });
    await resetDownloadsForOrder(e.DB, orderId);
    return Response.json({ ok: true });
  }
  if (action === "label_quote") {
    const order = await e.DB.prepare("SELECT * FROM orders WHERE id = ?")
      .bind(String(body?.order_id || "")).first();
    if (!order) return Response.json({ error: "order not found" }, { status: 404 });
    try {
      const quote = await getLabelQuote(e.DB, e, order);
      return Response.json({ ok: true, quote });
    } catch (err: any) {
      return Response.json({ error: String(err?.message || "Could not get rates.") }, { status: 400 });
    }
  }
  if (action === "buy_label") {
    // Shippo label purchase. Fully gated on configuration;
    // buyLabelForOrder reports its own blockers (no key, no origin, no
    // stored address, no rates, provider errors) as the error message,
    // and a failed purchase leaves the order exactly as it was.
    const order = await e.DB.prepare("SELECT * FROM orders WHERE id = ?")
      .bind(String(body?.order_id || "")).first();
    if (!order) return Response.json({ error: "order not found" }, { status: 404 });
    try {
      const label = await buyLabelForOrder(e.DB, e, order, {
        shipmentId: body?.shipment_id ? String(body.shipment_id) : undefined,
        rateId: body?.rate_id ? String(body.rate_id) : undefined,
      });
      // The purchase stores the label, carrier, service, tracking
      // number and cost on the order and leaves physical_status
      // exactly where it is (owner, 2026-10-29). Packing and shipping
      // are separate operator actions; the shipped email fires at
      // Mark shipped and picks up the stored tracking from the row
      // setPhysicalStatus re-reads at that moment.
      return Response.json({ ok: true, label });
    } catch (err: any) {
      // If the failed purchase was the rate quoted at checkout, that
      // rate has evidently expired: clear it so the next "Get shipping
      // rate" falls back to a fresh quote instead of offering the dead
      // rate again. The buyer is never re-charged either way; the
      // difference shows on the order.
      if (body?.rate_id && order.shippo_rate_id && String(body.rate_id) === String(order.shippo_rate_id)) {
        await e.DB.prepare("UPDATE orders SET shippo_rate_id = NULL WHERE id = ?")
          .bind(String(order.id)).run().catch(() => {});
      }
      return Response.json({ error: String(err?.message || "Label purchase failed.") }, { status: 400 });
    }
  }
  return Response.json({ error: "unknown action" }, { status: 400 });
};
