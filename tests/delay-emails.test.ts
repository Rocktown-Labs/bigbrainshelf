// Running-late emails (admin redesign S5): at the first missed
// ship-by date, a paid printed order or a settled Book Club box gets
// exactly one apology email (fault admitted, what is late, a new
// expected date, the SORRY10 make-good, one Track your order CTA).
// These tests pin the trigger signals, the once-only dedupe, the
// styled render branch for both kinds, and the SORRY10 terms in
// lib/promo.ts (10% off a next order for a returning customer, no
// club year granted).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  runDelayEmailScheduler,
  ORDER_DELAYED_KIND,
  CLUB_BOX_DELAYED_KIND,
} from "../src/lib/delay-emails";
import { renderOutboxEmailHtml } from "../src/lib/email-render";
import { senderForKind } from "../src/lib/orders";
import { validatePromo, grantPromoClubYear } from "../src/lib/promo";
import {
  addDaysToDateString,
  dateStringFromUnixSeconds,
  formatClubDate,
} from "../src/lib/club-cycle-dates";

function makeDb(): any {
  const sqlite = new Database(":memory:");
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async run() {
          const info = sqlite.query(sql).run(...(binds as never[]));
          return { meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
        },
        async first<T>() {
          return (sqlite.query(sql).get(...(binds as never[])) ?? null) as T | null;
        },
        async all<T>() {
          return { results: sqlite.query(sql).all(...(binds as never[])) as T[] };
        },
      };
      return stmt;
    },
    _sqlite: sqlite,
  };
  return db;
}

const SITE = "https://bigbrainshelf.com";
const db = makeDb();
const sql = db._sqlite;

sql.run(`CREATE TABLE books (slug TEXT PRIMARY KEY, title TEXT, price INTEGER, price_print INTEGER,
  picture_book_key TEXT, coloring_book_key TEXT, epub_key TEXT, color_book_key TEXT, audiobook_key TEXT)`);
sql.run(`CREATE TABLE orders (id TEXT PRIMARY KEY, email TEXT, user_id TEXT, status TEXT,
  physical_status TEXT, items TEXT, amount INTEGER, created_at INTEGER,
  promo_code TEXT, promo_discount_cents INTEGER)`);
sql.run(`CREATE TABLE club_signups (id TEXT PRIMARY KEY, email TEXT, user_id TEXT)`);
sql.run(`CREATE TABLE club_cycle_boxes (id TEXT PRIMARY KEY, signup_id TEXT, ship_date TEXT,
  status TEXT, resolved_book_slug TEXT, created_at INTEGER, carrier TEXT, tracking_number TEXT)`);
sql.run(`CREATE TABLE email_outbox (id TEXT PRIMARY KEY, order_id TEXT, kind TEXT, to_email TEXT,
  subject TEXT, body_text TEXT, status TEXT, attempts INTEGER, created_at INTEGER,
  send_after INTEGER, from_email TEXT, dedupe_key TEXT, club_box_id TEXT, reply_to TEXT,
  sent_at INTEGER, last_error TEXT)`);
sql.run(`CREATE UNIQUE INDEX email_outbox_order_kind_idx ON email_outbox(order_id, kind) WHERE order_id IS NOT NULL`);
sql.run(`CREATE UNIQUE INDEX email_outbox_dedupe_idx ON email_outbox(dedupe_key) WHERE dedupe_key IS NOT NULL`);

const nowSec = Math.floor(Date.now() / 1000);
const today = dateStringFromUnixSeconds(nowSec);
// A unix timestamp at midday UTC on a Chicago calendar date, so the
// order's Chicago creation date is exactly the date intended.
const tsOn = (dateStr: string) => Math.floor(Date.parse(`${dateStr}T12:00:00Z`) / 1000);

