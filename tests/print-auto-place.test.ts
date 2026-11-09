import { releaseBucket, seedPrintReleases } from "./helpers/release-fixture";
// Print auto-place (CG, 2026-11-07): a paid order with physical
// lines places its Lulu print job from the completion funnel itself
// (processCheckoutCompleted with env, the same call the Stripe
// webhook makes), best-effort so a Lulu outage never fails the
// order. Covers: lane on -> job built and submit attempted; Lulu
// down -> order still completes, job left queued for the cron;
// replayed completion -> still one job, one submit; lane off ->
// nothing built; manual orders -> never auto-placed (the admin
// button stays their trigger). The $0 in-place completion in
// /api/checkout calls the same helper; that hook is source-pinned
// here because the route itself needs a worker env to run.
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import {
  getOrCreatePendingOrder,
  attachStripeSession,
  processCheckoutCompleted,
  createManualOrder,
} from "../src/lib/orders";
import {
  autoPlacePrintJobForOrder,
  getPrintJobsForOrder,
} from "../src/lib/print-fulfillment";

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
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
    book_slugs TEXT NOT NULL DEFAULT '', items TEXT DEFAULT '', stripe_session_id TEXT UNIQUE,
    amount INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'usd',
    status TEXT NOT NULL DEFAULT 'pending', delivery_token TEXT, cart_fingerprint TEXT,
    physical_status TEXT, ship_name TEXT, ship_address TEXT,
    shipping_cents INTEGER NOT NULL DEFAULT 0, carrier TEXT, tracking_number TEXT,
    label_url TEXT, shippo_shipment_id TEXT, shippo_transaction_id TEXT,
    source TEXT, admin_note TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER
  );
  CREATE UNIQUE INDEX orders_pending_fp_idx ON orders(user_id, cart_fingerprint) WHERE status = 'pending';
  CREATE TABLE webhook_events (event_id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at INTEGER NOT NULL, processed_at INTEGER, result TEXT);
  CREATE TABLE email_outbox (
    id TEXT PRIMARY KEY, order_id TEXT, kind TEXT NOT NULL, to_email TEXT NOT NULL,
    subject TEXT NOT NULL, body_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL, sent_at INTEGER
  );
  CREATE UNIQUE INDEX email_outbox_order_kind_idx ON email_outbox(order_id, kind) WHERE order_id IS NOT NULL;
