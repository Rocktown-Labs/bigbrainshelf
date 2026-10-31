// Shippo tests: parcel building (CG's weights, combined across items),
// rate selection (cheapest USPS/UPS that is not absurdly slow), the
// sender origin (STREET1 + phone/email), the missing-config checklist,
// and stored-address completeness. Run with: bun tests/shippo.test.ts
import {
  PARCEL_BY_FORMAT,
  parcelForItems,
  pickRate,
  chooseRate,
  rateDays,
  shippoOrigin,
  shippoMissing,
  shippoStatus,
  shippoConfigured,
  missingAddressFields,
  type ShippoRate,
} from "../src/lib/shippo";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}
function eq(a: any, b: any) { return JSON.stringify(a) === JSON.stringify(b); }

// --- Parcels -------------------------------------------------------------
{
  const printed = parcelForItems([{ format: "printed" }]);
  assert(
    eq(printed, { length: "11.25", width: "8.75", height: "0.75", distance_unit: "in", weight: "2", mass_unit: "lb" }),
    "parcel: one printed book is 11.25x8.75x0.75 at 2 lb"
  );
  const gift = parcelForItems([{ format: "giftset" }]);
  assert(
    eq(gift, { length: "12", width: "9", height: "3", distance_unit: "in", weight: "3", mass_unit: "lb" }),
    "parcel: one gift set is 12x9x3 at 3 lb"
  );
  const twoPrinted = parcelForItems([{ format: "printed" }, { format: "printed" }]);
  assert(twoPrinted.weight === "4" && twoPrinted.height === "1.5", "parcel: two printed books combine to 4 lb and stack to 1.5 in");
  const mixed = parcelForItems([{ format: "printed" }, { format: "giftset" }, { format: "digital" }, { format: "audio" }]);
  assert(
    mixed.weight === "5" && mixed.length === "12" && mixed.width === "9" && mixed.height === "3.75",
    "parcel: mixed order sums physical weights (2+3=5 lb), takes the largest footprint, ignores digital/audio"
  );
  assert(PARCEL_BY_FORMAT.printed.weight === "2" && PARCEL_BY_FORMAT.giftset.weight === "3", "parcel constants carry CG's few-pounds weights");
}

// --- Rate selection --------------------------------------------------------
function rate(provider: string, amount: string, days: number | null, token = "svc"): ShippoRate {
  return { object_id: `${provider}-${amount}-${days}`, provider, servicelevel: { name: token, token }, amount, currency: "USD", estimated_days: days };
}
{
  const best = pickRate([rate("UPS", "12.00", 3), rate("USPS", "8.50", 4), rate("FedEx", "5.00", 2)]);
  assert(best?.provider === "USPS" && best.amount === "8.50", "rates: cheapest USPS/UPS wins, cheaper FedEx ignored");

  const slowCheap = pickRate([rate("USPS", "4.00", 14), rate("UPS", "9.00", 3)]);
  assert(slowCheap?.provider === "UPS", "rates: a 14-day rate loses to a faster one even when cheaper");

  const allSlow = pickRate([rate("USPS", "4.00", 14), rate("UPS", "9.00", 12)]);
  assert(allSlow?.provider === "USPS" && allSlow.amount === "4.00", "rates: when every rate is slow, the cheapest slow rate wins");

  const unknownDays = pickRate([rate("USPS", "6.00", null), rate("UPS", "9.00", 2)]);
  assert(unknownDays?.provider === "USPS", "rates: unknown delivery estimate counts as timely");

  const noCarrier = pickRate([rate("FedEx", "7.00", 2), rate("DHL", "9.00", 1)]);
  assert(noCarrier?.provider === "FedEx", "rates: falls back to all carriers when no USPS/UPS rate exists");

  assert(pickRate([]) === null, "rates: empty list picks nothing");
}