sql.run(
  "INSERT INTO books (slug, title) VALUES ('mira-the-heron-and-the-still-water', 'Mira the Heron and the Still Water')"
);
const items = JSON.stringify([{ slug: "mira-the-heron-and-the-still-water", format: "printed", qty: 1 }]);
const addOrder = (id: string, createdDate: string, physicalStatus: string | null, email = "buyer@example.com") =>
  sql.run(
    "INSERT INTO orders (id, email, user_id, status, physical_status, items, amount, created_at) VALUES (?, ?, 'user-1', 'complete', ?, ?, 2836, ?)",
    [id, email, physicalStatus, items, tsOn(createdDate)]
  );

// Ship-by for an order is its creation date + 7 days.
addOrder("order-late", addDaysToDateString(today, -10), "packed"); // ship-by was 3 days ago
addOrder("order-boundary", addDaysToDateString(today, -7), "in_print"); // ships by today: not late
addOrder("order-fresh", addDaysToDateString(today, -2), "preorder_received");
addOrder("order-shipped", addDaysToDateString(today, -10), "shipped");
addOrder("order-digital", addDaysToDateString(today, -10), null);

sql.run("INSERT INTO club_signups (id, email, user_id) VALUES ('member-1', 'member@example.com', 'user-2')");
const addBox = (id: string, shipDate: string, status: string, signup = "member-1") =>
  sql.run(
    "INSERT INTO club_cycle_boxes (id, signup_id, ship_date, status, resolved_book_slug, created_at) VALUES (?, ?, ?, ?, 'mira-the-heron-and-the-still-water', ?)",
    [id, signup, shipDate, status, tsOn(shipDate)]
  );
// Ship-by for a box is its ship_date + 7 days.
addBox("box-late", addDaysToDateString(today, -10), "locked"); // ship-by was 3 days ago
addBox("box-boundary", addDaysToDateString(today, -7), "preparing"); // ships by today: not late
addBox("box-attention", addDaysToDateString(today, -10), "needs_attention"); // waiting on the member
addBox("box-shipped", addDaysToDateString(today, -10), "shipped");
addBox("box-memberless", addDaysToDateString(today, -10), "locked", "no-such-member");

const outboxRows = (kind: string) =>
  sql.query("SELECT * FROM email_outbox WHERE kind = ?").all(kind) as any[];

describe("delay email scheduler", () => {
  test("queues exactly one apology for the late order and the late box", async () => {
    const summary = await runDelayEmailScheduler(db, SITE, new Date());
    expect(summary).toEqual({ ordersQueued: 1, boxesQueued: 1 });

    const orderRows = outboxRows(ORDER_DELAYED_KIND);
    expect(orderRows.length).toBe(1);
    const row = orderRows[0];
    expect(row.order_id).toBe("order-late");
    expect(row.to_email).toBe("buyer@example.com");
    expect(row.subject).toBe("Your Big Brain Shelf order is running late");
    // The stored text admits fault, names the missed and the new
    // dates, lists the late book, and carries the make-good + CTA.
    expect(row.body_text).toContain("that is on us");
    expect(row.body_text).toContain(`ship by ${formatClubDate(addDaysToDateString(today, -3))}`);
    expect(row.body_text).toContain(`ship by ${formatClubDate(addDaysToDateString(today, 3))}`);
    expect(row.body_text).toContain("Mira the Heron and the Still Water (printed)");
    expect(row.body_text).toContain("SORRY10");
    expect(row.body_text).toContain(`Track your order: ${SITE}/account/orders`);
    expect(row.body_text).not.toContain("—");

    const boxRows = outboxRows(CLUB_BOX_DELAYED_KIND);
    expect(boxRows.length).toBe(1);
    expect(boxRows[0].club_box_id).toBe("box-late");
    expect(boxRows[0].dedupe_key).toBe("club_box:box-late:club_box_delayed");
    expect(boxRows[0].to_email).toBe("member@example.com");
    expect(boxRows[0].body_text).toContain("Mira the Heron and the Still Water, your club book for this box");
    expect(boxRows[0].body_text).toContain(`Track your order: ${SITE}/account/club`);
  });

  test("a second pass queues nothing new", async () => {
    const summary = await runDelayEmailScheduler(db, SITE, new Date());
    expect(summary).toEqual({ ordersQueued: 0, boxesQueued: 0 });
    expect(outboxRows(ORDER_DELAYED_KIND).length).toBe(1);
    expect(outboxRows(CLUB_BOX_DELAYED_KIND).length).toBe(1);
  });

  test("delay mail stays on the orders@ default sender", () => {
    expect(senderForKind(ORDER_DELAYED_KIND)).toBe(null);
    expect(senderForKind(CLUB_BOX_DELAYED_KIND)).toBe(null);
  });
});

