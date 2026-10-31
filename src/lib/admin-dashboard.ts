// Admin dashboard data (pass 4, 2026-10-29): every number on the
// /admin home from real D1 rows, computed with a bounded set of
// aggregate queries. Written against the same minimal D1-shaped
// interface as lib/orders.ts so it unit-tests against bun:sqlite.
//
// Honesty rules: revenue counts COMPLETE orders only; order counts
// say which statuses they include; club and audience numbers read
// the real tables even when they are zero (they are, today: no paid
// members yet). "Held" books are the ones sitting at the factory's
// human gates (pilot approval, QA, repair) — page-level hold state
// itself lives in the factory's R2 page files, not in D1, so the
// dashboard reports the book-level gates it can actually see.
import { orderItemLabels } from "./orders";
import { ensurePublicSlugColumn, publicSlugFor } from "./public-slugs";

export interface AdminDashboardData {
  ordersTotal: number;
  ordersToday: number;
  orders7d: number;
  revenue30dCents: number;
  pendingFulfillment: { printedWaiting: number; boxesNeedAttention: number; total: number };
  attention: {
    brokenBooks: { slug: string; adminSlug: string; title: string; state: string }[];
    booksAtGates: number;
    boxesNeedAttention: number;
    outboxPending: number;
    outboxFailed: number;
    reviewsPending: number;
    uncastLeads: { slug: string; title: string; lead: string }[];
  };
  fulfillment: {
    printedByStatus: { status: string; label: string; count: number }[];
    boxesDue7d: number;
  };
  audience: {
    subscribers: number;
    clubActiveByPlan: { plan: string; count: number }[];
    audioClubActive: number;
  };
  recentOrders: {
    id: string;
    email: string;
    items: string[];
    amountCents: number;
    status: string;
    createdAt: number;
  }[];
}

const DAY = 86400;

// UTC instant (seconds) of midnight today in America/Chicago.
export function chicagoDayStartSec(nowSec: number): number {
  const tz = "America/Chicago";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(nowSec * 1000));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0);
  const guess = Date.UTC(get("year"), get("month") - 1, get("day")) / 1000;
  const at = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(guess * 1000));
  const g = (t: string) => Number(at.find((p) => p.type === t)?.value || 0);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second")) / 1000;
  return guess - (asUtc - guess);
}

