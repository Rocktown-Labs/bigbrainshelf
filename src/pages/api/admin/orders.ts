import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { setPhysicalStatus, orderItemLabels, orderPickList, shortOrderId, ensureOrderPackColumns, parsePackState, normalizePackState, setOrderPack, ensureOrderManualColumns, ensureOrderPricingColumns, createManualOrder, listManualOrderCatalog } from "../../../lib/orders";
import { flushOutbox } from "../../../lib/email";
import { shippoStatus, ensureOrderLabelColumns, ensureOrderQuoteColumns, ensureOrderTrackingColumns, ensureOrderPickupColumns, getLabelQuote, buyLabelForOrder, schedulePickupForOrder, pickupStateFor } from "../../../lib/shippo";
import { packLinesForGroups, packProgress, getPackingQueue, getCompletedParcels } from "../../../lib/packing";
import { downloadCountsForOrder, resetDownloadsForOrder, DOWNLOAD_LIMIT } from "../../../lib/download-guard";
import { markSeen } from "../../../lib/seen";
import { listSerialsForOrder, mintOrderPrintSerials, serialLabel } from "../../../lib/serials";
import {
  buildJobsForOrder,
  cancelPrintJobById,
  getPrintJobsForOrder,
  submitPrintJob,
  syncPrintJobs,
} from "../../../lib/print-fulfillment";
import { luluConfigured, luluEnvName } from "../../../lib/lulu";
import {
  orderKindOf,
  stageForGroup,
  headlineStage,
  matchesSavedFilter,
  type StageJobInput,
} from "../../../lib/order-stages";
import { MEDIA_PUBLIC } from "../../../lib/derivatives";

// ---- Orders admin redo helpers (prototype v3, 2026-11-10) --------
// Per-line stages are derived server-side from the rows of record
// (lib/order-stages) so the list, the detail page, and the tests all
// read the same truth. Group slugs are resolved server-side only:
// the pick-list payload deliberately carries no internal slug, and
// none is added here either; stages and tiles are attached to the
// group objects instead.

// Print jobs for many orders in two queries (list path).
async function bulkStageJobs(db: any, orderIds: string[]): Promise<Map<string, StageJobInput[]>> {
  const out = new Map<string, StageJobInput[]>();
  if (!orderIds.length) return out;
  try {
    const ph = orderIds.map(() => "?").join(",");
    const jobs = await db.prepare(
      `SELECT id, order_id, status, lulu_status, has_partial, created_at FROM print_jobs WHERE order_id IN (${ph})`
    ).bind(...orderIds).all();
    const jobRows = (jobs.results || []) as any[];
    if (!jobRows.length) return out;
    const items = await db.prepare(
      `SELECT job_id, slug, kind, status FROM print_job_items WHERE job_id IN (${jobRows.map(() => "?").join(",")})`
    ).bind(...jobRows.map((j) => j.id)).all();
    const itemsByJob = new Map<string, any[]>();
    for (const it of (items.results || []) as any[]) {
      const arr = itemsByJob.get(String(it.job_id)) || [];
      arr.push({ slug: String(it.slug), kind: String(it.kind), status: it.status });
      itemsByJob.set(String(it.job_id), arr);
    }
    for (const j of jobRows) {
      const sj: StageJobInput = {
        id: String(j.id),
        status: String(j.status),
        luluStatus: j.lulu_status,
        hasPartial: !!Number(j.has_partial || 0),
        createdAt: Number(j.created_at || 0),
        items: itemsByJob.get(String(j.id)) || [],
      };
      const arr = out.get(String(j.order_id)) || [];
      arr.push(sj);
      out.set(String(j.order_id), arr);
    }
  } catch { /* print tables still landing; stages fall back to home/digital */ }
  return out;
}