describe("delay email render branch", () => {
  test("the order kind renders styled HTML with its one CTA", async () => {
    const row = outboxRows(ORDER_DELAYED_KIND)[0];
    const html = await renderOutboxEmailHtml(db, SITE, row);
    expect(typeof html).toBe("string");
    expect(html!.length).toBeGreaterThan(200);
    expect(html).toContain("Your order is running late, and that is on us");
    expect(html).toContain("Mira the Heron and the Still Water (printed)");
    expect(html).toContain("SORRY10");
    expect(html).toContain("Track your order");
    expect(html).toContain(`${SITE}/account/orders`);
    expect(html).not.toContain("Open your account");
  });

  test("the club box kind renders styled HTML with its one CTA", async () => {
    const row = outboxRows(CLUB_BOX_DELAYED_KIND)[0];
    const html = await renderOutboxEmailHtml(db, SITE, row);
    expect(typeof html).toBe("string");
    expect(html!.length).toBeGreaterThan(200);
    expect(html).toContain("Your Book Club box is running late, and that is on us");
    expect(html).toContain("Mira the Heron and the Still Water");
    expect(html).toContain("Track your order");
    expect(html).toContain(`${SITE}/account/club`);
  });
});

describe("SORRY10 promo terms", () => {
  test("a returning customer can redeem SORRY10 for 10% off, FOUNDING15 still refuses them", async () => {
    const sorry = await validatePromo(db, {
      code: "SORRY10",
      email: "buyer@example.com",
      userId: "user-1",
      subtotalCents: 2000,
    });
    expect(sorry.ok).toBe(true);
    expect(sorry.discountCents).toBe(200);

    const founding = await validatePromo(db, {
      code: "FOUNDING15",
      email: "buyer@example.com",
      userId: "user-1",
      subtotalCents: 4500,
    });
    expect(founding.ok).toBe(false);
  });

  test("completing a SORRY10 order finalizes the redemption and grants no club year", async () => {
    sql.run(
      "INSERT INTO orders (id, email, user_id, status, physical_status, items, amount, created_at, promo_code, promo_discount_cents) VALUES ('order-sorry', 'buyer@example.com', 'user-1', 'complete', null, '[]', 1800, ?, 'SORRY10', 200)",
      [nowSec]
    );
    const order: any = sql.query("SELECT * FROM orders WHERE id = 'order-sorry'").get();
    const membersBefore = (sql.query("SELECT COUNT(*) AS n FROM club_signups").get() as any).n;

    const granted = await grantPromoClubYear(db, SITE, {
      order,
      session: { metadata: { promo_code: "SORRY10" } },
    });
    expect(granted).toBe(null);
    const redemption: any = sql
      .query("SELECT * FROM promo_redemptions WHERE order_id = 'order-sorry'")
      .get();
    expect(redemption?.status).toBe("completed");
    const membersAfter = (sql.query("SELECT COUNT(*) AS n FROM club_signups").get() as any).n;
    expect(membersAfter).toBe(membersBefore);

    // One redemption per customer: the code is spent for this buyer.
    const again = await validatePromo(db, {
      code: "SORRY10",
      email: "buyer@example.com",
      userId: "user-1",
      subtotalCents: 2000,
    });
    expect(again.ok).toBe(false);
  });
});