`);

raw.prepare("INSERT INTO books (slug, title, status, public_slug) VALUES (?, ?, 'complete', ?)")
  .run("mira-the-heron-and-the-still-water", "Mira the Heron and the Still Water", "mira-the-heron-and-the-still-water");

// Fake R2 with a real stock interior so personalization runs.
const objects = new Map<string, Uint8Array>();
const fakeBooks = releaseBucket(objects);

const SITE = "https://bigbrainshelf.com";
const env: any = {
  FULFILLMENT_PROVIDER: "lulu",
  LULU_ENV: "sandbox",
  LULU_SANDBOX_CLIENT_ID: "cid-sandbox",
  LULU_SANDBOX_CLIENT_SECRET: "secret-sandbox",
  BOOKS: fakeBooks,
  BETTER_AUTH_URL: SITE,
};
const laneOffEnv: any = { BOOKS: fakeBooks, BETTER_AUTH_URL: SITE };

// Stubbed Lulu API with a kill switch: "down" makes every call fail
// the way a Lulu outage would.
const originalFetch = globalThis.fetch;
let createBodies: any[] = [];
let luluDown = false;
function installFetch() {
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    const method = String(init.method || "GET").toUpperCase();
    if (luluDown) throw new TypeError("fetch failed (simulated Lulu outage)");
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
    return new Response("unexpected url " + u, { status: 500 });
  }) as any;
}

const MIRA = "mira-the-heron-and-the-still-water";
const printedCart = [{ slug: MIRA, format: "printed", qty: 1 }];
const shipMeta = {
  ship_name: "Test Buyer",
  ship_address: JSON.stringify({ line1: "100 W Race Ave", line2: "", city: "Searcy", state: "AR", postal_code: "72143", country: "US" }),
};

async function completePaidOrder(
  orderId: string,
  sessionId: string,
  withEnv: any,
  items: any[] = printedCart,
  amount = 3299
) {
  await attachStripeSession(db, orderId, sessionId);
  return processCheckoutCompleted(db, SITE, {
    id: sessionId,
    amount_total: amount,
    currency: "usd",
    customer_details: { email: "buyer@example.com" },
    metadata: {
      user_id: "user-1",
      order_id: orderId,
      items: JSON.stringify(items),
      slugs: MIRA,
      shipping_cents: "800",
      ...shipMeta,
    },
    shipping_cost: { amount_total: 800 },
  }, withEnv);
}

async function main() {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 5; i++) doc.addPage([612, 792]);
  objects.set("books/mira-the-heron-and-the-still-water/print/story-interior.pdf", await doc.save());
  await seedPrintReleases(raw, db, fakeBooks, objects);
  installFetch();

  // -- Lane on: completion builds the job and submits it.
  const p1 = await getOrCreatePendingOrder(db, { userId: "user-1", email: "buyer@example.com", items: printedCart, amount: 3299 });
  const done1 = await completePaidOrder(p1.id, "cs_auto_1", env);
  check("lane on: the order completes", done1?.status === "complete", JSON.stringify(done1?.status));
  const jobs1 = await getPrintJobsForOrder(db, p1.id);
  check("lane on: completion built exactly one print job", jobs1.length === 1, String(jobs1.length));
  check("lane on: the job was submitted immediately",
    jobs1[0]?.status === "submitted" && jobs1[0]?.luluJobId === "555001",
    JSON.stringify({ status: jobs1[0]?.status, lulu: jobs1[0]?.luluJobId }));
  check("lane on: exactly one create call reached Lulu", createBodies.length === 1, String(createBodies.length));

  // -- Replayed completion: idempotent, no second job or submit.
  const done1b = await completePaidOrder(p1.id, "cs_auto_1", env);
  check("replay: the order still completes", done1b?.status === "complete");
  check("replay: still exactly one print job", (await getPrintJobsForOrder(db, p1.id)).length === 1);
  check("replay: no second create call", createBodies.length === 1, String(createBodies.length));

  // -- Lulu down: the order completes anyway; the job stays queued
  // for the cron dispatcher with the failed attempt recorded. (Qty 2
  // makes this a different cart from the first order, so the pending
  // order dedupe does not hand back the completed one.)
  luluDown = true;
  const qty2Cart = [{ slug: MIRA, format: "printed", qty: 2 }];
  const p2qty = await getOrCreatePendingOrder(db, { userId: "user-1", email: "buyer@example.com", items: qty2Cart, amount: 5798 });
  const done2 = await completePaidOrder(p2qty.id, "cs_auto_2", env, qty2Cart, 5798);
  check("lulu down: the order completes", done2?.status === "complete", JSON.stringify(done2?.status));
  const jobs2 = await getPrintJobsForOrder(db, p2qty.id);
  check("lulu down: the job was still built", jobs2.length === 1, String(jobs2.length));
  check("lulu down: the job waits queued for the cron",
    jobs2[0]?.status === "queued" && jobs2[0]?.attempts === 1 && !!jobs2[0]?.lastError,
    JSON.stringify({ status: jobs2[0]?.status, attempts: jobs2[0]?.attempts, err: jobs2[0]?.lastError }));
  luluDown = false;

  // -- Lane off: completion builds nothing.
  const p3 = await getOrCreatePendingOrder(db, { userId: "user-2", email: "other@example.com", items: printedCart, amount: 3299 });
  const done3 = await completePaidOrder(p3.id, "cs_auto_3", laneOffEnv);
  check("lane off: the order completes", done3?.status === "complete");
  check("lane off: no print job is built", (await getPrintJobsForOrder(db, p3.id)).length === 0);

  // -- No env at all (every pre-lane caller): nothing built.
  const p4 = await getOrCreatePendingOrder(db, { userId: "user-3", email: "third@example.com", items: printedCart, amount: 3299 });
  const done4 = await completePaidOrder(p4.id, "cs_auto_4", undefined);
  check("no env: the order completes", done4?.status === "complete");
  check("no env: no print job is built", (await getPrintJobsForOrder(db, p4.id)).length === 0);

  // -- Manual orders never auto-place, even with the lane on and
  // the helper called directly on the completed order row.
  const manual = await createManualOrder(db, {
    name: "Test Buyer",
    email: "buyer@example.com",
    address: { line1: "100 W Race Ave", city: "Searcy", state: "AR", postal_code: "72143", country: "US" },
    lines: [{ slug: MIRA, format: "printed", qty: 1, priceCents: 2499 }],
    shippingCents: 800,
  });
  check("manual order created", manual.ok === true, JSON.stringify(manual));
  if (manual.ok) {
    check("manual order carries source manual", manual.order.source === "manual", String(manual.order.source));
    const placed = await autoPlacePrintJobForOrder(db, env, manual.order, SITE);
    check("manual order: the helper refuses to place", placed === null);
    check("manual order: no print job exists", (await getPrintJobsForOrder(db, manual.order.id)).length === 0);
  }

  // -- Source pin: the $0 in-place completion calls the same helper.
  const checkoutSrc = readFileSync(new URL("../src/pages/api/checkout.ts", import.meta.url), "utf8");
  check("checkout $0 path hooks auto-place",
    checkoutSrc.includes("autoPlacePrintJobForOrder") && checkoutSrc.includes('await import("../../lib/print-fulfillment")'));

  globalThis.fetch = originalFetch;
  console.log(`\nprint-auto-place.test.ts: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  globalThis.fetch = originalFetch;
  console.error(err);
  process.exit(1);
});