// --- Origin + checklist ----------------------------------------------------
const FULL_ENV = {
  SHIPPO_API_KEY: "shippo_test_x",
  SHIPPO_FROM_NAME: "Big Brain Shelf",
  SHIPPO_FROM_STREET1: "100 Main St",
  SHIPPO_FROM_CITY: "Searcy",
  SHIPPO_FROM_STATE: "AR",
  SHIPPO_FROM_ZIP: "72143",
  SHIPPO_FROM_PHONE: "5015551234",
  SHIPPO_FROM_EMAIL: "orders@bigbrainshelf.com",
};
{
  assert(shippoConfigured({}) === false && shippoConfigured(FULL_ENV) === true, "config: configured follows the key only");
  assert(eq(shippoMissing({}), ["SHIPPO_API_KEY", "SHIPPO_FROM_NAME", "SHIPPO_FROM_STREET1", "SHIPPO_FROM_CITY", "SHIPPO_FROM_STATE", "SHIPPO_FROM_ZIP", "SHIPPO_FROM_PHONE", "SHIPPO_FROM_EMAIL"]), "checklist: empty env lists all eight pieces in order");
  assert(eq(shippoMissing(FULL_ENV), []), "checklist: full env misses nothing");
  assert(eq(shippoMissing({ SHIPPO_API_KEY: "k", SHIPPO_FROM_ZIP: "72143" }), ["SHIPPO_FROM_NAME", "SHIPPO_FROM_STREET1", "SHIPPO_FROM_CITY", "SHIPPO_FROM_STATE", "SHIPPO_FROM_PHONE", "SHIPPO_FROM_EMAIL"]), "checklist: partial env lists exactly the unset pieces");
  assert(eq(shippoMissing({ ...FULL_ENV, SHIPPO_FROM_PHONE: "  " }), ["SHIPPO_FROM_PHONE"]), "checklist: whitespace-only values count as missing");

  const status = shippoStatus(FULL_ENV);
  assert(status.configured && status.originConfigured && status.ready, "status: full env is ready");
  const bare = shippoStatus({});
  assert(!bare.configured && !bare.originConfigured && !bare.ready, "status: empty env is not ready");

  const origin = shippoOrigin(FULL_ENV);
  assert(origin?.street1 === "100 Main St" && origin?.phone === "5015551234" && origin?.email === "orders@bigbrainshelf.com" && origin?.country === "US", "origin: STREET1 + phone + email ride along");
  assert(shippoOrigin({ ...FULL_ENV, SHIPPO_FROM_STREET1: "", SHIPPO_FROM_STREET: "200 Legacy Rd" })?.street1 === "200 Legacy Rd", "origin: legacy STREET spelling still works as fallback");
  assert(shippoOrigin({ SHIPPO_FROM_NAME: "X" }) === null, "origin: incomplete address returns null");
  assert(shippoOrigin({ ...FULL_ENV, SHIPPO_FROM_PHONE: "", SHIPPO_FROM_EMAIL: "" }) !== null, "origin: phone/email are not required for the address itself");
}

// --- Stored address completeness -------------------------------------------
{
  assert(eq(missingAddressFields(null), ["line1", "city", "state", "postal_code"]), "address: no address misses everything");
  assert(eq(missingAddressFields({ line1: "1 A St", city: "Searcy", state: "AR", postal_code: "72143" }), []), "address: a full Stripe address misses nothing");
  assert(eq(missingAddressFields({ line1: "1 A St", city: "Searcy" }), ["state", "postal_code"]), "address: partial address names the missing fields");
}

// --- Fulfillment rate rule (chooseRate, owner 2026-10-29): 2-day
// shipping, whichever is cheaper between USPS and UPS. -------------
{
  // Cheapest 2-day USPS/UPS wins; a cheaper slower rate is ignored,
  // and a cheap 2-day rate from another carrier is ignored.
  const two = chooseRate([rate("USPS", "6.00", 3), rate("UPS", "11.00", 2), rate("USPS", "9.50", 2), rate("FedEx", "4.00", 1)]);
  assert(two.twoDay === true && two.rate?.provider === "USPS" && two.rate?.amount === "9.50", "chooseRate: cheapest 2-day USPS/UPS wins over cheaper slower and other carriers");

  // No 2-day option: fall back to the cheapest USPS/UPS overall and
  // say so (twoDay: false) so the UI can surface it.
  const fb = chooseRate([rate("USPS", "6.00", 3), rate("UPS", "8.00", 4), rate("FedEx", "3.00", 5)]);
  assert(fb.twoDay === false && fb.rate?.provider === "USPS" && fb.rate?.amount === "6.00", "chooseRate: no 2-day rate falls back to cheapest USPS/UPS with the flag off");

  // delivery_days is honored over estimated_days when both exist.
  const dd: ShippoRate = { ...rate("UPS", "10.00", 6), delivery_days: 2 };
  const ddPick = chooseRate([rate("USPS", "7.00", 3), dd]);
  assert(ddPick.twoDay === true && ddPick.rate?.provider === "UPS", "chooseRate: delivery_days=2 qualifies even when estimated_days is slower");
  assert(rateDays(dd) === 2 && rateDays(rate("USPS", "1.00", 5)) === 5 && rateDays(rate("USPS", "1.00", null)) === null, "rateDays: delivery_days first, then estimated_days, then null");

  // A rate with unknown days is not a 2-day rate.
  const unk = chooseRate([rate("USPS", "5.00", null), rate("UPS", "9.00", 2)]);
  assert(unk.twoDay === true && unk.rate?.provider === "UPS", "chooseRate: unknown-days rates never count as 2-day");

  // No USPS/UPS rates at all: nothing to buy.
  const none = chooseRate([rate("FedEx", "4.00", 1), rate("DHL", "3.00", 1)]);
  assert(none.rate === null && none.twoDay === false, "chooseRate: USPS/UPS only, empty pool yields null");
}

if (failures) { console.error(failures + " shippo test(s) failed"); process.exit(1); }
console.log("All shippo tests passed.");
