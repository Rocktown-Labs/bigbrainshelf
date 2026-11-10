// Per-line order stages (orders admin redo, CG-approved prototype v3,
// 2026-11-10). The legacy single physical_status stepper vocabulary
// is gone from the admin pages: every order LINE lives on its own
// timeline and the order headline is a roll-up of its lines, because
// a mixed order is never in one place at once.
//
// Stage sources, in order of authority for a physical line:
//   1. Its Lulu print job (print_jobs + job items), when one exists.
//      POD stage names are honest about Lulu's vocabulary:
//      PRODUCTION_DELAYED is the routine pre-print hold and the only
//      free-cancel window, so it reads "Sent to Lulu, cancel window
//      open"; REJECTED (Lulu refused the files) is a different stage
//      from ERROR (the job broke) and from a plain local failure.
//   2. The home fulfillment flow (orders.physical_status), which is
//      the live lane while FULFILLMENT_PROVIDER is off. Home stages
//      are never dressed up as Lulu stages.
//   3. Digital lines deliver at payment: complete = Delivered.
//
// This module is pure (no DB) except getOrderPipeline, so the
// derivation is unit-testable against fixture rows.

export type OrderKind = "digital" | "pod" | "club";
export type StageTone = "ok" | "progress" | "attention" | "exception" | "muted";
export type StageBucket =
  | "needs_attention"
  | "queued"
  | "in_production"
  | "home"
  | "shipped"
  | "delivered"
  | "other";

export interface LineStage {
  key: string;
  label: string;
  tone: StageTone;
  bucket: StageBucket;
  // Step track for physical lines (empty for digital). stepIndex is
  // the current step, or -1 when the line is off the track (an
  // exception or a canceled job).
  steps: string[];
  stepIndex: number;
  note?: string;
  jobId?: string;
}

export interface StageGroupInput {
  format: string; // digital | printed | giftset | audio | club period
  slug?: string | null;
}

export interface StageOrderInput {
  status: string;
  physicalStatus: string | null;
  createdAt: number;
  source?: string | null;
}

export interface StageJobItemInput {
  slug: string;
  kind: string; // storybook | coloring
  status: string | null;
}

export interface StageJobInput {
  id: string;
  status: string; // queued | submitted | blocked_no_printable | failed | canceled
  luluStatus: string | null;
  hasPartial: boolean;
  createdAt: number;
  items: StageJobItemInput[];
}

export const POD_STEPS = ["Paid", "Job created", "Sent to Lulu", "In production", "Shipped", "Delivered"];
export const HOME_STEPS = ["Paid", "Received", "In print", "Packed", "Shipped", "Delivered"];

const CLUB_FORMATS = new Set(["monthly", "quarterly", "annual", "yearly"]);
const PHYSICAL_FORMATS = new Set(["printed", "giftset"]);

export function orderKindOf(groups: StageGroupInput[]): OrderKind {
  if (groups.some((g) => CLUB_FORMATS.has(g.format))) return "club";
  if (groups.some((g) => PHYSICAL_FORMATS.has(g.format))) return "pod";
  return "digital";
}

export function groupIsPhysical(g: StageGroupInput): boolean {
  return PHYSICAL_FORMATS.has(g.format);
}

function deliveredStage(): LineStage {
  return { key: "delivered", label: "Delivered", tone: "ok", bucket: "delivered", steps: [], stepIndex: -1 };
}

export function digitalStage(order: StageOrderInput): LineStage {
  if (order.status === "complete") return deliveredStage();
  if (order.status === "pending") {
    return { key: "awaiting_payment", label: "Awaiting payment", tone: "muted", bucket: "other", steps: [], stepIndex: -1 };
  }
  return { key: "order_" + order.status, label: order.status, tone: "muted", bucket: "other", steps: [], stepIndex: -1 };
}

const HOME_STAGE: Record<string, { label: string; stepIndex: number }> = {
  preorder_received: { label: "Received, to print at home", stepIndex: 1 },
  in_print: { label: "Printing at home", stepIndex: 2 },
  packed: { label: "Packed, ready to ship", stepIndex: 3 },
  shipped: { label: "Shipped", stepIndex: 4 },
  delivered: { label: "Delivered", stepIndex: 5 },
};

