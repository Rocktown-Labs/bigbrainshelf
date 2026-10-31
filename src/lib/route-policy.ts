// Declarative route policy for /api/* and /admin/* routes.
// Centralizes access tiers so adding customer-facing endpoints does not
// require fragile manual edits across middleware allowlists.

export type ApiAccessTier = "public" | "customer_self_auth" | "service_token" | "admin";

export const PUBLIC_API_EXACT: ReadonlySet<string> = new Set([
  "/api/stripe/webhook",
  "/api/subscribe",
  "/api/contact",
  "/api/unsubscribe",
  "/api/review-media",
  "/api/order-download",
]);

export const PUBLIC_API_PREFIXES: readonly string[] = [
  "/api/admin-auth/",
  "/api/auth/",
  "/api/sample/",
  "/api/audio-sample/",
];

export const CUSTOMER_SELF_AUTH_API_ROUTES: ReadonlySet<string> = new Set([
  "/api/club-signup",
  "/api/club/checkout",
  "/api/club/selection",
  "/api/reviews",
  "/api/checkout",
  "/api/download",
  "/api/account/family",
  "/api/account/progress",
  "/api/account/book-pages",
  "/api/account/me",
]);

export const CUSTOMER_SELF_AUTH_PREFIXES: readonly string[] = [
  "/api/library/audio/",
  "/api/library/page/",
  "/api/account/",
];

export const SERVICE_TOKEN_API_ROUTES: ReadonlySet<string> = new Set([
  "/api/lift/worker",
]);

export function classifyApiRoute(
  pathname: string,
  method: string,
  searchParams: URLSearchParams
): ApiAccessTier {
  const upperMethod = (method || "GET").toUpperCase();

  if (pathname === "/api/books" && upperMethod === "GET") {
    const status = searchParams.get("status");
    if (status === "complete" || searchParams.get("scope") === "cart") {
      return "public";
    }
  }

  if (pathname === "/api/search" && upperMethod === "GET") {
    return "public";
  }

  if (PUBLIC_API_EXACT.has(pathname)) {
    return "public";
  }

  for (const prefix of PUBLIC_API_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      return "public";
    }
  }

  if (CUSTOMER_SELF_AUTH_API_ROUTES.has(pathname)) {
    return "customer_self_auth";
  }

  for (const prefix of CUSTOMER_SELF_AUTH_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      return "customer_self_auth";
    }
  }

  if (SERVICE_TOKEN_API_ROUTES.has(pathname)) {
    return "service_token";
  }

  return "admin";
}

export function isLocalDevHostname(hostname: string): boolean {
  const h = (hostname || "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".local");
}
