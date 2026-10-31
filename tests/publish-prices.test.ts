// Focused tests for the publish price stamp (src/lib/offers.ts).
// Publishing a book fills any 0/NULL price with the standard price and
// never overwrites a set price, so no book can go live sellable at $0.
// Run with: bun tests/publish-prices.test.ts
import {
  STANDARD_DIGITAL_PRICE_CENTS,
  STANDARD_PRINT_PRICE_CENTS,
  GIFT_SET_PRICE_CENTS,
  publishPriceStamp,
} from "../src/lib/offers";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}
function stampEq(
  input: { price?: number | null; price_print?: number | null },
  price: number,
  pricePrint: number,
  label: string
) {
  const s = publishPriceStamp(input);
  assert(s.price === price && s.price_print === pricePrint, label);
}

// Constants are the single source of the standard ladder.
assert(STANDARD_DIGITAL_PRICE_CENTS === 899, "standard digital price is 899");
assert(STANDARD_PRINT_PRICE_CENTS === 2000, "standard print price is 2000");
assert(GIFT_SET_PRICE_CENTS === 2500, "gift set price still 2500");

// Unset fields get stamped (the six 0/0 ready_for_qa books' case).
stampEq({ price: 0, price_print: 0 }, 899, 2000, "0/0 stamps to 899/2000");
stampEq({ price: null, price_print: null }, 899, 2000, "NULL/NULL stamps to 899/2000");
stampEq({}, 899, 2000, "missing fields stamp to 899/2000");

// Each field stamps independently.
stampEq({ price: 0, price_print: 2000 }, 899, 2000, "only digital filled when print is set");
stampEq({ price: 899, price_print: 0 }, 899, 2000, "only print filled when digital is set");
stampEq({ price: null, price_print: 2000 }, 899, 2000, "NULL digital filled, set print kept");

// Set prices are deliberate and survive publishing untouched.
stampEq({ price: 899, price_print: 2000 }, 899, 2000, "standard prices pass through (Mira)");
stampEq({ price: 1299, price_print: 2499 }, 1299, 2499, "custom prices preserved");
stampEq({ price: 699, price_print: 2000 }, 699, 2000, "non-zero stale price preserved by the mechanism (never overwrite)");

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nAll publish price tests passed.");