export function homeStage(order: StageOrderInput): LineStage {
  if (order.status !== "complete") return digitalStage(order);
  const s = HOME_STAGE[String(order.physicalStatus || "preorder_received")] || HOME_STAGE.preorder_received;
  const done = s.stepIndex >= HOME_STEPS.length - 1;
  return {
    key: "home_" + (order.physicalStatus || "preorder_received"),
    label: s.label,
    tone: done ? "ok" : "progress",
    bucket: done ? "delivered" : s.stepIndex >= 4 ? "shipped" : "home",
    steps: HOME_STEPS,
    stepIndex: s.stepIndex,
  };
}

// The stage of ONE print job, in the job's own terms. Partial
// shipments surface here: Lulu flips the job to SHIPPED when the
// first parcel leaves, so hasPartial (some items not yet shipped)
// is what separates "Shipped" from "Part shipped".
export function podStageForJob(job: StageJobInput): LineStage {
  const base = { steps: POD_STEPS, jobId: job.id };
  const lulu = String(job.luluStatus || "").toUpperCase();
  if (lulu === "REJECTED" || (job.status === "failed" && lulu === "REJECTED")) {
    return { ...base, key: "rejected", label: "Rejected by Lulu", tone: "exception", bucket: "needs_attention", stepIndex: -1, note: "Lulu refused the print files. Fix the files, then build a new job." };
  }
  if (lulu === "ERROR") {
    return { ...base, key: "lulu_error", label: "Lulu error", tone: "exception", bucket: "needs_attention", stepIndex: -1, note: "The job broke at Lulu. Sync the status, then rebuild if it stays errored." };
  }
  if (job.status === "failed") {
    return { ...base, key: "job_failed", label: "Print job failed", tone: "exception", bucket: "needs_attention", stepIndex: -1 };
  }
  if (job.status === "blocked_no_printable") {
    return { ...base, key: "missing_print_file", label: "Missing print file", tone: "exception", bucket: "needs_attention", stepIndex: -1, note: "A line in this job has no print-ready file yet." };
  }
  if (job.status === "canceled" || lulu === "CANCELED") {
    return { ...base, key: "job_canceled", label: "Job canceled", tone: "muted", bucket: "other", stepIndex: -1 };
  }
  if (job.status === "queued") {
    return { ...base, key: "job_queued", label: "Job queued", tone: "progress", bucket: "queued", stepIndex: 1 };
  }
  // submitted
  switch (lulu) {
    case "CREATED":
    case "UNPAID":
    case "PAYMENT_IN_PROGRESS":
    case "PRODUCTION_DELAYED":
      return { ...base, key: "sent_to_lulu", label: "Sent to Lulu, cancel window open", tone: "progress", bucket: "queued", stepIndex: 2, note: "Production delayed is Lulu's name for the routine pre-print hold. It is the only window where a cancel is free." };
    case "ACCEPTED":
    case "PRODUCTION_READY":
    case "IN_PRODUCTION":
      return { ...base, key: "in_production", label: "In production at Lulu", tone: "progress", bucket: "in_production", stepIndex: 3 };
    case "SHIPPED":
      return job.hasPartial
        ? { ...base, key: "part_shipped", label: "Part shipped", tone: "progress", bucket: "shipped", stepIndex: 4, note: "One parcel is on its way; the rest of this job has not shipped yet." }
        : { ...base, key: "shipped", label: "Shipped", tone: "progress", bucket: "shipped", stepIndex: 4 };
    case "DELIVERED":
      return { ...base, key: "delivered", label: "Delivered", tone: "ok", bucket: "delivered", stepIndex: 5 };
    default:
      return { ...base, key: "at_lulu", label: "At Lulu", tone: "progress", bucket: "in_production", stepIndex: 3 };
  }
}

// Does this job carry this pick group? A printed line is the job's
// story item for the slug; a gift set is story + coloring (job item
// kinds in print_job_items are "story" | "coloring").
export function jobCoversGroup(job: StageJobInput, group: StageGroupInput): boolean {
  if (!group.slug) return false;
  return job.items.some((it) => it.slug === group.slug && (it.kind === "story" || it.kind === "storybook"));
}

const JOB_PRIORITY: Record<string, number> = {
  failed: 0, blocked_no_printable: 1, submitted: 2, queued: 3, canceled: 4,
};

