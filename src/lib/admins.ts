// The store owner's addresses. Both carry full admin rights: the
// hand-rolled admin session, the Google owner flow, and the
// better-auth role hook all key on this one list.
export const ADMIN_EMAILS = [
  "rocktownlabs@gmail.com",
  "cg@rocktownlabs.com",
];

export function isAdminEmail(email?: string | null): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.toLowerCase());
}
