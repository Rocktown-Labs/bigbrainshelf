// Lulu webhook (src/pages/api/lulu/webhook.ts -> handleLuluWebhookPost):
// the fast path into the same sync the cron poll runs. Dark (404)
// while LULU_WEBHOOK_SECRET is unset; 401 on a bad HMAC-SHA256
// signature; each event recorded before processing so a duplicate
// delivery never re-runs the sync or re-enqueues parcel email; a
// handler failure answers 500 with the event left unprocessed, so
// Lulu's retry re-runs it once the upstream is healthy again.
import { Database } from "bun:sqlite";
import { PDFDocument } from "pdf-lib";
import {
  buildJobsForOrder,
  dispatchPrintJobs,
  ensurePrintSchema,
  getPrintJobsForOrder,
  handleLuluWebhookPost,
  seedPrintables,
} from "../src/lib/print-fulfillment";
import { verifyLuluWebhookSignature } from "../src/lib/lulu";

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

const objects = new Map<string, Uint8Array>();
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

const SECRET = "whsec_test_value";
const SITE = "https://bigbrainshelf.com";
const env: any = {
  FULFILLMENT_PROVIDER: "lulu",
  LULU_ENV: "sandbox",
  LULU_SANDBOX_CLIENT_ID: "cid-sandbox",
  LULU_SANDBOX_CLIENT_SECRET: "secret-sandbox",
  LULU_WEBHOOK_SECRET: SECRET,
  BOOKS: fakeBooks,
  BETTER_AUTH_URL: SITE,
};
const envNoSecret: any = { ...env, LULU_WEBHOOK_SECRET: undefined };

const originalFetch = globalThis.fetch;
let luluStatus: any = null;
let luluJob: any = null;
let statusFails = false;
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
      if (statusFails) return new Response("lulu is having a moment", { status: 500 });
      return new Response(JSON.stringify(luluStatus), { status: 200 });
    }
    if (u.endsWith("/print-jobs/555001/") && method === "GET") {
      if (statusFails) return new Response("lulu is having a moment", { status: 500 });
      return new Response(JSON.stringify(luluJob), { status: 200 });
    }
    return new Response("unexpected url " + u, { status: 500 });
  }) as any;
}

async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

function webhookRequest(body: string, signature: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) headers["Lulu-HMAC-SHA256"] = signature;
  return new Request("https://bigbrainshelf.com/api/lulu/webhook", { method: "POST", headers, body });
}

const shippedCount = () =>
  (raw.query("SELECT COUNT(*) AS n FROM email_outbox WHERE kind = 'print_shipped'").get() as any).n as number;

// The events table is ensured on the first secret-configured call;
// the dark (404) path returns before that, so counts tolerate the
// table not existing yet.
const eventTableCount = () => {
  try {
    return (raw.query("SELECT COUNT(*) AS n FROM lulu_webhook_events").get() as any).n as number;
  } catch {
    return 0;
  }
};