// The stage of one order line: its print job's stage when a job
// carries it, else the home flow for physical lines, else digital.
export function stageForGroup(
  group: StageGroupInput,
  order: StageOrderInput,
  jobs: StageJobInput[]
): LineStage {
  if (!groupIsPhysical(group)) return digitalStage(order);
  if (order.status !== "complete") return digitalStage(order);
  const mine = jobs
    .filter((j) => jobCoversGroup(j, group))
    .sort((a, b) => (JOB_PRIORITY[a.status] ?? 9) - (JOB_PRIORITY[b.status] ?? 9) || b.createdAt - a.createdAt);
  if (mine.length) {
    const stage = podStageForJob(mine[0]);
    // A job whose items for this group all read DELIVERED settles the
    // line even while a sibling item in the same job still travels.
    const items = mine[0].items.filter((it) => it.slug === group.slug);
    if (items.length && items.every((it) => String(it.status || "").toUpperCase() === "DELIVERED")) {
      return { ...deliveredStage(), jobId: mine[0].id };
    }
    return stage;
  }
  return homeStage(order);
}

// The order headline: the worst line speaks first (an exception
// anywhere is the headline), then the least-advanced open line, then
// Delivered when every line is delivered.
export function headlineStage(stages: LineStage[]): LineStage {
  if (!stages.length) return { key: "empty", label: "No items", tone: "muted", bucket: "other", steps: [], stepIndex: -1 };
  const exception = stages.find((s) => s.tone === "exception");
  if (exception) return exception;
  const attention = stages.find((s) => s.tone === "attention");
  if (attention) return attention;
  const open = stages.filter((s) => s.bucket !== "delivered");
  if (!open.length) return deliveredStage();
  const rank = (s: LineStage) => (s.steps.length ? s.stepIndex : 99);
  return [...open].sort((a, b) => rank(a) - rank(b))[0];
}

// Saved filters on the orders list are stored queries over the
// derivation, not tabs (prototype v3). "stuck" mirrors the PR #76
// urgency thresholds; "needs_action" is any exception state plus a
// paid physical order with no job a day after payment (POD lane) or
// a manual order still waiting on the operator's button.
export interface SavedFilterContext {
  nowSec: number;
  podActive: boolean;
  hasJob: boolean;
  oldestJobAgeSec: number | null;
}

export function matchesSavedFilter(
  saved: string,
  order: StageOrderInput & { amountCents?: number },
  headline: LineStage,
  ctx: SavedFilterContext
): boolean {
  const ageSec = ctx.nowSec - order.createdAt;
  switch (saved) {
    case "needs_action":
      if (headline.tone === "exception") return true;
      if (order.status === "complete" && headline.bucket !== "delivered" && headline.bucket !== "shipped") {
        if (ctx.podActive && !ctx.hasJob && order.source !== "manual" && ageSec > 86400) return true;
        if (order.source === "manual" && !ctx.hasJob) return true;
      }
      return false;
    case "stuck":
      if (headline.key === "job_queued" && ctx.oldestJobAgeSec != null && ctx.oldestJobAgeSec > 86400) return true;
      if (headline.key === "in_production" && ctx.oldestJobAgeSec != null && ctx.oldestJobAgeSec > 7 * 86400) return true;
      if (headline.bucket === "home" && ageSec > 3 * 86400) return true;
      if (ctx.podActive && !ctx.hasJob && order.source !== "manual" && order.status === "complete" && ageSec > 86400) return true;
      return false;
    case "manual_waiting":
      return order.source === "manual" && order.status === "complete" && !ctx.hasJob && headline.bucket !== "delivered";
    default:
      return true;
  }
}

// Lane B (the home sticker packet on club boxes) rides behind the
// CLUB_HOME_PACK_LANE flag, default OFF: off hides the lane on the
// box page entirely. Stickers cannot ride in a Lulu parcel (Lulu
// prints every item it ships and holds no inventory).
export function homePackLaneEnabled(envLike: any): boolean {
  const v = String(envLike?.CLUB_HOME_PACK_LANE || "").toLowerCase();
  return v === "1" || v === "true";
}

// The dashboard shows only stages WITH activity (condense pass,
// CG 2026-11-10): a zero-count stage row is noise on a phone, so
// the pipeline card filters to count > 0 and an all-zero lane
// renders one quiet "nothing in flight" line instead.
export function visibleStageRows<T extends { count: number }>(rows: T[]): T[] {
  return rows.filter((r) => r.count > 0);
}

// Dashboard pipeline: counts by stage x kind, maintained from the
// tables of record at read time (the catalog is small; the
// prototype's rollup table is a scale optimization, not a
// correctness need). POD counts come from print_jobs; home counts
// from physical orders with no job; club counts from cycle boxes.
export interface OrderPipeline {
  pod: { key: string; label: string; count: number }[];
  home: { key: string; label: string; count: number }[];
  digital: { delivered: number; awaitingPayment: number };
  club: { key: string; label: string; count: number }[];
  exceptions: number;
}

