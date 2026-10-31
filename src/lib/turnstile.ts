// Cloudflare Turnstile verification for the public newsletter form.
//
// Keys live in the worker env: TURNSTILE_SITE_KEY (public, rendered
// into the footer form) and TURNSTILE_SECRET_KEY (server only, used
// here). Enforcement is all-or-nothing: it is ON only when BOTH keys
// are set, so an environment without keys behaves exactly like the
// pre-Turnstile form; once the keys exist, every subscribe must carry
// a token Cloudflare verifies. Verification fails closed: a missing
// token, a rejected token, or an unreachable siteverify endpoint all
// count as "not verified".

export const TURNSTILE_FAILED_MESSAGE = "Please complete the check and try again.";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function turnstileSiteKey(e: any): string {
  return String(e?.TURNSTILE_SITE_KEY || "").trim();
}

export function turnstileEnforced(e: any): boolean {
  return Boolean(turnstileSiteKey(e) && String(e?.TURNSTILE_SECRET_KEY || "").trim());
}

export async function verifyTurnstileToken(
  e: any,
  token: unknown,
  remoteIp?: string | null
): Promise<boolean> {
  const secret = String(e?.TURNSTILE_SECRET_KEY || "").trim();
  const response = String(token || "").trim();
  if (!secret || !response) return false;
  try {
    const form = new URLSearchParams();
    form.set("secret", secret);
    form.set("response", response);
    if (remoteIp) form.set("remoteip", remoteIp);
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body: form });
    if (!res.ok) return false;
    const data: any = await res.json().catch(() => null);
    return data?.success === true;
  } catch {
    return false;
  }
}