function isoDay(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

async function count(db: any, sql: string, ...args: any[]): Promise<number> {
  const row = await db.prepare(sql).bind(...args).first();
  return Number((row as any)?.n || 0);
}

export async function getAdminDashboard(db: any, nowSec: number): Promise<AdminDashboardData> {
  const dayStart = chicagoDayStartSec(nowSec);
  // The needs-attention query reads public_slug (admin links wear
  // it); make sure the column exists on any database this runs on.
  await ensurePublicSlugColumn(db).catch(() => {});

  // ---- Stat cards ---------------------------------------------------
  const ordersTotal = await count(db, "SELECT COUNT(*) AS n FROM orders");
  const ordersToday = await count(
    db, "SELECT COUNT(*) AS n FROM orders WHERE created_at >= ?", dayStart
  );
  const orders7d = await count(
    db, "SELECT COUNT(*) AS n FROM orders WHERE created_at >= ?", nowSec - 7 * DAY
  );
  const revRow = await db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM orders WHERE status = 'complete' AND created_at >= ?")
    .bind(nowSec - 30 * DAY)
    .first();
  const revenue30dCents = Number((revRow as any)?.n || 0);
  const printedWaiting = await count(
    db,
    "SELECT COUNT(*) AS n FROM orders WHERE status = 'complete' AND physical_status IN ('preorder_received', 'in_print', 'packed')"
  );
  const boxesNeedAttention = await count(
    db, "SELECT COUNT(*) AS n FROM club_cycle_boxes WHERE status = 'needs_attention'"
  ).catch(() => 0);

  // ---- Needs attention ----------------------------------------------
  const brokenRows = await db
    .prepare(
      "SELECT slug, public_slug, title, status, stage FROM books WHERE status = 'failed' OR stage = 'repair_failed' ORDER BY title LIMIT 12"
    )
    .all();
  const brokenBooks = ((brokenRows.results || []) as any[]).map((b) => ({
    slug: String(b.slug),
    // Admin book links wear the PUBLIC slug (owner, 2026-10-29).
    adminSlug: publicSlugFor(b),
    title: String(b.title || "Untitled book"),
    state: b.status === "failed" ? `failed (${String(b.stage || "unknown stage")})` : "repair failed",
  }));
  const booksAtGates = await count(
    db,
    "SELECT COUNT(*) AS n FROM books WHERE status = 'ready_for_qa' OR stage = 'awaiting_pilot_approval'"
  );
  const outboxPending = await count(db, "SELECT COUNT(*) AS n FROM email_outbox WHERE status = 'pending'");
  const outboxFailed = await count(db, "SELECT COUNT(*) AS n FROM email_outbox WHERE status = 'failed'");
  const reviewsPending = await count(db, "SELECT COUNT(*) AS n FROM reviews WHERE status = 'pending'").catch(() => 0);

  // Published books whose lead character has no cast voice yet. The
  // lead is the character whose name opens the book's title (every
  // catalog title is "Name the Animal and the ...").
  const uncastLeads: { slug: string; title: string; lead: string }[] = [];
  const completeRows = await db
    .prepare("SELECT slug, title FROM books WHERE status = 'complete' ORDER BY title")
    .all();
  for (const b of ((completeRows.results || []) as any[])) {
    const chars = await db
      .prepare("SELECT name FROM characters WHERE book_slug = ?")
      .bind(String(b.slug))
      .all();
    const lead = ((chars.results || []) as any[])
      .map((c) => String(c.name))
      .find((name) => String(b.title || "").startsWith(name + " "));
    if (!lead) continue;
    const voice = await db
      .prepare("SELECT character_name FROM character_voices WHERE character_name = ?")
      .bind(lead)
      .first()
      .catch(() => null);
    if (!voice) uncastLeads.push({ slug: String(b.slug), title: String(b.title), lead });
  }

  // ---- Fulfillment snapshot ------------------------------------------
  const FLOW: [string, string][] = [
    ["preorder_received", "Received"],
    ["in_print", "In print"],
    ["packed", "Packed"],
    ["shipped", "Shipped"],
    ["delivered", "Delivered"],
  ];
  const printedByStatus: { status: string; label: string; count: number }[] = [];
  for (const [status, label] of FLOW) {
    printedByStatus.push({
      status,
      label,
      count: await count(
        db,
        "SELECT COUNT(*) AS n FROM orders WHERE status = 'complete' AND physical_status = ?",
        status
      ),
    });
  }
  const boxesDue7d = await count(
    db,
    "SELECT COUNT(*) AS n FROM club_cycle_boxes WHERE ship_date >= ? AND ship_date <= ? AND status NOT IN ('delivered', 'skipped', 'canceled')",
    isoDay(dayStart),
    isoDay(dayStart + 7 * DAY)
  ).catch(() => 0);

  // ---- Audience -------------------------------------------------------
  const subscribers = await count(db, "SELECT COUNT(*) AS n FROM subscribers").catch(() => 0);
  const planRows = await db
    .prepare(
      "SELECT COALESCE(NULLIF(club_plan, ''), NULLIF(plan, ''), 'club') AS plan, COUNT(*) AS n FROM club_signups WHERE status = 'active' GROUP BY plan ORDER BY plan"
    )
    .all()
    .catch(() => ({ results: [] }));
  const clubActiveByPlan = (((planRows as any).results || []) as any[]).map((r) => ({
    plan: String(r.plan),
    count: Number(r.n || 0),
  }));
  const audioClubActive = await count(
    db,
    "SELECT COUNT(*) AS n FROM club_signups WHERE status = 'active' AND (club_plan = 'audio' OR plan = 'audio' OR shelf = 'audio')"
  ).catch(() => 0);

  // ---- Recent orders (titles, per the display rule) -------------------
  const recentRows = await db
    .prepare(
      "SELECT id, email, items, book_slugs, amount, status, created_at FROM orders ORDER BY created_at DESC LIMIT 8"
    )
    .all();
  const recent = ((recentRows.results || []) as any[]);
  const labelMap = await orderItemLabels(db, recent).catch(() => new Map());
  const recentOrders = recent.map((o) => ({
    id: String(o.id),
    email: String(o.email || ""),
    items: labelMap.get(String(o.id)) || [],
    amountCents: Number(o.amount || 0),
    status: String(o.status || ""),
    createdAt: Number(o.created_at || 0),
  }));

  return {
    ordersTotal,
    ordersToday,
    orders7d,
    revenue30dCents,
    pendingFulfillment: {
      printedWaiting,
      boxesNeedAttention,
      total: printedWaiting + boxesNeedAttention,
    },
    attention: {
      brokenBooks,
      booksAtGates,
      boxesNeedAttention,
      outboxPending,
      outboxFailed,
      reviewsPending,
      uncastLeads,
    },
    fulfillment: { printedByStatus, boxesDue7d },
    audience: { subscribers, clubActiveByPlan, audioClubActive },
    recentOrders,
  };
}