async function main() {
  // Signature primitive accepts hex and base64 digests, rejects
  // anything else (Lulu's docs do not pin the encoding).
  const probeBody = '{"topic":"PRINT_JOB_STATUS_CHANGED"}';
  const hex = await sign(probeBody);
  check("verifier accepts the hex digest", await verifyLuluWebhookSignature(SECRET, probeBody, hex));
  const b64 = Buffer.from(Buffer.from(hex, "hex")).toString("base64");
  check("verifier accepts the base64 digest", await verifyLuluWebhookSignature(SECRET, probeBody, b64));
  check("verifier rejects a foreign signature",
    !(await verifyLuluWebhookSignature(SECRET, probeBody, await sign(probeBody, "another-secret"))));
  check("verifier rejects a missing header", !(await verifyLuluWebhookSignature(SECRET, probeBody, null)));

  await ensurePrintSchema(db);
  await seedPrintables(db);
  const doc = await PDFDocument.create();
  for (let i = 0; i < 5; i++) doc.addPage([612, 792]);
  objects.set("books/mira-the-heron-and-the-still-water/print/story-interior.pdf", await doc.save());
  installFetch();

  raw.prepare(
    `INSERT INTO orders (id, email, total_cents, status, items, book_slugs, ship_name, ship_address, physical_status, created_at, updated_at)
     VALUES ('ord-w1', 'buyer@example.com', 2499, 'complete', ?, 'mira-the-heron-and-the-still-water', 'Test Buyer', ?, 'preorder_received', 1000, 1000)`
  ).run(
    JSON.stringify([{ slug: "mira-the-heron-and-the-still-water", format: "printed", qty: 1 }]),
    JSON.stringify({ line1: "100 W Race Ave", line2: "", city: "Searcy", state: "AR", postal_code: "72143", country: "US" }),
  );
  const order = raw.query("SELECT * FROM orders WHERE id = 'ord-w1'").get() as any;
  await buildJobsForOrder(db, env, order);
  await dispatchPrintJobs(db, env, { site: SITE });
  const submitted = (await getPrintJobsForOrder(db, "ord-w1"))[0];
  check("setup: job submitted", submitted?.status === "submitted", submitted?.status);
  const item = submitted.items[0];

  const shippedJob = {
    id: 555001,
    external_id: "order:ord-w1",
    status: { name: "SHIPPED" },
    line_items: [{
      id: Number(item.luluLineItemId), external_id: item.externalId, status: { name: "SHIPPED" },
      tracking_id: "trk-web1", tracking_urls: ["https://track.example/web1"], carrier_name: "USPS",
    }],
  };
  luluJob = shippedJob;
  luluStatus = {
    name: "SHIPPED",
    line_item_statuses: [{
      name: "SHIPPED", line_item_id: Number(item.luluLineItemId),
      messages: { tracking_id: "trk-web1", tracking_urls: ["https://track.example/web1"], carrier_name: "USPS" },
    }],
    print_job_id: 555001,
  };
  const eventBody = JSON.stringify({ topic: "PRINT_JOB_STATUS_CHANGED", data: shippedJob });

  // Dark while the secret is unset.
  const dark = await handleLuluWebhookPost(db, envNoSecret, webhookRequest(eventBody, await sign(eventBody)), SITE);
  check("secret unset: the route is dark (404)", dark.status === 404, String(dark.status));

  // Bad signature -> 401, and nothing is recorded.
  const bad = await handleLuluWebhookPost(db, env, webhookRequest(eventBody, "deadbeef".repeat(8)), SITE);
  check("bad signature: 401", bad.status === 401, String(bad.status));
  check("bad signature: no event recorded", eventTableCount() === 0, String(eventTableCount()));

  // Valid signature: records, processes, syncs, enqueues the parcel email.
  const ok = await handleLuluWebhookPost(db, env, webhookRequest(eventBody, await sign(eventBody)), SITE);
  check("valid signature: 200", ok.status === 200, String(ok.status));
  const orderAfter = raw.query("SELECT physical_status FROM orders WHERE id = 'ord-w1'").get() as any;
  check("valid event syncs the order to shipped", orderAfter.physical_status === "shipped", orderAfter.physical_status);
  check("valid event enqueues exactly one shipped email", shippedCount() === 1, String(shippedCount()));
  const eventRow = raw.query("SELECT * FROM lulu_webhook_events").get() as any;
  check("event recorded and marked processed",
    !!eventRow && eventRow.processed_at != null && String(eventRow.lulu_job_id) === "555001",
    JSON.stringify(eventRow));

  // Duplicate delivery: same body and signature, no reprocessing.
  const dup = await handleLuluWebhookPost(db, env, webhookRequest(eventBody, await sign(eventBody)), SITE);
  check("duplicate delivery: still 200", dup.status === 200, String(dup.status));
  check("duplicate delivery: no second shipped email", shippedCount() === 1, String(shippedCount()));
  check("duplicate delivery: still one recorded event", eventTableCount() === 1, String(eventTableCount()));

  // Handler failure: 500, event stays unprocessed, and Lulu's retry
  // (the same body again) succeeds once the upstream recovers.
  const inProdBody = JSON.stringify({
    topic: "PRINT_JOB_STATUS_CHANGED",
    data: { id: 555001, external_id: "order:ord-w1", status: { name: "IN_PRODUCTION" }, line_items: shippedJob.line_items },
  });
  statusFails = true;
  const err = await handleLuluWebhookPost(db, env, webhookRequest(inProdBody, await sign(inProdBody)), SITE);
  check("upstream failure: 500 so Lulu retries", err.status === 500, String(err.status));
  const stuckRow = raw.query("SELECT * FROM lulu_webhook_events WHERE status_name = 'IN_PRODUCTION'").get() as any;
  check("failed event is recorded but unprocessed", !!stuckRow && stuckRow.processed_at == null);
  statusFails = false;
  const retry = await handleLuluWebhookPost(db, env, webhookRequest(inProdBody, await sign(inProdBody)), SITE);
  check("retry after recovery: 200", retry.status === 200, String(retry.status));
  const fixedRow = raw.query("SELECT * FROM lulu_webhook_events WHERE status_name = 'IN_PRODUCTION'").get() as any;
  check("retried event is now processed", fixedRow.processed_at != null);

  // Unknown job: recorded, ignored, still 200 (a 500 would burn retries).
  const unknownBody = JSON.stringify({
    topic: "PRINT_JOB_STATUS_CHANGED",
    data: { id: 999999, external_id: "order:nobody", status: { name: "SHIPPED" }, line_items: [] },
  });
  const unknown = await handleLuluWebhookPost(db, env, webhookRequest(unknownBody, await sign(unknownBody)), SITE);
  check("unknown job: 200, not an error", unknown.status === 200, String(unknown.status));
  const unknownRow = raw.query("SELECT * FROM lulu_webhook_events WHERE lulu_job_id = '999999'").get() as any;
  check("unknown job: recorded as ignored and processed",
    !!unknownRow && unknownRow.processed_at != null && String(unknownRow.result || "").includes("ignored"),
    JSON.stringify(unknownRow));
  check("unknown job: no extra email", shippedCount() === 1);

  // Unparseable body with a valid signature: 400.
  const garbage = "{not json";
  const badJson = await handleLuluWebhookPost(db, env, webhookRequest(garbage, await sign(garbage)), SITE);
  check("unparseable body: 400", badJson.status === 400, String(badJson.status));

  globalThis.fetch = originalFetch;
  console.log(`\nlulu-webhook.test.ts: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  globalThis.fetch = originalFetch;
  console.error(err);
  process.exit(1);
});
