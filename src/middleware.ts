import { env } from "cloudflare:workers";
import { defineMiddleware } from "astro:middleware";
import { isAdminEmail } from "./lib/admins";
import { getAuth } from "./lib/auth";
import { classifyApiRoute, isLocalDevHostname } from "./lib/route-policy";
import { reportErrorToSentry } from "./lib/sentry";
import {
  isEdgeCacheablePath,
  hasSessionCookie,
  EDGE_CACHE_CONTROL,
  EDGE_CACHE_STORE_CONTROL,
} from "./lib/edge-cache";

// Simple signed session cookie. Value: base64(payload).base64(signature)
// Payload: { email, exp }. Signature: HMAC-SHA256(payload, secret).

async function sign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function verifySession(cookie: string | null, secret: string): Promise<string | null> {
  if (!cookie) return null;
  try {
    const [payloadB64, sigB64] = cookie.split(".");
    if (!payloadB64 || !sigB64) return null;
    const expected = await sign(payloadB64, secret);
    if (expected !== sigB64) return null;
    const payload = JSON.parse(atob(payloadB64));
    if (payload.exp < Date.now() / 1000) return null;
    if (!isAdminEmail(payload.email)) return null;
    return payload.email;
  } catch {
    return null;
  }
}

export async function createSession(email: string, secret: string): Promise<string> {
  const payload = btoa(JSON.stringify({
    email,
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600, // 7 days
  }));
  const sig = await sign(payload, secret);
  return `${payload}.${sig}`;
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

const gate = async (context: any, next: any) => {
  const pathname = context.url.pathname;
  const e = env as any;
  const secret = e?.BETTER_AUTH_SECRET;

  // Without secret, only skip auth on local dev hostnames.
  if (!secret) {
    context.locals.user = null;
    if (!isLocalDevHostname(context.url.hostname) && (pathname.startsWith("/admin") || pathname.startsWith("/api/"))) {
      return new Response(JSON.stringify({ error: "Auth secret not configured" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    return next();
  }

  const sessionCookie = getCookie(context.request, "admin_session");
  let email = await verifySession(sessionCookie, secret);

  // Unified auth bridge: if no legacy admin_session cookie is present on an
  // admin route, also accept a valid better-auth session for an admin email.
  if (!email && (pathname.startsWith("/admin") || pathname.startsWith("/api/")) && hasSessionCookie(context.request.headers.get("Cookie"))) {
    try {
      const s = await getAuth().api.getSession({ headers: context.request.headers });
      if (s?.user?.email && isAdminEmail(s.user.email)) {
        email = s.user.email;
      }
    } catch {
      // Fall through to standard admin check
    }
  }

  context.locals.user = email ? { email } : null;

  // Protect /admin/* (except the password reset page). Sign-in is unified
  // at /login, which routes owners here and customers to their library.
  if (pathname.startsWith("/admin")) {
    const isReset = pathname === "/admin/reset-password" || pathname === "/admin/reset-password/";
    const isLogin = pathname === "/admin/login" || pathname === "/admin/login/";
    if (isLogin) {
      return context.redirect(email ? "/admin" : "/login?next=/admin", 302);
    }
    if (!email && !isReset) {
      return context.redirect("/login?next=" + encodeURIComponent(pathname), 302);
    }
    return next();
  }

  // Protect /api/* write operations (GET /api/books stays public in
  // its two read scopes: the storefront catalog, ?status=complete,
  // and cart resolution, ?scope=cart)
  if (pathname.startsWith("/api/")) {
    if (pathname === "/api/books" && context.request.method === "GET") {
      const status = context.url.searchParams.get("status");
      if (status === "complete" || context.url.searchParams.get("scope") === "cart") return next();
    }
    // Auth endpoints stay public (login/logout, Google start + OAuth callback)
    if (pathname.startsWith("/api/admin-auth/")) return next();
    // Better-auth customer endpoints (signup/signin/session) are public by design.
    // /api/auth/callback/google (admin Google OAuth) is a more specific file
    // route and still wins for that path.
    if (pathname.startsWith("/api/auth/")) return next();
    // Stripe webhook must be reachable by Stripe's servers (verified by signature).
    if (pathname === "/api/stripe/webhook") return next();
    // Lulu webhook must be reachable by Lulu's servers (verified by HMAC signature).
    if (pathname === "/api/lulu/webhook") return next();
    // Newsletter subscribe is a public form (email capture for new releases).
    if (pathname === "/api/subscribe") return next();
    // Funnel mirror beacon: public by design (browser analytics
    // beacons are unauthenticated); the route allowlists event names
    // and stores no personal data.
    if (pathname === "/api/collect") return next();
    // Contact form submit is public (it only enqueues an email to
    // the store; Turnstile-gated when configured, like subscribe).
    if (pathname === "/api/contact") return next();
    // Book Club waitlist signup: the route itself requires the
    // customer's better-auth session (the waitlist takes an account,
    // like the paid join), so it passes through to self-authenticate.
    if (pathname === "/api/club-signup") return next();
    // Book Club paid join: the route itself requires the customer's
    // better-auth session (membership requires an account), exactly
    // like /api/checkout.
    if (pathname === "/api/club/checkout") return next();
    // Book Club book choice (V2): the route authenticates the customer
    // itself (better-auth session) and only ever touches that member's
    // own cycles.
    if (pathname === "/api/club/selection") return next();
    // Marketing unsubscribe: the tokened link from club emails must
    // work for people who may not be signed in (or have no account).
    if (pathname === "/api/unsubscribe") return next();
    // Review submission authenticates the customer itself (better-auth
    // session inside the route), like checkout and downloads.
    if (pathname === "/api/reviews") return next();
    // Review media: the route itself only serves media belonging to an
    // APPROVED review, so pending review photos/videos stay unreachable.
    if (pathname === "/api/review-media") return next();
    // Free book samples: the route only ever serves the first 5
    // defect-free pages of a book, screened in src/lib/sample.ts.
    if (pathname.startsWith("/api/sample/")) return next();
    // Free audio samples: the route only ever serves the introduction
    // and chapter 1 of a complete book's audiobook; every other track
    // 404s there. No entitlement is involved by design (the listening
    // sample mirrors the 5-page book sample).
    if (pathname.startsWith("/api/audio-sample/")) return next();
    // Site search: GET-only route over the public catalog (published
    // books, the public cast, audiobook availability). No writes, no
    // private data; the route itself only reads status=complete rows.
    if (pathname === "/api/search" && context.request.method === "GET") return next();
    // Emailed download links carry their own per-order token credential.
    if (pathname === "/api/order-download") return next();
    // Checkout and library downloads authenticate the customer themselves
    // (better-auth session inside the route). Without this pass they were
    // unreachable for anyone but the admin, because this gate only knows
    // the admin session cookie.
    if (pathname === "/api/checkout" || pathname === "/api/download") return next();
    // Customer library audio streaming: the route authenticates the
    // customer itself (better-auth session) and checks digital
    // ownership of the book before serving a single byte.
    if (pathname.startsWith("/api/library/audio/")) return next();
    // Customer reader page images: the route authenticates the
    // customer itself (better-auth session) and checks digital
    // ownership of the book before serving a single byte, exactly
    // like the audio streaming above.
    if (pathname.startsWith("/api/library/page/")) return next();
    // Lift worker service: the VM-side matte pipeline claims and
    // completes jobs here; the route verifies the LIFT_WORKER_TOKEN
    // bearer secret on every call.
    if (pathname === "/api/lift/worker") return next();
    // Lulu print-file fetches: the route authenticates by its
    // unguessable per-file token (lib/print-fulfillment), the same
    // shape as the lift worker's bearer check.
    if (pathname.startsWith("/api/print-file/")) return next();
    const routeTier = classifyApiRoute(pathname, context.request.method, context.url.searchParams);
    if (routeTier !== "admin") return next();
    if (!email) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      });
    }
  }

  return next();
};

// Edge cache for the anonymous public pages (see lib/edge-cache.ts
// for the allowlist and the rules). Only GET requests to allowlisted
// paths with NO session cookie participate, on read and on write, so
// personalized HTML can never enter or leave the shared cache. The
// gate below still runs for every miss.
async function withEdgeCache(context: any, runGate: () => Promise<Response>): Promise<Response> {
  const req: Request = context.request;
  const pathname: string = context.url.pathname;
  const cacheable =
    req.method === "GET" &&
    isEdgeCacheablePath(pathname) &&
    !hasSessionCookie(req.headers.get("Cookie"));
  const cache =
    cacheable && typeof caches !== "undefined" ? (caches as any).default : null;
  if (!cache) return runGate();
  const key = new Request(new URL(pathname, context.url.origin).toString(), {
    method: "GET",
  });
  const hit = await cache.match(key).catch(() => null);
  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set("Cache-Control", EDGE_CACHE_CONTROL);
    headers.set("X-BBS-Edge-Cache", "hit");
    return new Response(hit.body, { status: hit.status, headers });
  }
  const res = await runGate();
  const type = res.headers.get("Content-Type") || "";
  if (res.status !== 200 || !type.includes("text/html") || res.headers.get("Set-Cookie")) {
    return res;
  }
  const stored = new Response(res.clone().body, {
    status: 200,
    headers: new Headers(res.headers),
  });
  stored.headers.set("Cache-Control", EDGE_CACHE_STORE_CONTROL);
  stored.headers.delete("Set-Cookie");
  const put = cache.put(key, stored).catch(() => {});
  if (typeof (context as any).waitUntil === "function") {
    (context as any).waitUntil(put);
  } else {
    await put;
  }
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", EDGE_CACHE_CONTROL);
  headers.set("X-BBS-Edge-Cache", "miss");
  return new Response(res.body, { status: res.status, headers });
}

// Worker-side error logging: an unhandled error anywhere below this
// middleware is reported to Sentry (only when SENTRY_DSN is set on
// the worker) and then rethrown so Astro's own error handling, and
// the response the visitor gets, stay exactly as they were.
export const onRequest = defineMiddleware(async (context, next) => {
  try {
    return await withEdgeCache(context, () => gate(context, next));
  } catch (err) {
    const dsn = (env as any)?.SENTRY_DSN;
    if (dsn) {
      const report = reportErrorToSentry(dsn, err, {
        path: context.url.pathname,
        method: context.request.method,
      });
      if (typeof (context as any).waitUntil === "function") {
        (context as any).waitUntil(report);
      } else {
        report.catch(() => {});
      }
    }
    throw err;
  }
});
