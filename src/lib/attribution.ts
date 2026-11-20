// Acquisition attribution (CG, 2026-11-20): where a buyer came from,
// captured first-touch on the storefront and stamped on the order.
//
// The client (Tracking.astro) keeps the first UTM-tagged landing for
// 30 days and sends the set with the checkout; this module is the one
// sanitizer every server surface shares (checkout, club checkout, the
// /api/collect metrics mirror), plus the reader for the JSON stored
// on the order row (orders.attribution, ensured in lib/orders.ts).
//
// Shape discipline mirrors the collect endpoint's original rule:
// lowercase, a tight charset, hard length caps, and null when there
// is nothing worth keeping. Values are link tags we mint ourselves
// (utm_source=tiktok and friends), never personal data.

export interface Attribution {
  source: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
  /** First-touch landing path (no query string), e.g. "/books/mira-the-heron-and-the-still-water". */
  landing?: string;
  /** First-touch time, epoch seconds. */
  ts?: number;
}

function cleanTag(v: unknown, cap: number): string {
  return String(v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, cap);
}

function cleanLanding(v: unknown): string {
  const raw = String(v ?? "").split(/[?#]/)[0];
  if (!raw.startsWith("/")) return "";
  return raw.replace(/[^a-z0-9/_-]/gi, "").slice(0, 120);
}

/**
 * Validate an incoming attribution payload (checkout body, collect
 * beacon). Accepts both key spellings ({source, medium, ...} from
 * the storefront store, {utm_source, ...} raw). Returns null when no
 * usable tag survives: an order with no campaign behind it keeps a
 * NULL attribution rather than an empty shell.
 */
export function sanitizeAttribution(input: unknown): Attribution | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const b = input as Record<string, unknown>;
  const pick = (a: string, bKey: string) => (b[a] !== undefined ? b[a] : b[bKey]);
  const source = cleanTag(pick("source", "utm_source"), 32);
  const medium = cleanTag(pick("medium", "utm_medium"), 32);
  const campaign = cleanTag(pick("campaign", "utm_campaign"), 64);
  const term = cleanTag(pick("term", "utm_term"), 64);
  const content = cleanTag(pick("content", "utm_content"), 64);
  if (!source && !medium && !campaign) return null;
  const out: Attribution = { source };
  if (medium) out.medium = medium;
  if (campaign) out.campaign = campaign;
  if (term) out.term = term;
  if (content) out.content = content;
  const landing = cleanLanding(b.landing);
  if (landing) out.landing = landing;
  const ts = Math.floor(Number(b.ts));
  // Sane window only: nothing before 2020, nothing a day into the future.
  if (isFinite(ts) && ts > 1577836800 && ts < Date.now() / 1000 + 86400) out.ts = ts;
  return out;
}

/** Parse the JSON stored on an order row; junk reads as no attribution. */
export function parseAttribution(raw: unknown): Attribution | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return sanitizeAttribution(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * The Stripe-visible slice: source, medium, and campaign ride the
 * checkout session metadata so a payment in the Stripe dashboard
 * names its campaign too. Term and content stay in D1 only.
 */
export function attributionStripeMetadata(attr: Attribution | null): Record<string, string> {
  if (!attr) return {};
  const out: Record<string, string> = {};
  if (attr.source) out.utm_source = attr.source;
  if (attr.medium) out.utm_medium = attr.medium;
  if (attr.campaign) out.utm_campaign = attr.campaign;
  return out;
}

/** One-line human label for admin surfaces: "tiktok / social / holiday-2026". */
export function attributionLabel(attr: Attribution | null): string {
  if (!attr) return "";
  return [attr.source, attr.medium, attr.campaign].filter(Boolean).join(" / ");
}
