// Edge caching for the anonymous public pages (performance pass).
//
// The storefront's slow transitions were mostly slow HTML: Astro SSR
// on Workers renders every page per request, and Cloudflare does not
// cache HTML by default. These pages are verified session-independent
// for a visitor with no session cookies (the header account link is
// client-synced by script; the personalized variants of /clubs
// and /books/[slug] only render when a session exists, and any
// request carrying a session cookie bypasses this cache on both read
// and write). The middleware stores the anonymous HTML in the
// Workers Cache API (caches.default) and serves it at the edge.
//
// HARD EXCLUSIONS (never cached, by construction of the allowlist):
// /account, /admin, /api (all of it), /read, /order, /cart, login,
// signup, checkout and auth routes, and any page not listed here.
// Bounded staleness is the accepted trade: five minutes at the edge,
// so a publish or a copy fix shows within minutes.

// What the visitor (and any downstream HTTP cache, once the owner
// adds a Cache Rule) sees: revalidate immediately, serve from the
// shared cache for five minutes, allow stale while revalidating.
export const EDGE_CACHE_CONTROL =
  "public, max-age=0, s-maxage=300, stale-while-revalidate=600";
// What the Cache API copy carries: the Cache API honors max-age for
// its own freshness, so the stored clone gets a plain 300s max-age
// (max-age=0 would stale it instantly).
export const EDGE_CACHE_STORE_CONTROL = "public, max-age=300";

const EXACT_PATHS = new Set([
  "/",
  "/audiobooks",
  "/merch",
  "/clubs",
  "/meet-the-cast",
]);
const PREFIX_PATHS = ["/audiobooks/", "/books/", "/meet-the-cast/"];

export function isEdgeCacheablePath(pathname: string): boolean {
  let p = String(pathname || "");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (EXACT_PATHS.has(p)) return true;
  for (const prefix of PREFIX_PATHS) {
    if (p.startsWith(prefix)) {
      const rest = p.slice(prefix.length);
      // One segment only: a book, audiobook, or character slug.
      if (rest && !rest.includes("/")) return true;
    }
  }
  return false;
}

// Any session at all (the admin session cookie, or any better-auth
// cookie under the "bbs" prefix) takes the request out of the shared
// cache entirely: personalized HTML is never stored and never served
// from it.
export function hasSessionCookie(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  for (const part of cookieHeader.split(";")) {
    const name = part.trim().split("=")[0]?.trim() || "";
    if (name === "admin_session") return true;
    if (name.startsWith("bbs.") || name.startsWith("__Secure-bbs.") || name.startsWith("__Host-bbs.")) {
      return true;
    }
  }
  return false;
}
