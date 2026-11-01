// Download guard for OWNED files (owner-approved protection plan,
// 2026-10-29, on top of the lock model): gating alone says who may
// download; this module says WHICH purchase a download belongs to, so
// the file can be stamped for that buyer (lib/pdf-stamp) and counted
// against that purchase's download budget.
//
// The budget: DOWNLOAD_LIMIT downloads per purchase per file kind,
// counted in the download_counts table (created here at runtime, the
// same ensure-at-runtime pattern as the Shippo order columns, and
// mirrored in migration.sql). The account route (/api/download) is
// the only file server now (emailed token links redirect into the
// library since 2026-10-31) and it keys the budget on the granting
// order's id. A book that arrived in a shipped club box has no
// order row; its budget keys on the box ("club-box:{id}") instead.
// Streaming, reader page views, and library playback never pass
// through here and never count.
import { parseItems, shortOrderId, type DBLike } from "./orders";
import { formatGrantsDigital, formatGrantsAudio } from "./library";
import { ensureClubTable } from "./club";
import { ensureClubCycleTables } from "./club-cycles";

export const DOWNLOAD_LIMIT = 5;

export const DOWNLOAD_LIMIT_MESSAGE =
  "You have reached the download limit for this file (5 downloads per purchase). If you still need it, email support@bigbrainshelf.com and we will reset your downloads.";

export type DownloadFileKind = "picture" | "coloring" | "epub" | "color" | "audiobook";

export interface DownloadGrant {
  /** Budget key: the order id for order grants, "club-box:{id}" for box grants. */
  grantKey: string;
  /** The granting order's id, or null for club-box grants. */
  orderId: string | null;
  /** "#A1B2C3D4" display form, or null for club-box grants. */
  shortId: string | null;
  /** Metadata marker for the PDF stamp: the order id, or the grant key. */
  marker: string;
  markerIsOrder: boolean;
  buyerEmail: string;
}

const ensured = new WeakSet<object>();