// Align each pick group with the slug of the raw order line it came
// from: title match against the books table first (exact, since the
// group title IS the book's public title), positional order second.
// `titles` maps slug -> book title, preloaded by the caller.
function resolveGroupSlugs(order: any, groups: any[], titles: Map<string, string>): (string | null)[] {
  const rawSlugs: string[] = [];
  try {
    const parsed = JSON.parse(order.items || "[]");
    if (Array.isArray(parsed)) for (const x of parsed) if (x && x.slug) rawSlugs.push(String(x.slug));
  } catch { /* fall through */ }
  if (!rawSlugs.length) {
    try {
      const parsed = JSON.parse(order.book_slugs || "[]");
      if (Array.isArray(parsed)) for (const s of parsed) rawSlugs.push(String(s));
    } catch { /* none */ }
  }
  const used = new Set<number>();
  return groups.map((g, gi) => {
    let idx = rawSlugs.findIndex((s, i) => !used.has(i) && titles.get(s) === g.title);
    if (idx < 0) idx = rawSlugs.findIndex((_, i) => !used.has(i) && i === gi);
    if (idx < 0) idx = rawSlugs.findIndex((_, i) => !used.has(i));
    if (idx < 0) return null;
    used.add(idx);
    return rawSlugs[idx];
  });
}

async function loadBookTitles(db: any, slugs: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const uniq = [...new Set(slugs)];
  if (!uniq.length) return titles;
  try {
    const rows = await db.prepare(
      `SELECT slug, title FROM books WHERE slug IN (${uniq.map(() => "?").join(",")})`
    ).bind(...uniq).all();
    for (const r of (rows.results || []) as any[]) titles.set(String(r.slug), String(r.title || ""));
  } catch { /* titles unavailable; positional fallback still works */ }
  return titles;
}

function stageJobsFromPrintJobs(printJobs: any[]): StageJobInput[] {
  return (printJobs || []).map((j) => ({
    id: String(j.id),
    status: String(j.status),
    luluStatus: j.luluStatus ?? j.lulu_status ?? null,
    hasPartial: !!j.hasPartial,
    createdAt: Number(j.createdAt || 0),
    items: (j.items || []).map((it: any) => ({ slug: String(it.slug), kind: String(it.kind), status: it.status ?? null })),
  }));
}

