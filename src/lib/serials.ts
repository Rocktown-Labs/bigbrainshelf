// Serial minting for direct-sold copies (CG, 2026-11-05).
//
// Copies fulfilled on bigbrainshelf.com are numbered: the first 12
// stories are Volume 1, and every copy of a book sold here carries
// its own sequence number, stamped as "Vol. 1 #N". A KDP copy is a
// different file entirely and never gets one; the number is the
// direct channel's mark. The registry lives here (book_serials);
// the number is allocated once per copy from a per-book counter and
// never reused, and a public badge page (/v/{code}) verifies a copy
// from the short code printed beside the number.
//
// Mint triggers (get-or-create everywhere, so every path is
// idempotent and failure-isolated by its caller):
//   - Digital copies mint at their first stamped download, keyed to
//     the granting order or club box (lib/download-guard's grant).
//   - Printed and gift set copies mint when fulfillment can see
//     them: store orders once they reach the pack stage, club boxes
//     once their contents are set. The admin surfaces show the
//     numbers while the box is being packed.
//
// Volume is a fact about the book (books.volume). The column is
// added by ensureSerialSchema, which backfills 1 for the books that
// exist at that moment: they are the first stories, and Volume 1 is
// the first 12. A book created later has no volume until one is
// set, and unminted is the correct state for it until then.

import type { DBLike } from "./orders";
import { ensureOnce } from "./schema-cache";

export interface BookSerial {
  id: string;
  code: string;
  bookSlug: string;
  volume: number;
  serial: number;
  format: string;
  orderId: string | null;
  clubBoxId: string | null;
  mintedAt: number;
}

/** The stamp line, exactly as CG worded it: "Vol. 1 #42". */
export function serialLabel(volume: number, serial: number): string {
  return `Vol. ${volume} #${serial}`;
}

/** The public verification path for a copy's short code. */
export function serialVerifyPath(code: string): string {
  return `/v/${code}`;
}

export async function ensureSerialSchema(db: DBLike): Promise<void> {
  await ensureOnce(db, "book_serials", async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS serial_counters (
           book_slug TEXT PRIMARY KEY,
           last_serial INTEGER NOT NULL DEFAULT 0
         )`
      )
      .bind()
      .run();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS book_serials (
           id TEXT PRIMARY KEY,
           code TEXT NOT NULL UNIQUE,
           book_slug TEXT NOT NULL,
           volume INTEGER NOT NULL,
           serial INTEGER NOT NULL,
           format TEXT NOT NULL,
           order_id TEXT,
           club_box_id TEXT,
           grant_key TEXT NOT NULL UNIQUE,
           minted_at INTEGER NOT NULL,
           UNIQUE (book_slug, serial)
         )`
      )
      .bind()
      .run();
    // Volume is a book fact. The column lands once, and the books
    // that exist at that moment are the first stories: Volume 1.
    const { results } = await db
      .prepare("SELECT name FROM pragma_table_info('books')")
      .bind()
      .all();
    const have = new Set((results || []).map((r: any) => String(r.name)));
    if (!have.has("volume")) {
      await db.prepare("ALTER TABLE books ADD COLUMN volume INTEGER").bind().run();
      await db.prepare("UPDATE books SET volume = 1 WHERE volume IS NULL").bind().run();
    }
  });
}

function rowToSerial(row: any): BookSerial {
  return {
    id: String(row.id),
    code: String(row.code),
    bookSlug: String(row.book_slug),
    volume: Number(row.volume),
    serial: Number(row.serial),
    format: String(row.format),
    orderId: row.order_id ? String(row.order_id) : null,
    clubBoxId: row.club_box_id ? String(row.club_box_id) : null,
    mintedAt: Number(row.minted_at),
  };
}

async function serialByGrantKey(db: DBLike, grantKey: string): Promise<BookSerial | null> {
  const row = await db
    .prepare("SELECT * FROM book_serials WHERE grant_key = ?")
    .bind(grantKey)
    .first();
  return row ? rowToSerial(row) : null;
}

/**
 * Get the serial for one copy, minting it when this is the first
 * time the copy is seen. grantKey identifies the copy durably (one
 * key per copy, built by the caller: a download grant, a print unit
 * of an order, a club box slot). Returns null when the book has no
 * volume set: unminted is a real state, not an error.
 */
