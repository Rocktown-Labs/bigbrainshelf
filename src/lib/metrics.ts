import { env } from "cloudflare:workers";

// Store metrics plane: Workers Analytics Engine dataset `store_events`
// (binding ANALYTICS, declared in deploy.py). The hub-side sibling of
// the factory's factory_metrics: D1 stays the durable record, this is
// the hot, SQL-queryable window over store activity (roughly three
// months of retention).
//
// One datapoint per event, kept low-cardinality on purpose:
//   blobs   = [event_name, slug_or_section, source, utm_medium,
//              utm_campaign, utm_content]
//   doubles = [amount_usd, quantity]
//   index   = the event name, or a book's PUBLIC slug for book events
// The three UTM blobs were appended in 2026-11-20 (full-set
// attribution); positions 1-3 are unchanged so older queries and
// dashboards keep reading the same fields. Never a user id, email,
// or order id: those live in D1 where they belong. Fire-and-forget:
// a metrics failure must never break a sale, a download, or a
// reading session, so this never throws.
export interface StoreEventOpts {
  section?: string;
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  amountUsd?: number;
  quantity?: number;
  index?: string;
}

export function emitStoreEvent(name: string, opts: StoreEventOpts = {}): void {
  try {
    const ae = (env as any).ANALYTICS;
    if (!ae?.writeDataPoint) return;
    ae.writeDataPoint({
      blobs: [
        name,
        opts.section ?? "",
        opts.source ?? "hub",
        opts.medium ?? "",
        opts.campaign ?? "",
        opts.content ?? "",
      ],
      doubles: [opts.amountUsd ?? 0, opts.quantity ?? 1],
      indexes: [opts.index ?? name],
    });
  } catch {
    // metrics are best-effort, always
  }
}
