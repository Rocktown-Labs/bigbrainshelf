// Book packing codes (CG, admin redesign S4, 2026-11-03): the short
// code on a packing line, derived from the book's public TITLE (never
// the internal slug): initials of the first three title words, a
// hyphen, then the distinctive words after "and the". Run:
// bun tests/book-codes.test.ts
import { bookCodeForTitle, catalogBookCode } from "../src/lib/catalog";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures++; console.error("FAIL:", label); }
}

// The four codes CG approved in the redesign spec.
assert(bookCodeForTitle("Mira the Heron and the Still Water") === "MTH-still-water", "Mira -> MTH-still-water");
assert(bookCodeForTitle("Juno the Swift and the Wide Sky") === "JTS-wide-sky", "Juno -> JTS-wide-sky");
assert(bookCodeForTitle("Blaze the Beaver and the Pattern Book") === "BTB-pattern-book", "Blaze -> BTB-pattern-book");
assert(bookCodeForTitle("Wells the Whale and the Great Harbor") === "WTW-great-harbor", "Wells -> WTW-great-harbor");

// The rest of the shelf, from the same rule.
assert(bookCodeForTitle("Fenix the Fox and the Clever Trails") === "FTF-clever-trails", "Fenix -> FTF-clever-trails");
assert(bookCodeForTitle("Maisie the Mouse and the Jar That Grew") === "MTM-jar-that-grew", "Maisie -> MTM-jar-that-grew");
assert(bookCodeForTitle("Penny the Squirrel and the Acorn Orchard") === "PTS-acorn-orchard", "Penny -> PTS-acorn-orchard");
assert(bookCodeForTitle("Wren the Songbird and the Gray Fog") === "WTS-gray-fog", "Wren -> WTS-gray-fog");

// Catalog lookup works by internal slug and by title slug alike.
assert(catalogBookCode("algorithms") === "FTF-clever-trails", "catalog: internal slug resolves");
assert(catalogBookCode("fenix-the-fox-and-the-clever-trails") === "FTF-clever-trails", "catalog: title slug resolves");
assert(catalogBookCode("mira-the-heron-and-the-still-water") === "MTH-still-water", "catalog: Mira resolves");
assert(catalogBookCode("no-such-book") === null, "catalog: unknown slug has no code");

// Degenerate titles never invent a code.
assert(bookCodeForTitle("") === null && bookCodeForTitle("One Word") === null, "short titles have no code");

if (failures) { console.error(failures + " book-codes test(s) failed"); process.exit(1); }
console.log("All book-codes tests passed.");
