// Stripe Tax wiring (CG, 2026-11-10): every checkout session this
// store creates carries product tax codes on its lines from today,
// and automatic_tax stays behind the TAX_ENABLED worker flag.
//
// Why the flag still gates: Stripe rejects a session outright when
// automatic_tax is enabled but Stripe Tax is not activated on the
// account, so the code must never send automatic_tax before CG has
// done the dashboard activation (Settings -> Tax) and added the
// Arkansas registration. With the flag off, sessions are created
// exactly as before (the tax codes ride along harmlessly; Stripe
// ignores them without Tax). Once CG activates Tax in the dashboard
// and sets TAX_ENABLED=1 on the worker, the same code collects tax
// on every checkout with no further change.
//
// The codes are Stripe's standard product tax codes
// (docs.stripe.com/tax/tax-codes), picked per line kind:
//   printed book / gift set  txcd_35010001  Books for Children
//                            (children's picture, painting and
//                            activity books — both gift set parts
//                            are printed books)
//   digital book             txcd_10302000  Digital Books -
//                            downloaded - permanent rights
//   audiobook                txcd_10301000  Audiobook
//   Audio Club               txcd_10302002  Digital Books -
//                            subscription - conditional rights
//                            (library access while a member)
//   Book Club                txcd_35010001  Books for Children
//                            (the recurring charge buys printed
//                            children's books shipped quarterly)
//   shipping                 txcd_92010000  Shipping and Handling
//                            Combined Charge

export const STRIPE_TAX_CODES = {
  printedBook: "txcd_35010001",
  giftSet: "txcd_35010001",
  digitalBook: "txcd_10302000",
  audiobook: "txcd_10301000",
  clubAudio: "txcd_10302002",
  clubPhysical: "txcd_35010001",
  shipping: "txcd_92010000",
} as const;

/** Tax code for a store book line, by cart format. */
export function taxCodeForBookFormat(format: string): string {
  if (format === "printed") return STRIPE_TAX_CODES.printedBook;
  if (format === "giftset") return STRIPE_TAX_CODES.giftSet;
  if (format === "audio") return STRIPE_TAX_CODES.audiobook;
  return STRIPE_TAX_CODES.digitalBook;
}

/** Tax code for a club membership line, by plan. */
export function taxCodeForClubPlan(clubPlan: string): string {
  return clubPlan === "physical"
    ? STRIPE_TAX_CODES.clubPhysical
    : STRIPE_TAX_CODES.clubAudio;
}

/**
 * Whether checkout sessions may ask Stripe to calculate tax. The
 * one gate both checkout routes read, so the flip is a single
 * worker var (TAX_ENABLED=1) after dashboard activation.
 */
export function stripeTaxEnabled(e: any): boolean {
  const v = String(e?.TAX_ENABLED || "").toLowerCase();
  return v === "1" || v === "true";
}
