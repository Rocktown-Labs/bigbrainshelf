// Download protection pins (owner-approved plan, 2026-10-29): owned
// downloads are stamped per buyer at serve time (visible licensed
// line + hidden metadata marker + microtext code), counted against a
// 5-per-purchase-per-file budget shared by the account route and the
// guest token route, resettable from the admin order page. The lock
// model's refusals are untouched: both routes still gate on ownership
// BEFORE the guard runs.
// Run with: bun tests/download-protection.test.ts
import { Database } from "bun:sqlite";
import { PDFDocument, StandardFonts, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { stampPdfForBuyer, licensedLine, microtextCode } from "../src/lib/pdf-stamp";
import {
  DOWNLOAD_LIMIT,
  DOWNLOAD_LIMIT_MESSAGE,
  resolveOrderGrant,
  resolveBoxGrant,
  grantForOrder,
  consumeDownload,
  downloadCountsForOrder,
  resetDownloadsForOrder,
} from "../src/lib/download-guard";
import { shortOrderId } from "../src/lib/orders";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}
const read = async (rel: string) => Bun.file(new URL(rel, import.meta.url)).text();

// ---- PDF stamping -------------------------------------------------------------
// Text extraction for assertions: pdf-lib writes drawn text as hex
// strings inside the content streams; decode every stream of a page
// and collect the text runs.
function pageTextRuns(doc: any, page: any): string[] {
  const contents: any = page.node.Contents();
  const refs = Array.isArray(contents)
    ? contents
    : typeof contents?.asArray === "function"
      ? contents.asArray()
      : [contents];
  const runs: string[] = [];
  for (const ref of refs) {
    const stream: any = doc.context.lookup(ref);
    let bytes: Uint8Array | null = null;
    if (stream instanceof PDFRawStream) {
      try { bytes = decodePDFRawStream(stream).decode(); } catch { /* ignore */ }
    } else if (stream?.getContents) {
      bytes = stream.getContents();
    }
    if (!bytes) continue;
    const text = new TextDecoder("latin1").decode(bytes);
    for (const m of text.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      const hex = m[1];
      let s = "";
      for (let i = 0; i + 1 < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      runs.push(s);
    }
  }
  return runs;
}

async function samplePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText("Story page " + (i + 1), { x: 56, y: 700, size: 14, font });
  }
  return doc.save();
}

const ORDER_ID = "1234abcd-5678-ef90-abcd-1234567890ab";
const info = { email: "jane@example.com", shortId: shortOrderId(ORDER_ID), marker: ORDER_ID, markerIsOrder: true };
assert(licensedLine(info) === `Licensed to jane@example.com · Order ${shortOrderId(ORDER_ID)}`, "licensed line reads email + short order id");
assert(microtextCode(info) === shortOrderId(ORDER_ID).slice(1), "microtext code is the bare short order code");

const stamped = await stampPdfForBuyer(await samplePdf(16), info);
const stampedDoc = await PDFDocument.load(stamped);
assert(stampedDoc.getSubject() === licensedLine(info), "metadata: subject carries the licensed line");
const kw = stampedDoc.getKeywords() || "";
assert(kw.includes(`bbs-order:${ORDER_ID}`), "metadata: keywords carry the full order id");
assert(kw.includes("bbs-buyer:jane@example.com"), "metadata: keywords carry the buyer email");

const pages = stampedDoc.getPages();
const runsOf = (idx: number) => pageTextRuns(stampedDoc, pages[idx]);
assert(!runsOf(0).some((r) => r.includes("Licensed to")), "front cover carries no stamp");
assert(!runsOf(pages.length - 1).some((r) => r.includes("Licensed to")), "back cover carries no stamp");
assert(runsOf(1).some((r) => r === licensedLine(info)), "first interior page carries the licensed line");
assert(runsOf(8).some((r) => r === licensedLine(info)), "a middle interior page carries the licensed line");
// Interior page 7 is page index 7 (the first interior page is index 1).
assert(runsOf(7).some((r) => r === microtextCode(info)), "7th interior page carries the standalone microtext code");
assert(!runsOf(6).some((r) => r === microtextCode(info)), "6th interior page has no microtext code");
assert(runsOf(14).some((r) => r === microtextCode(info)), "14th interior page carries the microtext code");

