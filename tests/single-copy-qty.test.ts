// Single-copy quantity tests (CG's probe, 2026-10-31): a 2x digital
// line charged $17.98 for one deliverable on a book the account
// already owned. Digital and audio are owned once and there is no
// gifting flow, so their quantity is always 1. The rule is enforced
// in the cart store (client), at checkout (server, whatever the
// client sent), and the sheet renders no stepper for those formats.
// parseItems deliberately does NOT clamp: a historical order keeps
// reading exactly what it charged, so receipts stay reconciled.
// Run with: bun tests/single-copy-qty.test.ts
import { readFileSync } from "node:fs";
import { isSingleCopyFormat, lineQty, parseItems } from "../src/lib/orders";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else {
    failures += 1;
    console.error("FAIL:", label);
  }
}

assert(isSingleCopyFormat("digital") && isSingleCopyFormat("audio"), "digital and audio are single-copy");
assert(!isSingleCopyFormat("printed") && !isSingleCopyFormat("giftset"), "printed and gift set keep quantities");

assert(lineQty({ format: "digital", qty: 5 }) === 1, "digital qty 5 clamps to 1");
assert(lineQty({ format: "audio", qty: 3 }) === 1, "audio qty 3 clamps to 1");
assert(lineQty({ format: "printed", qty: 3 }) === 3, "printed qty 3 stays 3");
assert(lineQty({ format: "giftset", qty: 2 }) === 2, "gift set qty 2 stays 2");
assert(lineQty({ format: "weird", qty: 4 }) === 1, "unknown format normalizes to digital and clamps");
assert(lineQty({ format: "digital" }) === 1, "digital with no qty is 1");
assert(lineQty({ format: "printed", qty: 0 }) === 1, "printed qty 0 reads as 1");
assert(lineQty(null) === 1 && lineQty(undefined) === 1, "nullish item reads as 1");

// History is not rewritten: stored orders keep their charged qty.
const legacy = parseItems({
  items: JSON.stringify([{ slug: "mastery", format: "digital", qty: 2 }]),
});
assert(legacy.length === 1 && legacy[0].qty === 2, "parseItems preserves a stored qty (receipts reconcile)");

// Enforcement points stay wired.
const checkoutSrc = readFileSync(new URL("../src/pages/api/checkout.ts", import.meta.url), "utf8");
assert(checkoutSrc.includes("lineQty({ format, qty: x?.qty })"), "checkout clamps wanted items via lineQty");
assert(checkoutSrc.includes("quantity: lineQty(w)"), "Stripe line quantity uses lineQty");
const storeSrc = readFileSync(new URL("../src/components/CartStore.astro", import.meta.url), "utf8");
assert(storeSrc.includes("function clampFor(format, q)"), "cart store clamps per format");
const sheetSrc = readFileSync(new URL("../src/components/CartSheet.astro", import.meta.url), "utf8");
assert(
  sheetSrc.includes('it.format === "printed" || it.format === "giftset"') && sheetSrc.includes("var stepper"),
  "cart sheet renders steppers only for physical formats"
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
