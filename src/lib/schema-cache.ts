// Per-database memoization for runtime schema checks (`ensure*Table` /
// `ensure*Column`).
//
// Why this exists:
// - Production D1 already has the schema from `migration.sql`, so running
//   `CREATE TABLE IF NOT EXISTS` and `PRAGMA table_info(...)` on every
//   request wasted round-trips.
// - Local unit tests (`tests/*.test.ts`) create fresh in-memory SQLite
//   databases (`new Database(":memory:")`) and rely on `ensure*` helpers
//   to bootstrap tables/columns on first call.
// - Keying a WeakMap by the `db` object reference gives us both: zero
//   redundant D1 round-trips after the first call on a worker isolate's
//   DB binding, and automatic execution for every fresh in-memory test DB.

const initializedByDb = new WeakMap<object, Set<string>>();

export async function ensureOnce(
  db: unknown,
  key: string,
  fn: () => Promise<void>
): Promise<void> {
  if (!db || typeof db !== "object") {
    await fn();
    return;
  }
  let seen = initializedByDb.get(db);
  if (!seen) {
    seen = new Set<string>();
    initializedByDb.set(db, seen);
  }
  if (seen.has(key)) return;
  await fn();
  seen.add(key);
}

/** Return how many schema keys have been initialized on a given DB instance. */
export function ensuredKeysForDb(db: object): string[] {
  return [...(initializedByDb.get(db) || [])];
}
