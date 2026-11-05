// Serial minting (CG, 2026-11-05): direct-sold copies are numbered
// ("Vol. 1 #N"), KDP copies never. Pins the registry: the volume
// backfill happens once when the column lands, numbers come from a
// per-book counter and are never reused, every mint path is
// get-or-create on its grant key, and the stamper carries the
// number on the dedication page plus a metadata keyword.
// Run with: bun tests/serials.test.ts
import { Database } from "bun:sqlite";
import { PDFDocument } from "pdf-lib";
import {
  ensureSerialSchema,
  getOrMintSerial,
  getOrMintDownloadSerial,
  getSerialByCode,
  listSerialsForBox,
  listSerialsForOrder,
  mintOrderPrintSerials,
  serialLabel,
  serialVerifyPath,
} from "../src/lib/serials";
import { stampPdfForBuyer } from "../src/lib/pdf-stamp";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE books (slug TEXT PRIMARY KEY, title TEXT);
INSERT INTO books (slug, title) VALUES ('alpha', 'Alpha the Fox'), ('beta', 'Beta the Bear');
`);

const db = {
  prepare(sql: string) {
    return {
      bind(...args: any[]) {
        const stmt = raw.query(sql);
        return {
          async run() { const r = stmt.run(...args) as any; return { meta: { changes: r?.changes ?? 0 } }; },
          async first() { return stmt.get(...args) ?? null; },
          async all() { return { results: stmt.all(...args) }; },
        };
      },
    };
  },
} as any;

assert(serialLabel(1, 42) === "Vol. 1 #42", "label format is CG's wording: Vol. 1 #42");
assert(serialVerifyPath("AB12CD34") === "/v/AB12CD34", "verify path is /v/{code}");

// --- Volume backfill: once, for the books that exist then ---------
await ensureSerialSchema(db);
const vols = raw.query("SELECT slug, volume FROM books ORDER BY slug").all() as any[];
assert(vols.every((v) => v.volume === 1), "books that exist when the column lands are Volume 1 (the first stories)");
raw.query("INSERT INTO books (slug, title) VALUES ('gamma', 'Gamma the Goat')").run();

// --- Minting: per-book sequences, never reused ---------------------
const a1 = await getOrMintSerial(db, { bookSlug: "alpha", grantKey: "order:o1:alpha:digital", format: "digital", orderId: "o1" });
const a2 = await getOrMintSerial(db, { bookSlug: "alpha", grantKey: "order:o2:alpha:digital", format: "digital", orderId: "o2" });
const b1 = await getOrMintSerial(db, { bookSlug: "beta", grantKey: "order:o1:beta:digital", format: "digital", orderId: "o1" });
assert(a1?.serial === 1 && a2?.serial === 2, "one book's copies number in order");
assert(b1?.serial === 1, "each book has its own sequence");
assert(a1?.volume === 1 && a1?.code.length === 8, "mints carry the volume and an 8-char public code");

const a1Again = await getOrMintSerial(db, { bookSlug: "alpha", grantKey: "order:o1:alpha:digital", format: "digital", orderId: "o1" });
assert(a1Again?.serial === 1 && a1Again?.id === a1?.id, "the same copy re-mints to the same number (get-or-create)");
const a3 = await getOrMintSerial(db, { bookSlug: "alpha", grantKey: "order:o3:alpha:digital", format: "digital", orderId: "o3" });
assert(a3?.serial === 3, "a repeat read does not burn a number");

// --- A book with no volume set does not mint ------------------------
const g = await getOrMintSerial(db, { bookSlug: "gamma", grantKey: "order:o1:gamma:digital", format: "digital", orderId: "o1" });
assert(g === null, "a later book with no volume set stays unminted until its volume is chosen");

// --- Download grants ------------------------------------------------
const dl = await getOrMintDownloadSerial(db, { bookSlug: "beta", orderId: "o9" });
assert(dl?.serial === 2 && dl?.format === "digital", "an order download mints against the order");
const boxDl = await getOrMintDownloadSerial(db, { bookSlug: "beta", clubBoxId: "box9" });
assert(boxDl?.serial === 3 && boxDl?.clubBoxId === "box9", "a club box download mints against the box");
assert((await getOrMintDownloadSerial(db, { bookSlug: "beta" })) === null, "a grant with no order and no box mints nothing");
assert((await listSerialsForBox(db, "box9")).length === 1, "box serials list by box");
assert((await listSerialsForOrder(db, "o1")).length === 2, "order serials list by order (alpha + beta)");

// --- Print units of an order ----------------------------------------
const printOrder = {
  id: "o-print",
  items: JSON.stringify([
    { slug: "alpha", format: "printed", qty: 2 },
    { slug: "beta", format: "giftset", qty: 1 },
    { slug: "beta", format: "digital", qty: 1 },
  ]),
};
const prints = await mintOrderPrintSerials(db, printOrder);
assert(prints.length === 3, "print minting covers printed and gift set units, never the digital line");
assert(prints.filter((s) => s.bookSlug === "alpha").map((s) => s.serial).join(",") === "4,5", "two printed units take the next two numbers");
assert(prints.find((s) => s.format === "giftset")?.bookSlug === "beta", "the gift set unit mints as a giftset copy");
const printsAgain = await mintOrderPrintSerials(db, printOrder);
assert(printsAgain.map((s) => s.id).join(",") === prints.map((s) => s.id).join(","), "re-running the pack-stage mint returns the same copies");

// --- The badge lookup -------------------------------------------------
const byCode = await getSerialByCode(db, (a1?.code || "").toLowerCase());
assert(byCode?.id === a1?.id, "the badge lookup finds a copy by its code, case-insensitively");
assert((await getSerialByCode(db, "ZZZZZZZZ")) === null, "an unknown code finds nothing");

// --- The stamper carries the number -----------------------------------
{
  const src = await PDFDocument.create();
  for (let i = 0; i < 4; i++) src.addPage([612, 792]);
  const rawBytes = await src.save();
  const stamped = await stampPdfForBuyer(rawBytes, {
    email: "buyer@example.com",
    shortId: "#ABC12345",
    marker: "order-1",
    markerIsOrder: true,
    bookTitle: "Alpha the Fox",
    serialLabel: "Vol. 1 #7",
    serialCode: "AB12CD34",
  });
  const doc = await PDFDocument.load(stamped);
  assert(doc.getPageCount() === 5, "the stamp still inserts the dedication page when a serial rides along");
  const keywords = doc.getKeywords() || "";
  assert(keywords.includes("bbs-serial:AB12CD34"), "the serial code rides the PDF metadata keywords");
  const plain = await stampPdfForBuyer(rawBytes, {
    email: "buyer@example.com",
    shortId: "#ABC12345",
    marker: "order-1",
    markerIsOrder: true,
    bookTitle: "Alpha the Fox",
  });
  const plainDoc = await PDFDocument.load(plain);
  assert(!(plainDoc.getKeywords() || "").includes("bbs-serial"), "no serial, no serial keyword: unminted copies stamp exactly as before");
}

console.log(failures === 0 ? "\nALL SERIAL TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
