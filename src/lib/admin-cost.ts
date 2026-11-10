// Admin cost-price ordering (CG, 2026-11-10): "to prep for the real
// thing, when I place an order from my admin account, show me the
// Lulu prices in stripe, + like 3 I guess. So if I want to order a
// print, I can pay the tax and stuff here, and we can pay Lulu out."
//
// When the signed-in buyer is an admin (lib/admins.ts, server-side
// session identity only — no client flag can reach this), a cart's
// physical print lines price at Lulu's own cost for the one print
// job the cart ships as, plus a flat markup, instead of retail:
//
//   merchandise target = Lulu total_cost_incl_tax (the whole job:
//   printing + shipping + fulfilment + Lulu's tax, from Lulu's cost
//   calculation for the buyer's exact destination)
//                      + ADMIN_COST_MARKUP_CENTS, ONCE per job.
//
// Per-job, not per book: a single printed book is one job; a gift
// set (story + coloring in one job) takes the markup once; a club
// box is not priced here at all (membership lines are untouched,
// and box jobs are built later by the club flow). Digital and audio
// lines always price by the ordinary rules. The shipping charge in
// this mode is $0 — Lulu's shipping already sits inside the job
// cost, so charging the shipping option too would double-count it.
// Stripe Tax (when enabled) taxes the resulting lines as usual.
//
// The target is distributed across the physical lines in proportion
// to their retail line totals, in whole cents, exactly: the sum of
// the Stripe line amounts always equals the target to the cent.
// A line whose share does not divide evenly by its quantity splits
// into two unit-price groups (qty-1 at the lower unit, the rest one
// cent up), so per-unit amounts never round the total off.

import { isAdminEmail } from "./admins";

export const ADMIN_COST_MARKUP_CENTS = 300;
export const PRICING_MODE_ADMIN_COST = "admin_cost";

/** The gate: a session user whose email is on the admin list. */
export function isAdminBuyer(user: { email?: string | null } | null | undefined): boolean {
  return !!user && isAdminEmail(user.email);
}

/** The merchandise target for one print job at Lulu cost + markup. */
export function adminCostTargetCents(luluTotalInclTaxCents: number): number {
  return Math.max(0, Math.round(luluTotalInclTaxCents)) + ADMIN_COST_MARKUP_CENTS;
}

export interface AdminCostLineInput {
  /** Stable key of the cart line (slug + format). */
  key: string;
  /** Retail unit price in cents (the allocation weight). */
  retailUnitCents: number;
  qty: number;
}

export interface AdminCostUnitGroup {
  key: string;
  unitCents: number;
  qty: number;
}

/**
 * Distribute `targetCents` across lines proportionally to retail
 * line totals. Returns unit-price groups per line (one group per
 * line, two when the line's share is not divisible by its qty).
 * Invariant: sum(unitCents * qty) over all groups === targetCents.
 */
export function allocateAdminCost(
  lines: AdminCostLineInput[],
  targetCents: number
): AdminCostUnitGroup[] {
  const usable = lines.filter((l) => l.qty > 0);
  if (!usable.length) return [];
  const weights = usable.map((l) => Math.max(0, l.retailUnitCents) * l.qty);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  // Shares: floor of the proportional split, with the leftover cents
  // handed one each to the largest lines until the shares sum to
  // the target exactly.
  const shares = usable.map((l, i) =>
    totalWeight > 0 ? Math.floor((targetCents * weights[i]) / totalWeight) : 0
  );
  if (totalWeight === 0) {
    // No retail weight to proportion by (should not happen: a
    // physical line only reaches pricing with a positive retail
    // price). Split evenly so the total still lands exact.
    const base = Math.floor(targetCents / usable.length);
    for (let i = 0; i < shares.length; i++) shares[i] = base;
  }
  let leftover = targetCents - shares.reduce((a, b) => a + b, 0);
  const order = usable
    .map((_, i) => i)
    .sort((a, b) => weights[b] - weights[a] || a - b);
  for (let k = 0; leftover > 0; k = (k + 1) % order.length) {
    shares[order[k]] += 1;
    leftover -= 1;
  }
  const groups: AdminCostUnitGroup[] = [];
  usable.forEach((l, i) => {
    const share = shares[i];
    const unit = Math.floor(share / l.qty);
    const rem = share - unit * l.qty;
    if (rem === 0) {
      groups.push({ key: l.key, unitCents: unit, qty: l.qty });
    } else {
      // rem units carry one extra cent; the rest sit at the floor.
      groups.push({ key: l.key, unitCents: unit + 1, qty: rem });
      groups.push({ key: l.key, unitCents: unit, qty: l.qty - rem });
    }
  });
  return groups;
}
