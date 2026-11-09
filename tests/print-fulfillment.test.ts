import { releaseBucket, seedPrintReleases } from "./helpers/release-fixture";
// Print fulfillment (src/lib/print-fulfillment.ts + src/lib/lulu.ts)
// against an in-memory DB, a fake R2 bucket, and a stubbed Lulu API:
// job building (per-unit items, gift sets in one job, serials minted
// before personalization, personalized page count = stock + 1),
// idempotency, blocked jobs on missing printables, dispatch, status
// sync with per-item shipments and derived order physical_status,
// packing queue exclusion, and print-file token expiry.
import { Database } from "bun:sqlite";
import { PDFDocument } from "pdf-lib";
import {
  buildJobForBox,
  buildJobsForOrder,
  dispatchPrintJobs,
  ensurePrintSchema,
  getPrintJobForBox,
  getPrintJobsForOrder,
  resolvePrintFileToken,
  seedPrintables,
  syncPrintJobs,
} from "../src/lib/print-fulfillment";
import { getPackingQueue } from "../src/lib/packing";
import { listSerialsForOrder, listSerialsForBox } from "../src/lib/serials";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { passed++; console.log("  ok:", name); }
  else { failed++; console.error("  FAIL:", name, extra ?? ""); }
}

// In-memory DB with the D1 prepare/bind surface (the repo's test
// pattern, see tests/serials.test.ts).
const raw = new Database(":memory:");
function makeStmt(sql: string, params: any[]) {
  const stmt = raw.query(sql);
  return {
    bind: (...next: any[]) => makeStmt(sql, next),
    async run() { stmt.run(...params); return { success: true, meta: { changes: 1 } }; },
    async first<T = any>() { return (stmt.get(...params) as T) ?? null; },
    async all<T = any>() { return { results: stmt.all(...params) as T[] }; },
  };
}
const db: any = { prepare: (sql: string) => makeStmt(sql, []) };

raw.exec(`
  CREATE TABLE books (
    slug TEXT PRIMARY KEY,
    title TEXT,
    status TEXT,
    public_slug TEXT,
    cover_key TEXT,
    price INTEGER,
    price_print INTEGER,
    picture_book_key TEXT,
    coloring_book_key TEXT,
    audiobook_key TEXT
  );
  CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    email TEXT,
    total_cents INTEGER,
    status TEXT,
    items TEXT,
    book_slugs TEXT,
    club_cycle INTEGER,
    delivery_token TEXT,
    delivery_token_expires INTEGER,
    ship_name TEXT,
    ship_address TEXT,
    physical_status TEXT,
    carrier TEXT,
    carrier_service TEXT,
    tracking_number TEXT,
    label_url TEXT,
    shippo_shipment_id TEXT,
    shippo_transaction_id TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE club_signups (
    id TEXT PRIMARY KEY,
    email TEXT,
    ship_name TEXT,
    ship_address TEXT
  );
`);

raw.prepare("INSERT INTO books (slug, title, status) VALUES (?, ?, 'complete')")
  .run("mira-the-heron-and-the-still-water", "Mira the Heron and the Still Water");
raw.prepare("INSERT INTO books (slug, title, status) VALUES (?, ?, 'complete')")
  .run("richdadpoordad", "Penny the Squirrel and the Acorn Orchard");
raw.prepare("INSERT INTO club_signups (id, email, ship_name, ship_address) VALUES (?, ?, ?, ?)")
  .run("signup-1", "member@example.com", "Member One", JSON.stringify({
    line1: "200 Pine St", line2: "", city: "Searcy", state: "AR", postal_code: "72143", country: "US",
  }));

// Fake R2: the stock story interior is a real 5-page PDF so the
// personalization stamp actually inserts a page.
const objects = new Map<string, Uint8Array>();
async function stockPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 5; i++) doc.addPage([612, 792]);
  return doc.save();
}
const fakeBooks = releaseBucket(objects);

const env: any = {
  FULFILLMENT_PROVIDER: "lulu",
  LULU_ENV: "sandbox",
  LULU_SANDBOX_CLIENT_ID: "cid-sandbox",
  LULU_SANDBOX_CLIENT_SECRET: "secret-sandbox",
  BOOKS: fakeBooks,
  BETTER_AUTH_URL: "https://bigbrainshelf.com",
};
const SITE = "https://bigbrainshelf.com";

