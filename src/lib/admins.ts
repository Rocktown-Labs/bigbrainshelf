// The store owner's addresses. All three key the hand-rolled admin
// session, the Google owner flow, and admin recognition for
// better-auth sessions — but only for a VERIFIED email (F2,
// 2026-10-31): a password account that merely registers an owner
// address never gets admin. The sign-up role hook is gone; the role
// lives in D1 and self-heals on the next verified owner sign-in.
export const ADMIN_EMAILS = [
  "rocktownlabs@gmail.com",
  "cg@rocktownlabs.com",
  // CG's personal Gmail (2026-10-31: scoped to him on request;
  // it is the account his store test orders run under).
  "camstewart7@gmail.com",
];

export function isAdminEmail(email?: string | null): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.toLowerCase());
}