// Club-box grants stamp without an order reference.
const boxInfo = { email: "member@example.com", shortId: null, marker: "club-box:box-9", markerIsOrder: false };
const boxStamped = await PDFDocument.load(await stampPdfForBuyer(await samplePdf(4), boxInfo));
assert(boxStamped.getSubject() === "Licensed to member@example.com", "box grant: subject names the buyer alone");
assert((boxStamped.getKeywords() || "").includes("bbs-grant:club-box:box-9"), "box grant: keywords carry the grant marker");

// ---- The budget (in-memory D1) --------------------------------------------------
const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, book_slugs TEXT, items TEXT, status TEXT DEFAULT 'complete', created_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE club_signups (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, shelf TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL);
INSERT INTO orders (id, user_id, email, book_slugs, items, status, created_at) VALUES
  ('${ORDER_ID}', 'user-jane', 'jane@example.com', '["alpha"]', '[{"slug":"alpha","format":"digital"}]', 'complete', 1700000001),
  ('order-audio', 'user-andy', 'andy@example.com', '["beta"]', '[{"slug":"beta","format":"audio"}]', 'complete', 1700000002);
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

const jane = { id: "user-jane", email: "jane@example.com" };
const grant = await resolveOrderGrant(db, jane, "alpha", "picture");
assert(grant?.orderId === ORDER_ID && grant?.grantKey === ORDER_ID, "order grant resolves to the purchasing order");
assert(grant?.shortId === shortOrderId(ORDER_ID), "order grant carries the short display id");
assert(grant?.buyerEmail === "jane@example.com", "order grant carries the buyer email");
assert((await resolveOrderGrant(db, jane, "alpha", "audiobook"))?.orderId === ORDER_ID, "a digital purchase also grants its audiobook file");
assert((await resolveOrderGrant(db, jane, "beta", "picture")) === null, "no grant for a book the user never bought");
const andy = { id: "user-andy", email: "andy@example.com" };
assert((await resolveOrderGrant(db, andy, "beta", "audiobook"))?.orderId === "order-audio", "audio purchase grants the audiobook file");
assert((await resolveOrderGrant(db, andy, "beta", "picture")) === null, "audio purchase grants no book file");

// Five downloads pass, the sixth is refused.
for (let i = 1; i <= DOWNLOAD_LIMIT; i++) {
  const r = await consumeDownload(db, grant!, "alpha", "picture");
  assert(r.ok && r.count === i, `download ${i} of ${DOWNLOAD_LIMIT} allowed`);
}
const sixth = await consumeDownload(db, grant!, "alpha", "picture");
assert(!sixth.ok && sixth.count === DOWNLOAD_LIMIT, "the 6th download is refused at the cap");
// A different file kind has its own budget.
assert((await consumeDownload(db, grant!, "alpha", "coloring")).ok, "a different file kind keeps its own budget");
// The guest token route keys on the same order: its budget is shared.
const guestGrant = grantForOrder({ id: ORDER_ID, email: "jane@example.com" });
assert(guestGrant.grantKey === grant!.grantKey, "guest grant keys on the same order id");
assert(!(await consumeDownload(db, guestGrant, "alpha", "picture")).ok, "guest downloads share the account budget (already exhausted)");
// Counts read back for the admin page, and support's reset clears them.
const counts = await downloadCountsForOrder(db, ORDER_ID);
assert(counts.find((c) => c.file_kind === "picture")?.download_count === DOWNLOAD_LIMIT, "counts report the exhausted picture budget");
assert(counts.find((c) => c.file_kind === "coloring")?.download_count === 1, "counts report the coloring download");
await resetDownloadsForOrder(db, ORDER_ID);
assert((await downloadCountsForOrder(db, ORDER_ID)).length === 0, "reset clears the order's counts");
assert((await consumeDownload(db, grant!, "alpha", "picture")).ok, "downloads flow again after a reset");