export async function getOrderPipeline(db: any): Promise<OrderPipeline> {
  const count = async (sql: string, ...binds: any[]) => {
    try {
      const row = await db.prepare(sql).bind(...binds).first();
      return Number(row?.n ?? 0);
    } catch {
      return 0;
    }
  };
  const pod: OrderPipeline["pod"] = [
    { key: "job_queued", label: "Paid, job queued", count: await count("SELECT COUNT(*) AS n FROM print_jobs WHERE status = 'queued'") },
    { key: "sent_to_lulu", label: "Sent to Lulu, cancel window open", count: await count("SELECT COUNT(*) AS n FROM print_jobs WHERE status = 'submitted' AND COALESCE(lulu_status, '') IN ('CREATED', 'UNPAID', 'PAYMENT_IN_PROGRESS', 'PRODUCTION_DELAYED')") },
    { key: "in_production", label: "At Lulu, in production", count: await count("SELECT COUNT(*) AS n FROM print_jobs WHERE status = 'submitted' AND COALESCE(lulu_status, '') IN ('ACCEPTED', 'PRODUCTION_READY', 'IN_PRODUCTION')") },
    { key: "shipped", label: "Shipped, in transit", count: await count("SELECT COUNT(*) AS n FROM print_jobs WHERE status = 'submitted' AND lulu_status = 'SHIPPED'") },
    { key: "delivered", label: "Delivered", count: await count("SELECT COUNT(*) AS n FROM print_jobs WHERE status = 'submitted' AND lulu_status = 'DELIVERED'") },
    { key: "exceptions", label: "Exceptions", count: await count("SELECT COUNT(*) AS n FROM print_jobs WHERE status IN ('failed', 'blocked_no_printable')") },
  ];
  const home: OrderPipeline["home"] = [
    { key: "preorder_received", label: "Received, to print", count: await count("SELECT COUNT(*) AS n FROM orders WHERE status = 'complete' AND physical_status = 'preorder_received' AND id NOT IN (SELECT order_id FROM print_jobs WHERE order_id IS NOT NULL)") },
    { key: "in_print", label: "In print at home", count: await count("SELECT COUNT(*) AS n FROM orders WHERE status = 'complete' AND physical_status = 'in_print' AND id NOT IN (SELECT order_id FROM print_jobs WHERE order_id IS NOT NULL)") },
    { key: "packed", label: "Packed", count: await count("SELECT COUNT(*) AS n FROM orders WHERE status = 'complete' AND physical_status = 'packed' AND id NOT IN (SELECT order_id FROM print_jobs WHERE order_id IS NOT NULL)") },
    { key: "shipped", label: "Shipped", count: await count("SELECT COUNT(*) AS n FROM orders WHERE status = 'complete' AND physical_status = 'shipped'") },
    { key: "delivered", label: "Delivered", count: await count("SELECT COUNT(*) AS n FROM orders WHERE status = 'complete' AND physical_status = 'delivered'") },
  ];
  const digital = {
    delivered: await count("SELECT COUNT(*) AS n FROM orders WHERE status = 'complete' AND physical_status IS NULL"),
    awaitingPayment: await count("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'"),
  };
  const club: OrderPipeline["club"] = [
    { key: "awaiting", label: "Awaiting picks", count: await count("SELECT COUNT(*) AS n FROM club_cycle_boxes WHERE status IN ('awaiting_selection', 'needs_attention')") },
    { key: "preparing", label: "Locked, being prepared", count: await count("SELECT COUNT(*) AS n FROM club_cycle_boxes WHERE status IN ('locked', 'preparing')") },
    { key: "shipped", label: "Shipped", count: await count("SELECT COUNT(*) AS n FROM club_cycle_boxes WHERE status = 'shipped'") },
    { key: "delivered", label: "Delivered", count: await count("SELECT COUNT(*) AS n FROM club_cycle_boxes WHERE status = 'delivered'") },
    { key: "past_due", label: "Past ship date, not shipped", count: await count("SELECT COUNT(*) AS n FROM club_cycle_boxes WHERE status NOT IN ('shipped', 'delivered', 'skipped', 'canceled') AND ship_date < date('now')") },
  ];
  return { pod, home, digital, club, exceptions: pod.find((p) => p.key === "exceptions")?.count ?? 0 };
}