// Deliverable tiles for a digital/audio group (order detail). Tile
// labels are BARE FILE TYPES (CG, 2026-11-10): pdf / pdf / ebook /
// audio, with the download count as a small corner badge, never a
// descriptive caption. A physical group gets one cover tile labeled
// "printed" (a gift set gets two: story + coloring, both "printed").
function tilesForGroup(
  group: any,
  book: any | undefined,
  downloadsByKind: Record<string, number>
): { label: string; img: string | null; glyph: string; count: number | null }[] {
  const badge = (kinds: string[]) => {
    let n: number | null = null;
    for (const k of kinds) if (downloadsByKind[k] != null) n = (n ?? 0) + downloadsByKind[k];
    return n;
  };
  if (group.format === "printed") {
    return [{ label: "printed", img: group.cover || null, glyph: "▤", count: null }];
  }
  if (group.format === "giftset") {
    return [
      { label: "printed", img: group.cover || null, glyph: "▤", count: null },
      { label: "printed", img: group.cover || null, glyph: "▦", count: null },
    ];
  }
  if (group.format === "audio") {
    return [{ label: "audio", img: group.cover || null, glyph: "♪", count: badge(["audiobook"]) }];
  }
  // digital bundle
  const tiles: { label: string; img: string | null; glyph: string; count: number | null }[] = [
    { label: "pdf", img: group.cover || null, glyph: "▤", count: badge(["picture", "color"]) },
  ];
  if (book?.coloring_book_key) {
    tiles.push({
      label: "pdf",
      img: book?._lineFirstPage || null,
      glyph: "▦",
      count: badge(["coloring"]),
    });
  }
  if (book?.epub_key) tiles.push({ label: "ebook", img: null, glyph: "▤", count: badge(["epub"]) });
  if (book?.audiobook_key) tiles.push({ label: "audio", img: null, glyph: "♪", count: badge(["audiobook"]) });
  return tiles;
}

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
//      buys the quoted label when rate ids are given; with none it
//      takes the one-click path and buys the USPS rate outright
//      (CG, 2026-11-05: the buyer already paid shipping at
//      checkout). Stores the label on the order. It does NOT move
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
// GET ?catalog=1 -> the manual-order form's catalog: sellable books by
//      public title with default per-format prices.
// POST { action: "create_manual_order", name, email, address, lines,
//        shipping_cents, note }
//      creates a real order by hand (lib/orders createManualOrder):
//      no Stripe objects, no emails at creation; fulfillment runs
//      through the same actions as a checkout order afterwards.
// POST { action: "create_print_job", order_id }
//      builds the order's Lulu print job (lib/print-fulfillment) and
//      submits it immediately. The detail GET carries the jobs as
//      print_jobs and the lane state as lulu { configured, env }.
// POST { action: "refresh_print_job", order_id }
//      re-syncs the order's submitted jobs from Lulu (statuses,
//      per-item tracking, derived physical_status).
// POST { action: "cancel_print_job", order_id, job_id }
//      cancels one of the order's print jobs at Lulu (possible while
//      UNPAID or inside the production delay) and marks it locally.
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
  await ensureOrderManualColumns(e.DB).catch(() => {});
  await ensureOrderPricingColumns(e.DB).catch(() => {});

  // The manual-order form's catalog (public titles + default prices).
  if (url.searchParams.get("catalog")) {
    const catalog = await listManualOrderCatalog(e.DB).catch(() => []);
    return Response.json({ catalog });
  }

  // Single-order detail for /admin/orders/[id]: the full row, its
  // resolved item titles, and that order's email history from the
  // outbox (kind, status, attempts, timestamps — never bodies).
  const detailId = url.searchParams.get("order_id");
  if (detailId) {
    const order = await e.DB.prepare(
      "SELECT id, email, book_slugs, items, amount, currency, status, physical_status, stripe_session_id, created_at, ship_name, ship_address, shipping_cents, quoted_carrier, quoted_service, carrier, carrier_service, tracking_number, label_url, label_cost_cents, shippo_transaction_id, shippo_rate_id, shippo_shipment_id, source, admin_note, pack_json, pickup_confirmation, pickup_window, pickup_scheduled_at, tracking_status, pricing_mode, pricing_detail FROM orders WHERE id = ?"
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
    // Copy serials (CG, 2026-11-05): direct-sold copies are
    // numbered. Print and gift set units mint when the order
    // reaches the pack stage, so the operator sees each copy's
    // number while packing; digital copies mint at download. All
    // of the order's serials ride the payload with public titles.
    (order as any).serials = [];
    try {
      const stage = String((order as any).physical_status || "");
      if ((order as any).status === "complete" && ["packed", "shipped", "delivered"].includes(stage)) {
        await mintOrderPrintSerials(e.DB, order as any);
      }
      const serials = await listSerialsForOrder(e.DB, detailId);
      if (serials.length) {
        const slugs = [...new Set(serials.map((s) => s.bookSlug))];
        const titleRows = await e.DB.prepare(
          `SELECT slug, title FROM books WHERE slug IN (${slugs.map(() => "?").join(",")})`
        ).bind(...slugs).all();
        const titles = new Map(((titleRows.results || []) as any[]).map((r) => [String(r.slug), String(r.title)]));
        (order as any).serials = serials.map((s) => ({
          label: serialLabel(s.volume, s.serial),
          code: s.code,
          title: titles.get(s.bookSlug) || s.bookSlug,
          format: s.format,
        }));
      }
    } catch { /* serials are a display extra, never a blocker */ }
    (order as any).short_id = shortOrderId(String((order as any).id));
    let emails: any[] = [];
    try {
      const mail = await e.DB.prepare(
        "SELECT kind, to_email, subject, status, attempts, created_at, sent_at, last_error FROM email_outbox WHERE order_id = ? ORDER BY created_at ASC LIMIT 100"
      ).bind(detailId).all();
      emails = (mail.results || []) as any[];
    } catch { /* outbox columns still migrating; history is best-effort */ }
    // Lulu print jobs for this order (jobs + items + shipments),
    // plus the lane state the detail page uses to show or hide the
    // submit action. Best-effort: the section renders empty without.
    let print_jobs: any[] = [];
    try {
      print_jobs = await getPrintJobsForOrder(e.DB, detailId);
    } catch { /* print tables still landing; the section is additive */ }
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
    // Orders admin redo: per-line stages + deliverable tiles,
    // derived from the rows of record (lib/order-stages). The status
    // prose the old table cell carried lives here now, on the order
    // page: each line's stage note rides its group.
    let kind = "digital";
    let headline_stage: any = null;
    try {
      const groups = ((order as any).items_detail || []) as any[];
      const stageJobs = stageJobsFromPrintJobs(print_jobs);
      const rawSlugs: string[] = [];
      for (const src of [(order as any).items, (order as any).book_slugs]) {
        try {
          const parsed = JSON.parse(src || "[]");
          if (Array.isArray(parsed)) for (const x of parsed) {
            if (typeof x === "string") rawSlugs.push(x);
            else if (x && x.slug) rawSlugs.push(String(x.slug));
          }
        } catch { /* next source */ }
        if (rawSlugs.length) break;
      }
      const slugs = resolveGroupSlugs(order, groups, await loadBookTitles(e.DB, rawSlugs));
      const orderInput = {
        status: String((order as any).status || ""),
        physicalStatus: (order as any).physical_status || null,
        createdAt: Number((order as any).created_at || 0),
        source: (order as any).source || null,
      };
      const bookRows = new Map<string, any>();
      const wanted = [...new Set(slugs.filter(Boolean))] as string[];
      if (wanted.length) {
        const brows = await e.DB.prepare(
          `SELECT slug, coloring_book_key, epub_key, audiobook_key FROM books WHERE slug IN (${wanted.map(() => "?").join(",")})`
        ).bind(...wanted).all();
        for (const b of (brows.results || []) as any[]) {
          bookRows.set(String(b.slug), {
            ...b,
            _lineFirstPage: MEDIA_PUBLIC + `books/${b.slug}/images/S1-page-0.jpg`,
          });
        }
      }
      const dlBySlugKind = new Map<string, Record<string, number>>();
      for (const dc of download_counts as any[]) {
        const rec = dlBySlugKind.get(dc.slug) || {};
        rec[dc.file_kind] = dc.count;
        dlBySlugKind.set(dc.slug, rec);
      }
      groups.forEach((g, i) => {
        const slug = slugs[i];
        g.stage = stageForGroup({ format: g.format, slug }, orderInput, stageJobs);
        const book = slug ? bookRows.get(slug) : undefined;
        g.tiles = tilesForGroup(g, book, slug ? dlBySlugKind.get(slug) || {} : {});
      });
      kind = orderKindOf(groups.map((g) => ({ format: g.format })));
      headline_stage = headlineStage(groups.map((g) => g.stage));
    } catch { /* stages are additive; the classic payload still renders */ }
    return Response.json({
      order,
      emails,
      shippo: shippoStatus(e),
      download_counts,
      download_limit: DOWNLOAD_LIMIT,
      print_jobs,
      kind,
      headline_stage,
      lulu: { configured: luluConfigured(e), env: luluEnvName(e) },
    });
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
       (SELECT COALESCE(SUM(amount), 0) FROM orders WHERE status = 'complete' AND created_at >= ? AND COALESCE(pricing_mode, '') != 'admin_cost') AS revenue_30d`
  ).bind(nowSec - 7 * 86400, nowSec - 30 * 86400).first() as any;
  const tabCounts = {
    toFulfill: Number(statRow?.to_fulfill || 0),
    fulfilled: Number(statRow?.fulfilled || 0),
    all: Number(statRow?.orders_total || 0),
  };
  // ---- Orders admin redo (prototype v3): the data-table list ----
  // Active when any redo filter param rides along (kind / stage /
  // saved / q / per_page). Derivation happens server-side over a
  // bounded candidate window (newest 1000 matching the SQL-level
  // filters), then kind/stage/saved filters and pagination apply in
  // JS over the derived rows. The legacy tab path below is untouched
  // for any caller that does not opt in.
  const isV2 = ["kind", "stage", "saved", "q", "per_page"].some((k) => url.searchParams.has(k));
  if (isV2) {
    const TAB_WHERE_V2: Record<string, string> = {
      tofulfill: "status = 'complete' AND physical_status IN ('preorder_received', 'in_print', 'packed')",
      fulfilled: "status = 'complete' AND (physical_status IN ('shipped', 'delivered') OR physical_status IS NULL)",
      all: "1 = 1",
    };
    const rawTabV2 = String(url.searchParams.get("tab") || "");
    const tabV2 = TAB_WHERE_V2[rawTabV2] ? rawTabV2 : "all";
    const q = String(url.searchParams.get("q") || "").trim();
    const whereParts = [TAB_WHERE_V2[tabV2]];
    const binds: any[] = [];
    if (q.length >= 2) {
      whereParts.push("(id LIKE ? OR email LIKE ? OR tracking_number LIKE ? OR ship_name LIKE ?)");
      const like = `%${q}%`;
      binds.push(like, like, like, like);
    }
    const cand = await e.DB.prepare(
      `SELECT id, email, book_slugs, items, amount, currency, status, physical_status, stripe_session_id, created_at, ship_name, ship_address, shipping_cents, quoted_carrier, quoted_service, carrier, carrier_service, tracking_number, label_url, label_cost_cents, pricing_mode, pricing_detail, source FROM orders WHERE ${whereParts.join(" AND ")} ORDER BY created_at DESC LIMIT 1000`
    ).bind(...binds).all();
    const rows = (cand.results || []) as any[];
    const picks = await orderPickList(e.DB, rows).catch(() => new Map());
    const jobsByOrder = await bulkStageJobs(e.DB, rows.map((o) => String(o.id)));
    const podActive = luluConfigured(e);
    // Shipping today: orders with a Lulu parcel whose shipped_at
    // falls on today's Chicago date (shipments are the only rows
    // that carry a real ship timestamp).
    let shippedTodayIds = new Set<string>();
    if (String(url.searchParams.get("saved") || "") === "shipping_today") {
      try {
        const todayCt = new Date(nowSec * 1000).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
        const sh = await e.DB.prepare(
          "SELECT DISTINCT order_id FROM print_shipments WHERE order_id IS NOT NULL AND shipped_at IS NOT NULL AND date(shipped_at, 'unixepoch', '-5 hours') = ?"
        ).bind(todayCt).all();
        shippedTodayIds = new Set(((sh.results || []) as any[]).map((r) => String(r.order_id)));
      } catch { /* shipments table still landing */ }
    }
    const kindCounts = { all: 0, digital: 0, pod: 0, club: 0, needsAttention: 0 };
    const allSlugs: string[] = [];
    for (const o of rows) {
      try {
        const parsed = JSON.parse(o.items || "[]");
        if (Array.isArray(parsed)) for (const x of parsed) if (x && x.slug) allSlugs.push(String(x.slug));
      } catch { /* none */ }
    }
    const listTitles = await loadBookTitles(e.DB, allSlugs);
    const derived = rows.map((o) => {
      const groups = picks.get(o.id) || [];
      const jobs = jobsByOrder.get(String(o.id)) || [];
      const slugsP = resolveGroupSlugs(o, groups, listTitles);
      const orderInput = { status: String(o.status || ""), physicalStatus: o.physical_status || null, createdAt: Number(o.created_at || 0), source: o.source || null };
      const stages = groups.map((g: any, i: number) => stageForGroup({ format: g.format, slug: slugsP[i] }, orderInput, jobs));
      const headline = headlineStage(stages);
      const kind = orderKindOf(groups.map((g: any) => ({ format: g.format })));
      o.items_pick = groups;
      o.has_gift = groups.some((g: any) => g.gift === true);
      o.short_id = shortOrderId(String(o.id));
      o.kind = kind;
      o.stage = headline;
      o.covers = groups.map((g: any) => g.cover).filter(Boolean).slice(0, 4);
      kindCounts.all += 1;
      kindCounts[kind as "digital" | "pod" | "club"] += 1;
      if (headline.bucket === "needs_attention") kindCounts.needsAttention += 1;
      return { order: o, kind, headline, jobs, orderInput };
    });
    const kindParam = String(url.searchParams.get("kind") || "all");
    const stageParam = String(url.searchParams.get("stage") || "all");
    const savedParam = String(url.searchParams.get("saved") || "");
    const filtered = derived.filter((d) => {
      if (kindParam !== "all" && d.kind !== kindParam) return false;
      if (stageParam === "needs_attention" && d.headline.bucket !== "needs_attention") return false;
      if (stageParam !== "all" && stageParam !== "needs_attention" && d.headline.bucket !== stageParam) return false;
      if (savedParam === "shipping_today") return shippedTodayIds.has(String(d.order.id));
      if (savedParam) {
        const oldestJobAgeSec = d.jobs.length ? nowSec - Math.min(...d.jobs.map((j) => j.createdAt)) : null;
        return matchesSavedFilter(savedParam, d.orderInput, d.headline, { nowSec, podActive, hasJob: d.jobs.length > 0, oldestJobAgeSec });
      }
      return true;
    });
    const perPageRaw = Number(url.searchParams.get("per_page") || 10);
    const perPage = [10, 25, 50].includes(perPageRaw) ? perPageRaw : 10;
    const totalFiltered = filtered.length;
    const pagesF = Math.max(1, Math.ceil(totalFiltered / perPage));
    const pageF = Math.min(Math.max(1, Number(url.searchParams.get("page") || 1) || 1), pagesF);
    const pageRows = filtered.slice((pageF - 1) * perPage, pageF * perPage).map((d) => d.order);
    const packing = await getPackingQueue(e.DB).catch(() => []);
    const packingCompleted = await getCompletedParcels(e.DB).catch(() => []);
    return Response.json({
      v2: true,
      orders: pageRows,
      packing,
      packing_completed: packingCompleted,
      outbox: counts,
      tab: tabV2,
      page: pageF,
      pageSize: perPage,
      total: totalFiltered,
      pages: pagesF,
      tabCounts,
      kindCounts,
      podActive,
      stats: {
        toFulfill: Number(statRow?.to_fulfill || 0),
        orders7d: Number(statRow?.orders_7d || 0),
        ordersTotal: Number(statRow?.orders_total || 0),
        revenue30dCents: Number(statRow?.revenue_30d || 0),
      },
      shippo: shippoStatus(e),
    });
  }
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
    `SELECT id, email, book_slugs, items, amount, currency, status, physical_status, stripe_session_id, created_at, ship_name, ship_address, shipping_cents, quoted_carrier, quoted_service, carrier, carrier_service, tracking_number, label_url, label_cost_cents, pricing_mode, pricing_detail FROM orders WHERE ${TAB_WHERE[tab]} ORDER BY created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`
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
    // Gift marker (CG, 2026-11-07): the list badges any order that
    // contains a line the buyer flagged as a gift.
    (o as any).has_gift = (o.items_pick || []).some((g: any) => g.gift === true);
    o.short_id = shortOrderId(String(o.id));
  }
  // The packing shelf ("What do we pack and ship?"): store orders and
  // club boxes awaiting fulfillment, for the section above the tabs.
  // Finished parcels ride separately (packing_completed) so the shelf
  // shows waiting work only and completed work gets its own section.
  const packing = await getPackingQueue(e.DB).catch(() => []);
  const packingCompleted = await getCompletedParcels(e.DB).catch(() => []);
  return Response.json({
    orders: orderRows,
    packing,
    packing_completed: packingCompleted,
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

  if (action === "create_manual_order") {
    const lines = Array.isArray(body?.lines)
      ? body.lines.map((l: any) => ({
          slug: String(l?.slug || ""),
          format: String(l?.format || "digital"),
          qty: Number(l?.qty || 1),
          priceCents: Number(l?.price_cents),
        }))
      : [];
    const a = body?.address || {};
    const result = await createManualOrder(e.DB, {
      name: String(body?.name || ""),
      email: String(body?.email || ""),
      address: {
        line1: String(a.line1 || ""),
        line2: String(a.line2 || ""),
        city: String(a.city || ""),
        state: String(a.state || ""),
        postal_code: String(a.postal_code || ""),
        country: String(a.country || "US"),
      },
      lines,
      shippingCents: Number(body?.shipping_cents || 0),
      note: String(body?.note || ""),
    });
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    return Response.json({ ok: true, order_id: result.order.id });
  }

  if (action === "create_print_job") {
    const orderId = String(body?.order_id || "");
    if (!orderId) return Response.json({ error: "order_id required" }, { status: 400 });
    if (!luluConfigured(e)) {
      return Response.json({ error: "Print fulfillment (Lulu) is not turned on for this worker." }, { status: 400 });
    }
    const order = await e.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
    if (!order) return Response.json({ error: "order not found" }, { status: 404 });
    if ((order as any).status !== "complete" || !(order as any).physical_status) {
      return Response.json({ error: "Print jobs are built for completed physical orders only." }, { status: 400 });
    }
    try {
      const job = await buildJobsForOrder(e.DB, e, order);
      if (!job) return Response.json({ error: "This order has no printed items to send to Lulu." }, { status: 400 });
      if (job.status === "queued") {
        const outcome = await submitPrintJob(e.DB, e, job, SITE);
        if (!outcome.ok) {
          return Response.json({ error: `The print job was built but Lulu submission failed: ${outcome.error}` }, { status: 400 });
        }
        return Response.json({ ok: true, job: outcome.job });
      }
      return Response.json({ ok: true, job });
    } catch (err: any) {
      return Response.json({ error: String(err?.message || "Could not build the print job.") }, { status: 400 });
    }
  }
  if (action === "refresh_print_job") {
    const orderId = String(body?.order_id || "");
    if (!orderId) return Response.json({ error: "order_id required" }, { status: 400 });
    try {
      const summary = await syncPrintJobs(e.DB, e, { orderId });
      const print_jobs = await getPrintJobsForOrder(e.DB, orderId).catch(() => []);
      return Response.json({ ok: true, summary, print_jobs });
    } catch (err: any) {
      return Response.json({ error: String(err?.message || "Could not refresh the print job.") }, { status: 400 });
    }
  }
  if (action === "cancel_print_job") {
    const orderId = String(body?.order_id || "");
    const jobId = String(body?.job_id || "");
    if (!jobId) return Response.json({ error: "job_id required" }, { status: 400 });
    const jobs = await getPrintJobsForOrder(e.DB, orderId).catch(() => []);
    if (!jobs.some((j) => j.id === jobId)) {
      return Response.json({ error: "That print job does not belong to this order." }, { status: 404 });
    }
    const result = await cancelPrintJobById(e.DB, e, jobId);
    if (!result.ok) return Response.json({ error: result.error || "Could not cancel the print job." }, { status: 400 });
    return Response.json({ ok: true, job: result.job });
  }
  // Batch actions (orders admin redo): the list's bulk bar. Every
  // row reports its own result; a batch never silently half-applies.
  // Rows an action does not apply to are skipped WITH the reason.
  if (action === "batch_create_print_jobs" || action === "batch_sync_print_jobs") {
    const ids = (Array.isArray(body?.order_ids) ? body.order_ids : []).map((x: any) => String(x || "")).filter(Boolean).slice(0, 100);
    if (!ids.length) return Response.json({ error: "order_ids required" }, { status: 400 });
    const results: { order_id: string; ok: boolean; message: string }[] = [];
    for (const orderId of ids) {
      if (action === "batch_sync_print_jobs") {
        try {
          const s = await syncPrintJobs(e.DB, e, { orderId });
          results.push({ order_id: orderId, ok: true, message: s.synced ? `Synced ${s.synced} job${s.synced === 1 ? "" : "s"}` : "No submitted job to sync" });
        } catch (err: any) {
          results.push({ order_id: orderId, ok: false, message: String(err?.message || "Sync failed").slice(0, 140) });
        }
        continue;
      }
      if (!luluConfigured(e)) {
        results.push({ order_id: orderId, ok: false, message: "Skipped: the Lulu lane is off" });
        continue;
      }
      const order = await e.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first() as any;
      if (!order) { results.push({ order_id: orderId, ok: false, message: "Skipped: order not found" }); continue; }
      if (order.status !== "complete" || !order.physical_status) {
        results.push({ order_id: orderId, ok: false, message: "Skipped: not a completed physical order" });
        continue;
      }
      try {
        const job = await buildJobsForOrder(e.DB, e, order);
        if (!job) { results.push({ order_id: orderId, ok: false, message: "Skipped: no printed items" }); continue; }
        if (job.status === "queued") {
          const outcome = await submitPrintJob(e.DB, e, job, SITE);
          results.push(outcome.ok
            ? { order_id: orderId, ok: true, message: "Job created and sent to Lulu" }
            : { order_id: orderId, ok: false, message: `Built, but Lulu submission failed: ${outcome.error}` });
        } else {
          results.push({ order_id: orderId, ok: true, message: `Job already ${job.status}` });
        }
      } catch (err: any) {
        results.push({ order_id: orderId, ok: false, message: String(err?.message || "Could not build the job").slice(0, 140) });
      }
    }
    return Response.json({ ok: true, results });
  }
  if (action === "export_csv") {
    const ids = (Array.isArray(body?.order_ids) ? body.order_ids : []).map((x: any) => String(x || "")).filter(Boolean).slice(0, 500);
    if (!ids.length) return Response.json({ error: "order_ids required" }, { status: 400 });
    const rows = await e.DB.prepare(
      `SELECT * FROM orders WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at DESC`
    ).bind(...ids).all();
    const orderRows = (rows.results || []) as any[];
    const picks = await orderPickList(e.DB, orderRows).catch(() => new Map());
    const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = ["order_id,date,email,name,items,kind,status,stage,total_cents,tracking"];
    for (const o of orderRows) {
      const groups = picks.get(o.id) || [];
      const kind = orderKindOf(groups.map((g: any) => ({ format: g.format })));
      lines.push([
        shortOrderId(String(o.id)),
        new Date(Number(o.created_at || 0) * 1000).toISOString(),
        o.email || "",
        o.ship_name || "",
        groups.map((g: any) => `${g.title} (${g.format})${g.count > 1 ? ` x${g.count}` : ""}`).join("; "),
        kind,
        o.status || "",
        o.physical_status || (o.status === "complete" ? "delivered" : ""),
        String(o.amount ?? ""),
        o.tracking_number || "",
      ].map(esc).join(","));
    }
    return Response.json({ ok: true, csv: lines.join("\n"), filename: `orders-export-${new Date().toISOString().slice(0, 10)}.csv` });
  }
  if (action === "set_physical_status") {
    const orderId = String(body?.order_id || "");
    const status = String(body?.status || "");
    // Ship gate (admin redesign S4): an order ships only with a
    // purchased label and a fully ticked pack checklist. Enforced
    // here so every caller (detail page, list advance, kebab) gets
    // the same plain refusal. (The old extra "label printed" tick
    // went away in the 2026-11-05 fulfillment cleanup.)
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