export async function ensureDownloadCountsTable(db: DBLike): Promise<void> {
  if (ensured.has(db as object)) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS download_counts (
        grant_key TEXT NOT NULL,
        order_id TEXT,
        slug TEXT NOT NULL,
        file_kind TEXT NOT NULL,
        download_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (grant_key, slug, file_kind)
      )`
    )
    .bind()
    .run();
  await db
    .prepare("CREATE INDEX IF NOT EXISTS download_counts_order_idx ON download_counts(order_id)")
    .bind()
    .run();
  ensured.add(db as object);
}

/** Does one order grant this slug's file of the given kind? Mirrors the
 * ownership rules in lib/library: recorded items decide by format; a
 * slug with no items behind it is a legacy row and grants everything. */
function orderGrantsFile(order: any, slug: string, format: DownloadFileKind): boolean {
  const items = parseItems(order).filter((i) => i.slug === slug);
  if (items.length) {
    return format === "audiobook"
      ? items.some((i) => formatGrantsAudio(i.format))
      : items.some((i) => formatGrantsDigital(i.format));
  }
  try {
    const slugs = JSON.parse(order?.book_slugs || "[]");
    return Array.isArray(slugs) && slugs.map(String).includes(slug);
  } catch {
    return false;
  }
}

/**
 * The earliest completed order of this user that grants the file, or
 * null. This is the purchase the download is stamped and counted
 * against, whichever route serves it.
 */
export async function resolveOrderGrant(
  db: DBLike,
  user: { id: string; email: string },
  slug: string,
  format: DownloadFileKind
): Promise<DownloadGrant | null> {
  const userId = String(user?.id || "");
  const email = String(user?.email || "").trim().toLowerCase();
  const { results } = await db
    .prepare(
      "SELECT * FROM orders WHERE status = 'complete' AND (user_id = ? OR email = ?) ORDER BY created_at ASC"
    )
    .bind(userId, email)
    .all();
  for (const order of (results || []) as any[]) {
    if (!orderGrantsFile(order, slug, format)) continue;
    const orderId = String(order.id);
    return {
      grantKey: orderId,
      orderId,
      shortId: shortOrderId(orderId),
      marker: orderId,
      markerIsOrder: true,
      buyerEmail: String(order.email || email),
    };
  }
  return null;
}

/**
 * A shipped/delivered club box that brought this book, or null. Box
 * grants carry no order, so the stamp names the buyer alone and the
 * budget keys on the box.
 */
export async function resolveBoxGrant(
  db: DBLike,
  user: { id: string; email: string },
  slug: string
): Promise<DownloadGrant | null> {
  const userId = String(user?.id || "");
  const email = String(user?.email || "").trim().toLowerCase();
  try {
    await ensureClubTable(db);
    await ensureClubCycleTables(db);
    const member = (await db
      .prepare("SELECT id FROM club_signups WHERE email = ? OR user_id = ? LIMIT 1")
      .bind(email, userId)
      .first()) as any;
    if (!member?.id) return null;
    const boxes = await db
      .prepare(
        `SELECT id FROM club_cycle_boxes
         WHERE signup_id = ? AND (resolved_book_slug = ? OR second_resolved_book_slug = ?)
           AND status IN ('shipped', 'delivered') LIMIT 1`
      )
      .bind(member.id, slug, slug)
      .first() as any;
    if (!boxes?.id) return null;
    const grantKey = `club-box:${String(boxes.id)}`;
    return {
      grantKey,
      orderId: null,
      shortId: null,
      marker: grantKey,
      markerIsOrder: false,
      buyerEmail: email,
    };
  } catch {
    return null;
  }
}

/** The grant for a guest token download: the order behind the token. */
export function grantForOrder(order: any): DownloadGrant {
  const orderId = String(order?.id || "");
  return {
    grantKey: orderId,
    orderId,
    shortId: shortOrderId(orderId),
    marker: orderId,
    markerIsOrder: true,
    buyerEmail: String(order?.email || ""),
  };
}

/**
 * Count one download against the grant's budget and report whether it
 * may proceed. The count is taken BEFORE serving, and callers check
 * the file exists in R2 first, so missing files never consume budget.
 */
export async function consumeDownload(
  db: DBLike,
  grant: DownloadGrant,
  slug: string,
  format: DownloadFileKind
): Promise<{ ok: boolean; count: number; limit: number }> {
  await ensureDownloadCountsTable(db);
  const row = (await db
    .prepare("SELECT download_count FROM download_counts WHERE grant_key = ? AND slug = ? AND file_kind = ?")
    .bind(grant.grantKey, slug, format)
    .first()) as any;
  const current = Number(row?.download_count || 0);
  if (current >= DOWNLOAD_LIMIT) return { ok: false, count: current, limit: DOWNLOAD_LIMIT };
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO download_counts (grant_key, order_id, slug, file_kind, download_count, updated_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT (grant_key, slug, file_kind)
       DO UPDATE SET download_count = download_count + 1, updated_at = excluded.updated_at`
    )
    .bind(grant.grantKey, grant.orderId, slug, format, now)
    .run();
  return { ok: true, count: current + 1, limit: DOWNLOAD_LIMIT };
}

export interface DownloadCountRow {
  slug: string;
  file_kind: string;
  download_count: number;
}

/** Every counted file for one order, for the admin order page. */
export async function downloadCountsForOrder(db: DBLike, orderId: string): Promise<DownloadCountRow[]> {
  await ensureDownloadCountsTable(db);
  const { results } = await db
    .prepare(
      "SELECT slug, file_kind, download_count FROM download_counts WHERE order_id = ? ORDER BY slug ASC, file_kind ASC"
    )
    .bind(orderId)
    .all();
  return ((results || []) as any[]).map((r) => ({
    slug: String(r.slug),
    file_kind: String(r.file_kind),
    download_count: Number(r.download_count || 0),
  }));
}

/** Support's reset: clear one order's download budget entirely. */
export async function resetDownloadsForOrder(db: DBLike, orderId: string): Promise<void> {
  await ensureDownloadCountsTable(db);
  await db.prepare("DELETE FROM download_counts WHERE order_id = ?").bind(orderId).run();
}
