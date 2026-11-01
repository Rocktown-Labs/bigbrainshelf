// Safe `next`/`redirectTo` handling for the auth surfaces (F10,
// 2026-10-31). The login, signup, and post-sign-in landing pages used
// to accept next=//evil.com (protocol-relative) and /\\evil.com (the
// backslash trick browsers normalize into a foreign origin), which
// redirected a just-authenticated visitor to an attacker's site.
//
// One rule everywhere: a `next` is only honored when it is a
// same-origin path — starts with "/", is not "//" or "/\", carries no
// control characters, and does not point at a blocked prefix (the
// auth pages themselves, /admin for customers). Anything else falls
// back to the caller's default.

const MAX_LEN = 512;

export function isSafeNextPath(p: string): boolean {
  if (!p || !p.startsWith("/")) return false;
  // "//host" is protocol-relative; "/\host" is normalized to a
  // foreign origin by forgiving URL parsers.
  if (p[1] === "/" || p[1] === "\\") return false;
  // No backslash tricks anywhere, no CR/LF/tab (response splitting).
  if (/[\\\r\n\t]/.test(p)) return false;
  if (p.length > MAX_LEN) return false;
  return true;
}

/**
 * Resolve a client-supplied `next` to a safe same-origin path.
 * `blocked` lists path prefixes that must not round-trip (for
 * example "/login", "/admin", "/signup").
 */
export function safeNextPath(
  raw: string | null | undefined,
  fallback: string,
  blocked: readonly string[] = []
): string {
  const p = String(raw || "");
  if (!isSafeNextPath(p)) return fallback;
  for (const b of blocked) {
    if (!b) continue;
    if (p === b || p.startsWith(b + "/") || p.startsWith(b + "?")) return fallback;
  }
  return p;
}
