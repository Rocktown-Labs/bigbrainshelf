// Print parcel notifications (slice 4 core): sync enqueues exactly
// one print_shipped email per parcel when its shipment first gains
// tracking, and exactly one print_delivered when the parcel is
// delivered, however many times the job re-syncs afterwards. Rows
// ride the outbox dedupe key with order_id NULL (the (order_id,
// kind) unique index would collapse a second parcel into the
// first), and each kind renders styled HTML through its own branch
// in lib/email-render. Club box parcels address the member and read
// as Book Club mail.
import { Database } from "bun:sqlite";
import { PDFDocument } from "pdf-lib";
import {
  buildJobForBox,
  buildJobsForOrder,
  dispatchPrintJobs,
  ensurePrintSchema,
  getPrintJobForBox,
  getPrintJobsForOrder,
  seedPrintables,
  syncPrintJobs,
} from "../src/lib/print-fulfillment";
import { renderOutboxEmailHtml } from "../src/lib/email-render";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { passed++; console.log("  ok:", name); }
  else { failed++; console.error("  FAIL:", name, extra ?? ""); }
}

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
    slug TEXT PRIMARY KEY, title TEXT, status TEXT, public_slug TEXT, cover_key TEXT,
    price INTEGER, price_print INTEGER, picture_book_key TEXT, coloring_book_key TEXT,
    epub_key TEXT, color_book_key TEXT, audiobook_key TEXT
  );
  CREATE TABLE orders (
    id TEXT PRIMARY KEY, user_id TEXT, email TEXT, total_cents INTEGER, status TEXT,
    items TEXT, book_slugs TEXT, club_cycle INTEGER, delivery_token TEXT,
    delivery_token_expires INTEGER, ship_name TEXT, ship_address TEXT,
    physical_status TEXT, carrier TEXT, carrier_service TEXT, tracking_number TEXT,
    label_url TEXT, shippo_shipment_id TEXT, shippo_transaction_id TEXT,
    created_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE club_signups (id TEXT PRIMARY KEY, email TEXT, ship_name TEXT, ship_address TEXT);
  CREATE TABLE email_outbox (
    id TEXT PRIMARY KEY, order_id TEXT, kind TEXT NOT NULL, to_email TEXT NOT NULL,
    subject TEXT NOT NULL, body_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL, sent_at INTEGER
  );
  CREATE UNIQUE INDEX email_outbox_order_kind_idx ON email_outbox(order_id, kind) WHERE order_id IS NOT NULL;
`);

raw.prepare("INSERT INTO books (slug, title, status) VALUES (?, ?, 'complete')")
  .run("mira-the-heron-and-the-still-water", "Mira the Heron and the Still Water");
raw.prepare("INSERT INTO books (slug, title, status) VALUES (?, ?, 'complete')")
  .run("richdadpoordad", "Penny the Squirrel and the Acorn Orchard");
raw.prepare("INSERT INTO club_signups (id, email, ship_name, ship_address) VALUES (?, ?, ?, ?)")
  .run("signup-1", "member@example.com", "Member One", JSON.stringify({
    line1: "200 Pine St", line2: "", city: "Searcy", state: "AR", postal_code: "72143", country: "US",
  }));

const objects = new Map<string, Uint8Array>();
async function stockPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 5; i++) doc.addPage([612, 792]);
  return doc.save();
}
const fakeBooks = {
  async get(key: string) {
    const bytes = objects.get(key);
    if (!bytes) return null;
    return { body: bytes, arrayBuffer: async () => bytes.slice().buffer };
  },
  async put(key: string, value: any) {
    objects.set(key, new Uint8Array(value instanceof Uint8Array ? value : new Uint8Array(await value.arrayBuffer())));
  },
};

const env: any = {
  FULFILLMENT_PROVIDER: "lulu",
  LULU_ENV: "sandbox",
  LULU_SANDBOX_CLIENT_ID: "cid-sandbox",
  LULU_SANDBOX_CLIENT_SECRET: "secret-sandbox",
  BOOKS: fakeBooks,
  BETTER_AUTH_URL: "https://bigbrainshelf.com",
};
const SITE = "https://bigbrainshelf.com";

const originalFetch = globalThis.fetch;
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

function orderRow(id: string, items: any[]) {
  raw.prepare(
    `INSERT INTO orders (id, email, total_cents, status, items, book_slugs, ship_name, ship_address, physical_status, created_at, updated_at)
     VALUES (?, 'buyer@example.com', 2499, 'complete', ?, ?, 'Test Buyer', ?, 'preorder_received', 1000, 1000)`
  ).run(
    id,
    JSON.stringify(items),
    items.map((i) => i.slug).join(","),
    JSON.stringify({ line1: "100 W Race Ave", line2: "", city: "Searcy", state: "AR", postal_code: "72143", country: "US" }),
  );
  return raw.query("SELECT * FROM orders WHERE id = ?").get(id) as any;
}

function setLuluState(items: any[], statusName: string, withTracking: boolean) {
  luluStatus = {
    name: statusName,
    line_item_statuses: items.map((it) => ({
      name: statusName,
      line_item_id: Number(it.luluLineItemId),
      messages: withTracking
        ? { tracking_id: `trk-${it.id.slice(0, 6)}`, tracking_urls: [`https://track.example/${it.id.slice(0, 6)}`], carrier_name: "USPS" }
        : {},
    })),
    print_job_id: 555001,
  };
  luluJob = {
    id: 555001,
    status: { name: statusName },
    line_items: items.map((it) => ({
      id: Number(it.luluLineItemId), external_id: it.externalId, status: { name: statusName },
      tracking_id: withTracking ? `trk-${it.id.slice(0, 6)}` : null,
      tracking_urls: withTracking ? [`https://track.example/${it.id.slice(0, 6)}`] : [],
      carrier_name: withTracking ? "USPS" : null,
    })),
  };
}

