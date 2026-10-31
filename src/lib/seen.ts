// Admin "seen" tracking (CG, 2026-10-31): sidebar badges count
// work, not history. A pending item (an order still waiting on
// fulfillment, a review still waiting on moderation, a club
// member with failed payment) counts until the work is done,
// no matter how often it is viewed. A finished item counts
// until the admin opens it; opening stamps seen_at and the
// badge lets it go. seen_at is epoch seconds.

type DBLike = {
  prepare: (sql: string) => {
    bind: (...args: any[]) => { run: () => Promise<any>; first: () => Promise<any>; all: () => Promise<any> };
    run: () => Promise<any>;
    first: () => Promise<any>;
    all: () => Promise<any>;
  };
};

const TABLES = ["orders", "club_signups", "reviews"] as const;
export type SeenTable = (typeof TABLES)[number];

const ensured = new Set<string>();

export async function ensureSeenColumn(db: DBLike, table: SeenTable): Promise<void> {
  if (ensured.has(table)) return;
  try {
    const cols = await db.prepare(`PRAGMA table_info(${table})`).all();
    const have = new Set(((cols.results || []) as any[]).map((c) => String(c.name)));
    if (!have.size) return; // table does not exist yet; nothing to stamp
    if (!have.has("seen_at")) {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN seen_at INTEGER`).run();
    }
    ensured.add(table);
  } catch { /* best effort: badges fall back to unseen counting */ }
}

export async function ensureAllSeenColumns(db: DBLike): Promise<void> {
  for (const t of TABLES) await ensureSeenColumn(db, t);
}

export async function markSeen(db: DBLike, table: SeenTable, id: string): Promise<void> {
  if (!id) return;
  await ensureSeenColumn(db, table);
  try {
    await db
      .prepare(`UPDATE ${table} SET seen_at = ? WHERE id = ? AND seen_at IS NULL`)
      .bind(Math.floor(Date.now() / 1000), id)
      .run();
  } catch { /* never let a stamp break the page it rides on */ }
}

export async function markManySeen(db: DBLike, table: SeenTable, ids: string[]): Promise<void> {
  const clean = ids.filter(Boolean);
  if (!clean.length) return;
  await ensureSeenColumn(db, table);
  try {
    await db
      .prepare(
        `UPDATE ${table} SET seen_at = ? WHERE seen_at IS NULL AND id IN (${clean.map(() => "?").join(",")})`
      )
      .bind(Math.floor(Date.now() / 1000), ...clean)
      .run();
  } catch { /* best effort */ }
}