// Stubbed Lulu API. Status and full-job payloads are steerable per
// test through luluStatus / luluJob.
const originalFetch = globalThis.fetch;
let createBodies: any[] = [];
let luluStatus: any = null;
let luluJob: any = null;
function installFetch() {
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    const method = String(init.method || "GET").toUpperCase();
    if (u.endsWith("/auth/realms/glasstree/protocol/openid-connect/token")) {
      return new Response(JSON.stringify({ access_token: "tok-test", expires_in: 3600 }), { status: 200 });
    }
    if (u.endsWith("/print-jobs/") && method === "POST") {
      const body = JSON.parse(String(init.body));
      createBodies.push(body);
      return new Response(JSON.stringify({
        id: 555001,
        status: { name: "CREATED" },
        line_items: (body.line_items || []).map((li: any, i: number) => ({
          id: 9000 + i, external_id: li.external_id, status: { name: "CREATED" },
        })),
      }), { status: 201 });
    }
    if (u.endsWith("/print-jobs/555001/status/") && method === "GET") {
      return new Response(JSON.stringify(luluStatus), { status: 200 });
    }
    if (u.endsWith("/print-jobs/555001/") && method === "GET") {
      return new Response(JSON.stringify(luluJob), { status: 200 });
    }
    return new Response("unexpected url " + u, { status: 500 });
  }) as any;
}

function orderRow(id: string, items: any[], physical = "preorder_received") {
  raw.prepare(
    `INSERT INTO orders (id, email, total_cents, status, items, book_slugs, ship_name, ship_address, physical_status, created_at, updated_at)
     VALUES (?, 'buyer@example.com', 2499, 'complete', ?, ?, 'Test Buyer', ?, ?, 1000, 1000)`
  ).run(
    id,
    JSON.stringify(items),
    items.map((i) => i.slug).join(","),
    JSON.stringify({ line1: "100 W Race Ave", line2: "", city: "Searcy", state: "AR", postal_code: "72143", country: "US" }),
    physical,
  );
  return raw.query("SELECT * FROM orders WHERE id = ?").get(id) as any;
}

