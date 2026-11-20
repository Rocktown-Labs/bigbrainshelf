import type { APIRoute } from "astro";
import { emitStoreEvent } from "../../lib/metrics";
import { sanitizeAttribution } from "../../lib/attribution";

// POST /api/collect { name, path, utm_source?, utm_medium?,
//   utm_campaign?, utm_content?, value? }
// First-party funnel mirror (CG, 2026-11-01): the storefront's Traks
// taxonomy events also land in Analytics Engine store_events, so the
// client funnel joins the server-side money events (Stripe webhook,
// downloads, reading telemetry) in one SQL-queryable place. Traks
// stays the dashboard; this is the joinable copy. The route is
// deliberately dumb: an allowlist of event names, a sanitized path,
// an optional first-touch UTM set (full set since 2026-11-20,
// sanitized by lib/attribution), an optional numeric value. Event
// props never cross into AE (they stay in Traks), which keeps
// cardinality low and makes it impossible for personal data to ride
// along. Beacons get a 204 either way; junk is dropped silently.

const ALLOWED = new Set([
  "page_view", "book_view", "audiobook_view", "purchase", "club_subscribed",
  "read_start", "add_to_cart", "begin_checkout", "newsletter_signup", "search",
  "sample_play", "listen_start", "club_join_click", "club_checkout_start",
  "account_signup", "referral_link_shared", "review_submitted", "owned_download",
]);

const BOT_UA = /bot|crawler|spider|headless|preview|curl|wget|python-requests/i;

function cleanSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 80);
}

export const POST: APIRoute = async ({ request }) => {
  const done = new Response(null, { status: 204 });
  const ua = request.headers.get("user-agent") || "";
  if (!ua || BOT_UA.test(ua)) return done;
  let raw = "";
  try { raw = await request.text(); } catch { return done; }
  if (!raw || raw.length > 2048) return done;
  let body: any = null;
  try { body = JSON.parse(raw); } catch { return done; }
  const name = String(body?.name || "");
  if (!ALLOWED.has(name)) return done;

  const path = String(body?.path || "/").slice(0, 200);
  let section = "home";
  const bookMatch = path.match(/^\/(?:books|audiobooks)\/([^/?#]+)/);
  if (bookMatch) section = cleanSlug(bookMatch[1]);
  else if (path !== "/") section = cleanSlug(path.split("/").filter(Boolean)[0] || "home") || "home";

  const attr = sanitizeAttribution(body);
  const source = attr?.source || "web";

  const value = typeof body?.value === "number" && isFinite(body.value)
    ? Math.min(Math.max(body.value, 0), 100000)
    : 0;

  emitStoreEvent(name, {
    section,
    source,
    medium: attr?.medium,
    campaign: attr?.campaign,
    content: attr?.content,
    amountUsd: value,
    index: section,
  });
  return done;
};