const outboxRows = (kind: string) =>
  raw.query("SELECT * FROM email_outbox WHERE kind = ? ORDER BY created_at, dedupe_key").all(kind) as any[];

async function main() {
  await ensurePrintSchema(db);
  await seedPrintables(db);
  objects.set("books/mira-the-heron-and-the-still-water/print/story-interior.pdf", await stockPdf());
  installFetch();

  // -- Order with two parcels: both ship, then both deliver.
  const order = orderRow("ord-n1", [
    { slug: "mira-the-heron-and-the-still-water", format: "printed", qty: 2 },
  ]);
  const job = await buildJobsForOrder(db, env, order);
  check("order job built", !!job && job.status === "queued");
  await dispatchPrintJobs(db, env, { site: SITE });
  const submitted = (await getPrintJobsForOrder(db, "ord-n1"))[0];
  check("order job submitted", submitted?.status === "submitted", submitted?.status);

  setLuluState(submitted.items, "SHIPPED", true);
  await syncPrintJobs(db, env, { orderId: "ord-n1", site: SITE });
  const shippedRows = outboxRows("print_shipped");
  check("one shipped email per parcel (2 parcels, 2 emails)",
    shippedRows.length === 2, String(shippedRows.length));
  check("shipped emails address the buyer",
    shippedRows.every((r) => r.to_email === "buyer@example.com"));
  check("shipped rows carry no order_id (per-parcel dedupe shape)",
    shippedRows.every((r) => r.order_id === null));
  check("shipped dedupe keys are per shipment and distinct",
    new Set(shippedRows.map((r) => r.dedupe_key)).size === 2 &&
    shippedRows.every((r) => String(r.dedupe_key).startsWith("print_shipped:")),
    JSON.stringify(shippedRows.map((r) => r.dedupe_key)));
  check("shipped text names the book, the carrier, and the tracking number",
    shippedRows.every((r) =>
      r.body_text.includes("Mira the Heron and the Still Water") &&
      r.body_text.includes("Carrier: USPS") &&
      r.body_text.includes("Tracking number: trk-")));

  await syncPrintJobs(db, env, { orderId: "ord-n1", site: SITE });
  check("re-sync enqueues no second shipped email", outboxRows("print_shipped").length === 2);

  setLuluState(submitted.items, "DELIVERED", true);
  await syncPrintJobs(db, env, { orderId: "ord-n1", site: SITE });
  const deliveredRows = outboxRows("print_delivered");
  check("one delivered email per parcel", deliveredRows.length === 2, String(deliveredRows.length));
  check("delivered email points at the library",
    deliveredRows.every((r) => r.body_text.includes(`${SITE}/account/library`)));
  await syncPrintJobs(db, env, { orderId: "ord-n1", site: SITE });
  check("delivered re-sync enqueues nothing new",
    outboxRows("print_delivered").length === 2 && outboxRows("print_shipped").length === 2);

  // -- The styled render branch rebuilds the model from the row.
  const shippedHtml = await renderOutboxEmailHtml(db, SITE, shippedRows[0]);
  check("print_shipped renders styled HTML",
    typeof shippedHtml === "string" && shippedHtml.length > 200,
    shippedHtml ? shippedHtml.slice(0, 120) : "null");
  check("shipped HTML carries the tracking button",
    !!shippedHtml && shippedHtml.includes("Track your package") && shippedHtml.includes("https://track.example/"));
  const deliveredHtml = await renderOutboxEmailHtml(db, SITE, deliveredRows[0]);
  check("print_delivered renders styled HTML with the library button",
    !!deliveredHtml && deliveredHtml.includes("Open your library") && deliveredHtml.includes(`${SITE}/account/library`));

  // -- Club box parcel: the member is the recipient, copy reads as
  // Book Club mail, and the row links the box.
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
  check("box job built", !!boxJob);
  await dispatchPrintJobs(db, env, { site: SITE });
  const boxSubmitted = await getPrintJobForBox(db, "box-1");
  const firstItem = boxSubmitted!.items[0];
  setLuluState([firstItem], "SHIPPED", true);
  await syncPrintJobs(db, env, { clubBoxId: "box-1", site: SITE });
  const boxShipped = outboxRows("print_shipped").filter((r) => r.club_box_id === "box-1");
  check("box parcel enqueues one shipped email", boxShipped.length === 1, String(boxShipped.length));
  check("box email addresses the member", boxShipped[0]?.to_email === "member@example.com");
  check("box email subject reads as Book Club mail",
    boxShipped[0]?.subject === "A Book Club book has shipped", boxShipped[0]?.subject);
  const boxHtml = await renderOutboxEmailHtml(db, SITE, boxShipped[0]);
  check("box shipped email renders the club headline",
    !!boxHtml && boxHtml.includes("A book from your Book Club box is on its way."));

  globalThis.fetch = originalFetch;
  console.log(`\nprint-notifications.test.ts: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  globalThis.fetch = originalFetch;
  console.error(err);
  process.exit(1);
});