async function main() {
  await ensurePrintSchema(db);
  await seedPrintables(db);
  objects.set(
    "books/mira-the-heron-and-the-still-water/print/story-interior.pdf",
    await stockPdf(),
  );
  await seedPrintReleases(raw, db, fakeBooks, objects);

  // -- printed x2: one job, two per-unit story items, serials first.
  const order1 = orderRow("ord-1", [
    { slug: "mira-the-heron-and-the-still-water", format: "printed", qty: 2, dedicationName: "Ruby" },
  ]);
  const job1 = await buildJobsForOrder(db, env, order1);
  check("printed order builds one queued job", !!job1 && job1.status === "queued", JSON.stringify(job1));
  check("job is keyed to the order", job1?.idempotencyKey === "order:ord-1" && job1?.orderId === "ord-1");
  check("two story items, one per unit", job1?.items.length === 2 && job1.items.every((i) => i.kind === "story"), JSON.stringify(job1?.items));
  check("both units personalized with the dedication name",
    job1?.items.every((i) => i.personalized === true && i.dedicationName === "Ruby"));
  check("personalized page count is stock + 1",
    job1?.items.every((i) => i.interiorPages === 44), JSON.stringify(job1?.items.map((i) => i.interiorPages)));
  const serials = await listSerialsForOrder(db, "ord-1");
  check("serials minted at job creation", serials.length === 2, JSON.stringify(serials));
  check("items carry the minted serials",
    job1?.items.every((i) => i.serialCode && serials.some((s) => s.code === i.serialCode)));
  const personalizedKey = job1?.items[0]?.interiorKey || "";
  check("personalized interior written under the job item key",
    personalizedKey.startsWith("books/mira-the-heron-and-the-still-water/print/personalized/") && objects.has(personalizedKey), personalizedKey);
  const personalizedDoc = await PDFDocument.load(objects.get(personalizedKey)!);
  check("personalized PDF gained exactly one page", personalizedDoc.getPageCount() === 6, String(personalizedDoc.getPageCount()));

  // Idempotent rebuild.
  const job1Again = await buildJobsForOrder(db, env, order1);
  check("rebuild returns the same job", job1Again?.id === job1?.id);
  check("rebuild does not duplicate items", job1Again?.items.length === 2);
  check("rebuild does not mint new serials", (await listSerialsForOrder(db, "ord-1")).length === 2);

  // -- giftset: story + coloring in the SAME job; coloring untouched.
  const order2 = orderRow("ord-2", [
    { slug: "mira-the-heron-and-the-still-water", format: "giftset", qty: 1 },
  ]);
  const job2 = await buildJobsForOrder(db, env, order2);
  check("giftset builds one job", !!job2 && job2.status === "queued");
  check("giftset job holds story + coloring together",
    job2?.items.length === 2 && job2.items.some((i) => i.kind === "story") && job2.items.some((i) => i.kind === "coloring"),
    JSON.stringify(job2?.items.map((i) => i.kind)));
  const coloringItem = job2?.items.find((i) => i.kind === "coloring");
  check("coloring is never personalized",
    coloringItem?.personalized === false && coloringItem?.interiorKey.includes("/releases/fixture-mira-the-heron-and-the-still-water/artifacts/") === true);
  check("giftset story unit takes the set serial",
    job2?.items.find((i) => i.kind === "story")?.serialCode ===
    (await listSerialsForOrder(db, "ord-2")).find((s) => s.format === "giftset")?.code);

  // -- missing printable: blocked, never a throw.
  const order3 = orderRow("ord-3", [
    { slug: "richdadpoordad", format: "giftset", qty: 1 },
  ]);
  let job3: any = null;
  let threw = false;
  try { job3 = await buildJobsForOrder(db, env, order3); } catch { threw = true; }
  check("missing coloring printable does not throw", !threw);
  check("job records blocked_no_printable", job3?.status === "blocked_no_printable", job3?.status);
  check("block names the missing printable",
    String(job3?.lastError || "").includes("richdadpoordad") && String(job3?.lastError || "").includes("coloring"),
    job3?.lastError);

  // -- packing queue: Lulu orders leave, home orders stay.
  const queueBefore = await getPackingQueue(db);
  check("packing queue excludes orders with print jobs",
    !queueBefore.some((q: any) => q.id === "ord-1" || q.id === "ord-2"));
  const order4 = orderRow("ord-4", [
    { slug: "mira-the-heron-and-the-still-water", format: "printed", qty: 1 },
  ]);
  const queueAfter = await getPackingQueue(db);
  check("packing queue still lists home-fulfilled orders",
    queueAfter.some((q: any) => q.id === "ord-4" && q.kind === "order"));

  // -- dispatch: queued job goes to Lulu with token URLs.
  installFetch();
  const dispatch = await dispatchPrintJobs(db, env, { site: SITE });
  check("dispatcher submits the queued jobs", dispatch.submitted === 2, JSON.stringify(dispatch));
  const submitted1 = (await getPrintJobsForOrder(db, "ord-1"))[0];
  check("job stores the Lulu id and status",
    submitted1?.status === "submitted" && submitted1?.luluJobId === "555001" && submitted1?.luluStatus === "CREATED",
    JSON.stringify(submitted1));
  check("create body used production delay 120 and MAIL",
    createBodies.length >= 1 && createBodies.every((b) => b.production_delay === 120 && b.shipping_level === "MAIL"),
    JSON.stringify(createBodies[0]));
  check("create body source urls are token urls",
    createBodies[0].line_items.every((li: any) =>
      li.printable_normalization.interior.source_url.startsWith(SITE + "/api/print-file/") &&
      li.printable_normalization.cover.source_url.startsWith(SITE + "/api/print-file/")));

  // -- print-file tokens: valid resolves, expired and unknown do not.
  const tokenRow = raw.query("SELECT token, r2_key FROM print_file_tokens LIMIT 1").get() as any;
  const resolved = await resolvePrintFileToken(db, tokenRow.token);
  check("live token resolves to its R2 key", resolved?.r2Key === tokenRow.r2_key);
  raw.prepare("INSERT INTO print_file_tokens (token, r2_key, job_id, job_item_id, created_at, expires_at) VALUES ('expired-tok', 'k', NULL, NULL, 1, 2)").run();
  check("expired token is rejected", (await resolvePrintFileToken(db, "expired-tok")) === null);
  check("unknown token is rejected", (await resolvePrintFileToken(db, "no-such-token")) === null);

  // -- sync: full shipment moves the order to shipped with tracking.
  const items1 = submitted1.items;
  luluStatus = {
    name: "SHIPPED",
    message: "All line-items were shipped.",
    line_item_statuses: items1.map((it) => ({
      name: "SHIPPED",
      line_item_id: Number(it.luluLineItemId),
      messages: { tracking_id: "9400111899223856928499", tracking_urls: ["https://tools.usps.com/go/TrackConfirmAction?tLabels=9400"], carrier_name: "USPS" },
    })),
    print_job_id: 555001,
  };
  luluJob = {
    id: 555001,
    status: { name: "SHIPPED" },
    line_items: items1.map((it) => ({
      id: Number(it.luluLineItemId), external_id: it.externalId, status: { name: "SHIPPED" },
      tracking_id: "9400111899223856928499", tracking_urls: ["https://tools.usps.com/go/TrackConfirmAction?tLabels=9400"], carrier_name: "USPS",
    })),
  };
  const sync1 = await syncPrintJobs(db, env, { orderId: "ord-1" });
  check("sync mirrors the shipped job", sync1.synced === 1 && sync1.shipped === 1, JSON.stringify(sync1));
  const order1After = raw.query("SELECT physical_status FROM orders WHERE id = 'ord-1'").get() as any;
  check("order physical_status written directly to shipped", order1After.physical_status === "shipped");
  const shipmentRows = raw.query("SELECT * FROM shipments").all() as any[];
  check("one shipment row per shipped item",
    shipmentRows.length === items1.length && shipmentRows.every((s) => s.tracking_id && s.carrier_name === "USPS"),
    JSON.stringify(shipmentRows));

  // -- sync: partial shipment keeps the order in_print, flags the job.
  const jobs2 = await getPrintJobsForOrder(db, "ord-2");
  const giftItems = jobs2[0].items;
  luluStatus = {
    name: "IN_PRODUCTION",
    line_item_statuses: giftItems.map((it, idx) => ({
      name: idx === 0 ? "SHIPPED" : "IN_PRODUCTION",
      line_item_id: Number(it.luluLineItemId),
      messages: idx === 0 ? { tracking_id: "partial-1", tracking_urls: [], carrier_name: "USPS" } : {},
    })),
    print_job_id: 555001,
  };
  luluJob = {
    id: 555001,
    status: { name: "IN_PRODUCTION" },
    line_items: giftItems.map((it, idx) => ({
      id: Number(it.luluLineItemId), external_id: it.externalId, status: { name: idx === 0 ? "SHIPPED" : "IN_PRODUCTION" },
      tracking_id: idx === 0 ? "partial-1" : null, tracking_urls: [], carrier_name: idx === 0 ? "USPS" : null,
    })),
  };
  await syncPrintJobs(db, env, { orderId: "ord-2" });
  const order2After = raw.query("SELECT physical_status FROM orders WHERE id = 'ord-2'").get() as any;
  const job2After = (await getPrintJobsForOrder(db, "ord-2"))[0];
  check("partial shipment keeps the order in_print", order2After.physical_status === "in_print", order2After.physical_status);
  check("partial shipment flags the job", job2After?.hasPartial === true);

  // -- shipping phone: Lulu requires phone_number on the address.
  // Checkout collects no phone yet, so the store fallback carried in
  // the worker env fills the gap and the job notes say so.
  const FALLBACK_PHONE = "+1 501 555 0100";
  const envWithFallback: any = { ...env, LULU_FALLBACK_PHONE: FALLBACK_PHONE };
  function orderRowWithAddress(id: string, items: any[], address: any) {
    raw.prepare(
      `INSERT INTO orders (id, email, total_cents, status, items, book_slugs, ship_name, ship_address, physical_status, created_at, updated_at)
       VALUES (?, 'buyer@example.com', 2499, 'complete', ?, ?, 'Test Buyer', ?, 'preorder_received', 1000, 1000)`
    ).run(id, JSON.stringify(items), items.map((i) => i.slug).join(","), JSON.stringify(address));
    return raw.query("SELECT * FROM orders WHERE id = ?").get(id) as any;
  }

  // (a) phone-less order + fallback env: the create body carries the
  // fallback number and the job notes mention the fallback.
  const order5 = orderRow("ord-5", [
    { slug: "mira-the-heron-and-the-still-water", format: "printed", qty: 1 },
  ]);
  const job5 = await buildJobsForOrder(db, envWithFallback, order5);
  check("phone-less order builds a queued job with the fallback env", !!job5 && job5.status === "queued");
  check("job notes mention the store fallback",
    String(job5?.notes || "").includes("Shipping phone: store fallback used"), job5?.notes ?? "(no notes)");
  const bodiesBefore5 = createBodies.length;
  const dispatch5 = await dispatchPrintJobs(db, envWithFallback, { site: SITE });
  check("fallback job dispatches", dispatch5.submitted === 1, JSON.stringify(dispatch5));
  check("create body carries the fallback phone number",
    createBodies[bodiesBefore5]?.shipping_address?.phone_number === FALLBACK_PHONE,
    JSON.stringify(createBodies[bodiesBefore5]?.shipping_address));

  // (b) an order with its own phone keeps it; the fallback never
  // overrides a number the order already carries.
  const OWN_PHONE = "+1 501 555 0142";
  const order6 = orderRowWithAddress("ord-6", [
    { slug: "mira-the-heron-and-the-still-water", format: "printed", qty: 1 },
  ], { line1: "100 W Race Ave", line2: "", city: "Searcy", state: "AR", postal_code: "72143", country: "US", phone: OWN_PHONE });
  const job6 = await buildJobsForOrder(db, envWithFallback, order6);
  check("order with its own phone gets no fallback note",
    !String(job6?.notes || "").includes("store fallback"), job6?.notes ?? "(no notes)");
  const bodiesBefore6 = createBodies.length;
  const dispatch6 = await dispatchPrintJobs(db, envWithFallback, { site: SITE });
  check("own-phone job dispatches", dispatch6.submitted === 1, JSON.stringify(dispatch6));
  check("create body keeps the order's own phone number",
    createBodies[bodiesBefore6]?.shipping_address?.phone_number === OWN_PHONE,
    JSON.stringify(createBodies[bodiesBefore6]?.shipping_address));

  // (c) no fallback configured: the create body carries no
  // phone_number, exactly the behavior before the fallback existed.
  const order7 = orderRow("ord-7", [
    { slug: "mira-the-heron-and-the-still-water", format: "printed", qty: 1 },
  ]);
  const job7 = await buildJobsForOrder(db, env, order7);
  check("phone-less order without fallback still builds queued", !!job7 && job7.status === "queued");
  const bodiesBefore7 = createBodies.length;
  const dispatch7 = await dispatchPrintJobs(db, env, { site: SITE });
  check("no-fallback job dispatches", dispatch7.submitted === 1, JSON.stringify(dispatch7));
  check("create body has no phone_number without a fallback",
    !!createBodies[bodiesBefore7]?.shipping_address && !("phone_number" in createBodies[bodiesBefore7].shipping_address),
    JSON.stringify(createBodies[bodiesBefore7]?.shipping_address));

  // -- club box: two storybooks + the primary book's coloring book.
  const box: any = {
    id: "box-1",
    cycle_number: 1,
    signup_id: "signup-1",
    status: "locked",
    locked_at: Date.now(),
    resolved_book_slug: "mira-the-heron-and-the-still-water",
    selected_book_slug: "mira-the-heron-and-the-still-water",
    second_resolved_book_slug: "richdadpoordad",
    second_selected_book_slug: "richdadpoordad",
  };
  const boxJob = await buildJobForBox(db, env, box);
  check("box builds one job", !!boxJob && boxJob.idempotencyKey === "box:box-1");
  check("box job holds both storybooks plus the primary coloring book",
    boxJob?.items.length === 3 &&
    boxJob.items.filter((i) => i.kind === "story").length === 2 &&
    boxJob.items.some((i) => i.kind === "coloring" && i.slug === "mira-the-heron-and-the-still-water"),
    JSON.stringify(boxJob?.items.map((i) => `${i.slug}:${i.kind}`)));
  check("box serials minted under the club grant keys",
    (await listSerialsForBox(db, "box-1")).length === 2);
  const boxJobAgain = await getPrintJobForBox(db, "box-1");
  check("box job reads back by box id", boxJobAgain?.id === boxJob?.id);

  globalThis.fetch = originalFetch;
  console.log(`\nprint-fulfillment.test.ts: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  globalThis.fetch = originalFetch;
  console.error(err);
  process.exit(1);
});
