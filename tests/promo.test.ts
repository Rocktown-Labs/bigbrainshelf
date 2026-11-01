// Promo codes: the launch offer (CG, 2026-11-01). FOUNDING15 is
// 15% off a first purchase of $30+, capped at 10 redemptions, and
// every redemption grants a free year of The Book Club as a comp
// membership. These tests pin the money math (exact to the cent),
// the comp semantics in the club guards, and the wiring through
// checkout, the webhook, and the receipts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  normalizePromoCode,
  promoDiscountCents,
  repriceLineItemsWithDiscount,
} from "../src/lib/promo";
import { clubMembershipActive } from "../src/lib/club";
import { clubMemberCycleEligible, clubMemberCanSelect } from "../src/lib/club-cycles";

const root = resolve(import.meta.dir, "..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

const sum = (items: any[]) =>
  items.reduce((s, li) => s + li.price_data.unit_amount * (li.quantity || 1), 0);
const line = (cents: number, qty = 1) => ({
  price_data: { currency: "usd", unit_amount: cents, product_data: { name: "Book" } },
  quantity: qty,
});

describe("promo math", () => {
  test("discount is 15% of the merchandise subtotal, rounded", () => {
    expect(promoDiscountCents(4500, 15)).toBe(675);
    expect(promoDiscountCents(3000, 15)).toBe(450);
    expect(promoDiscountCents(899, 15)).toBe(135);
    expect(promoDiscountCents(0, 15)).toBe(0);
  });

  test("codes normalize to the stored shape", () => {
    expect(normalizePromoCode(" founding15 ")).toBe("FOUNDING15");
    expect(normalizePromoCode("founding 15!")).toBe("FOUNDING15");
    expect(normalizePromoCode("")).toBe("");
  });

  test("repricing cuts the session total by exactly the discount", () => {
    const cart = [line(2500), line(2000)];
    const out = repriceLineItemsWithDiscount(cart, 675);
    expect(sum(out)).toBe(4500 - 675);
    expect(out.every((li) => li.price_data.unit_amount >= 1)).toBe(true);
  });

  test("repricing stays exact with quantities and odd cents", () => {
    const cart = [line(2000, 3), line(899), line(199)];
    const before = sum(cart); // 7098
    const discount = promoDiscountCents(before, 15); // 1065
    const out = repriceLineItemsWithDiscount(cart, discount);
    expect(sum(out)).toBe(before - discount);
    expect(out.every((li) => li.price_data.unit_amount >= 1)).toBe(true);
  });

  test("a zero discount is a no-op", () => {
    const cart = [line(899)];
    expect(repriceLineItemsWithDiscount(cart, 0)).toBe(cart);
  });
});

describe("comp membership semantics", () => {
  const now = Math.floor(Date.now() / 1000);
  const comp = (until: number) => ({
    status: "paid",
    club_plan: "physical",
    subscription_status: "comp",
    comp_until: until,
  });

  test("a comp member is active inside the window, inactive after", () => {
    expect(clubMembershipActive(comp(now + 86400))).toBe(true);
    expect(clubMembershipActive(comp(now - 1))).toBe(false);
    expect(clubMembershipActive(comp(0))).toBe(false);
  });

  test("comp members mint boxes and pick books only inside the window", () => {
    expect(clubMemberCycleEligible(comp(now + 86400))).toBe(true);
    expect(clubMemberCycleEligible(comp(now - 1))).toBe(false);
    expect(clubMemberCanSelect(comp(now + 86400))).toBe(true);
    expect(clubMemberCanSelect(comp(now - 1))).toBe(false);
  });

  test("ordinary Stripe members are untouched by the comp branch", () => {
    const stripeMember = { status: "paid", club_plan: "physical", subscription_status: "active", comp_until: null };
    expect(clubMembershipActive(stripeMember)).toBe(true);
    expect(clubMemberCycleEligible(stripeMember)).toBe(true);
  });
});

describe("promo wiring", () => {
  test("the seed offer is FOUNDING15: 15% off $30+, 10 redemptions, free year", () => {
    const src = read("src/lib/promo.ts");
    expect(src).toContain("'FOUNDING15', 15, 3000, 10, 12, 1");
    expect(src).toContain("promo_redemptions");
  });

  test("checkout validates, reprices, reserves, and stamps the session", () => {
    const src = read("src/pages/api/checkout.ts");
    expect(src).toContain("validatePromo");
    expect(src).toContain('action === "promo"');
    expect(src).toContain("repriceLineItemsWithDiscount");
    expect(src).toContain("reservePromo");
    expect(src).toContain("sessionParams.metadata.promo_code = promoApplied.code");
  });

  test("the webhook grants the free year on completion", () => {
    const src = read("src/pages/api/stripe/webhook.ts");
    expect(src).toContain("grantPromoClubYear");
  });

  test("receipts render the discount line from the order row", () => {
    expect(read("src/lib/orders.ts")).toContain("model.promo");
    expect(read("emails/OrderConfirmationEmail.tsx")).toContain("model.promo");
    expect(read("src/pages/order.astro")).toContain("model.promo");
  });

  test("the checkout page carries the promo box and repaints totals through one helper", () => {
    const src = read("src/pages/checkout.astro");
    expect(src).toContain('id="promo-input"');
    expect(src).toContain('id="promo-row"');
    expect(src).toContain("function displayTotal()");
    expect(src).toContain('action: "promo"');
  });

  test("a paid sub ending with a banked year converts instead of canceling", () => {
    const src = read("src/lib/club.ts");
    expect(src).toContain("comp_until");
    expect(src).toContain("Your free year of The Book Club has started");
    expect(read("src/lib/club-scheduler.ts")).toContain("expireCompMemberships");
  });
});