export async function getOrMintSerial(
  db: DBLike,
  args: {
    bookSlug: string;
    grantKey: string;
    format: string;
    orderId?: string | null;
    clubBoxId?: string | null;
  }
): Promise<BookSerial | null> {
  await ensureSerialSchema(db);
  const existing = await serialByGrantKey(db, args.grantKey);
  if (existing) return existing;
  const book = await db
    .prepare("SELECT volume FROM books WHERE slug = ?")
    .bind(args.bookSlug)
    .first() as any;
  const volume = book?.volume != null ? Number(book.volume) : null;
  if (!volume) return null;
  // One atomic statement allocates the next number for this book.
  const counter = await db
    .prepare(
      `INSERT INTO serial_counters (book_slug, last_serial) VALUES (?, 1)
       ON CONFLICT(book_slug) DO UPDATE SET last_serial = last_serial + 1
       RETURNING last_serial`
    )
    .bind(args.bookSlug)
    .first() as any;
  const serial = Number(counter?.last_serial);
  if (!serial) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = crypto.randomUUID();
    const code = id.replace(/-/g, "").slice(0, 8).toUpperCase();
    try {
      await db
        .prepare(
          `INSERT INTO book_serials (id, code, book_slug, volume, serial, format, order_id, club_box_id, grant_key, minted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          code,
          args.bookSlug,
          volume,
          serial,
          args.format,
          args.orderId || null,
          args.clubBoxId || null,
          args.grantKey,
          Math.floor(Date.now() / 1000)
        )
        .run();
      return {
        id,
        code,
        bookSlug: args.bookSlug,
        volume,
        serial,
        format: args.format,
        orderId: args.orderId || null,
        clubBoxId: args.clubBoxId || null,
        mintedAt: Math.floor(Date.now() / 1000),
      };
    } catch (err) {
      // A concurrent mint of the same copy won the grant key: read
      // the winner back. A code collision retries with a fresh id.
      const winner = await serialByGrantKey(db, args.grantKey);
      if (winner) return winner;
      if (attempt === 2) throw err;
    }
  }
  return null;
}

/** The serial minted for a digital copy granted by an order or a club box. */
export async function getOrMintDownloadSerial(
  db: DBLike,
  args: { bookSlug: string; orderId?: string | null; clubBoxId?: string | null }
): Promise<BookSerial | null> {
  if (args.orderId) {
    return getOrMintSerial(db, {
      bookSlug: args.bookSlug,
      grantKey: `order:${args.orderId}:${args.bookSlug}:digital`,
      format: "digital",
      orderId: args.orderId,
    });
  }
  if (args.clubBoxId) {
    return getOrMintSerial(db, {
      bookSlug: args.bookSlug,
      grantKey: `club-box:${args.clubBoxId}:${args.bookSlug}:digital`,
      format: "digital",
      clubBoxId: args.clubBoxId,
    });
  }
  return null;
}

/**
 * Mint (or read back) the serials for an order's physical copies:
 * one per printed or gift set unit, keyed per unit so repeat calls
 * converge. Digital copies are not minted here; they mint at
 * download. Returns the order's physical serials in item order.
 */
export async function mintOrderPrintSerials(
  db: DBLike,
  order: { id: string; items?: string | null }
): Promise<BookSerial[]> {
  let items: any[] = [];
  try {
    const parsed = JSON.parse(order.items || "[]");
    if (Array.isArray(parsed)) items = parsed;
  } catch { /* an order with unreadable items mints nothing */ }
  const out: BookSerial[] = [];
  const perSlugCount = new Map<string, number>();
  for (const it of items) {
    if (!it || (it.format !== "printed" && it.format !== "giftset") || !it.slug) continue;
    const qty = Math.max(1, Math.floor(Number(it.qty ?? it.quantity ?? 1)) || 1);
    for (let n = 0; n < qty; n++) {
      const idx = (perSlugCount.get(String(it.slug)) || 0) + 1;
      perSlugCount.set(String(it.slug), idx);
      const s = await getOrMintSerial(db, {
        bookSlug: String(it.slug),
        grantKey: `order:${order.id}:${it.slug}:print:${idx}`,
        format: String(it.format),
        orderId: order.id,
      });
      if (s) out.push(s);
    }
  }
  return out;
}

/** Every serial minted against an order (any format), oldest first. */
export async function listSerialsForOrder(db: DBLike, orderId: string): Promise<BookSerial[]> {
  await ensureSerialSchema(db);
  const { results } = await db
    .prepare("SELECT * FROM book_serials WHERE order_id = ? ORDER BY minted_at ASC, serial ASC")
    .bind(orderId)
    .all();
  return (results || []).map(rowToSerial);
}

/** Every serial minted against a club box, oldest first. */
export async function listSerialsForBox(db: DBLike, clubBoxId: string): Promise<BookSerial[]> {
  await ensureSerialSchema(db);
  const { results } = await db
    .prepare("SELECT * FROM book_serials WHERE club_box_id = ? ORDER BY minted_at ASC, serial ASC")
    .bind(clubBoxId)
    .all();
  return (results || []).map(rowToSerial);
}

/** One copy by its public short code (the badge page's lookup). */
export async function getSerialByCode(db: DBLike, code: string): Promise<BookSerial | null> {
  await ensureSerialSchema(db);
  const row = await db
    .prepare("SELECT * FROM book_serials WHERE code = ?")
    .bind(String(code || "").trim().toUpperCase())
    .first();
  return row ? rowToSerial(row) : null;
}
