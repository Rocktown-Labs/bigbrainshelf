// The store owner's addresses. Both carry full admin rights: the
// hand-rolled admin session, the Google owner flow, and the
// better-auth role hook all key on this one list.
export const ADMIN_EMAILS = [
  "rocktownlabs@gmail.com",
  "cg@rocktownlabs.com",
  // CG's personal Gmail (2026-10-31: scoped to him on request;
  // it is the account his store test orders run under).
  "camstewart7@gmail.com",
];

// The daily admin urgency digest is delivered only to these two
// addresses (CG, 2026-11-18: it was landing in all three admin
// inboxes). ADMIN_EMAILS above still governs admin access; this
// list governs digest delivery only.
export const ADMIN_DIGEST_EMAILS = [
  "cg@rocktownlabs.com",
  "camstewart7@gmail.com",
];

export function isAdminEmail(email?: string | null): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.toLowerCase());
}