// Box grant: the shipped box is the purchase.
raw.query("INSERT INTO club_signups (id, name, email, shelf, status, created_at) VALUES ('signup-1', 'Member', 'member@example.com', 'tech', 'paid', 1700000003)").run();
const { ensureClubCycleTables } = await import("../src/lib/club-cycles");
await ensureClubCycleTables(db);
raw.query("INSERT INTO club_cycle_boxes (id, signup_id, ship_date, resolved_book_slug, status, created_at, updated_at) VALUES ('box-9', 'signup-1', '2026-10-29', 'gamma', 'shipped', 1700000003, 1700000003)").run();
const boxGrant = await resolveBoxGrant(db, { id: "user-member", email: "member@example.com" }, "gamma");
assert(boxGrant?.grantKey === "club-box:box-9" && boxGrant?.orderId === null, "box grant keys on the shipped box");
assert(boxGrant?.shortId === null && boxGrant?.buyerEmail === "member@example.com", "box grant stamps the buyer without an order");
assert((await resolveBoxGrant(db, { id: "user-member", email: "member@example.com" }, "alpha")) === null, "no box grant for a book no box carried");

// ---- Route and surface pins ------------------------------------------------------
const downloadSrc = await read("../src/pages/api/download.ts");
assert(downloadSrc.includes("entitlementDownloads"), "account route still gates on the lock-model ownership helper");
assert(downloadSrc.indexOf("entitlementDownloads") < downloadSrc.indexOf("consumeDownload"), "account route: ownership is checked BEFORE the budget is touched");
assert(downloadSrc.includes("stampPdfForBuyer") && downloadSrc.includes("DOWNLOAD_LIMIT_MESSAGE"), "account route stamps PDFs and refuses at the cap with the friendly message");

const orderDownloadSrc = await read("../src/pages/api/order-download.ts");
assert(orderDownloadSrc.includes("That book is not part of this order."), "guest route keeps its order-rights refusal");
assert(orderDownloadSrc.includes("grantForOrder") && orderDownloadSrc.includes("consumeDownload"), "guest route counts against the token order's budget");
assert(orderDownloadSrc.includes("stampPdfForBuyer"), "guest route stamps PDFs");

const adminApiSrc = await read("../src/pages/api/admin/orders.ts");
assert(adminApiSrc.includes('action === "reset_downloads"'), "admin API handles the downloads reset");
assert(adminApiSrc.includes("download_counts") && adminApiSrc.includes("downloadCountsForOrder"), "admin detail reports the download counts");

const adminPageSrc = await read("../src/pages/admin/orders/[id].astro");
assert(adminPageSrc.includes("Reset downloads") && adminPageSrc.includes("reset_downloads"), "admin order page shows counts with a reset button");

for (const [rel, label] of [
  ["../src/pages/account/index.astro", "account shelf"],
  ["../src/pages/read/[slug].astro", "reader downloads"],
  ["../src/pages/order.astro", "guest order page"],
] as const) {
  assert((await read(rel)).includes("For your family's personal use."), `license line appears on the ${label}`);
}
const termsSrc = await read("../src/pages/terms.astro");
assert(termsSrc.includes("each downloaded PDF carries a small line in the bottom margin"), "terms disclose the per-buyer stamp");
assert(termsSrc.includes("Downloaded audiobooks carry the same purchase details"), "terms disclose the audiobook tag stamp");
assert(termsSrc.includes("downloaded up to five times"), "terms disclose the download allowance");
assert(DOWNLOAD_LIMIT === 5 && DOWNLOAD_LIMIT_MESSAGE.includes("download limit for this file"), "the cap is 5 and the refusal names support's reset");

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nALL DOWNLOAD PROTECTION TESTS PASSED");
