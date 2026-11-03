// Club box pick fixes (admin redesign fix, 2026-11-03): a saved pick
// used to be permanent (the fulfillment view stopped offering the
// picker once both slots were filled) and nothing stopped the same
// book landing in both story slots. The lib now rejects a duplicate
// across slots outright, supports changing a pick, and supports
// clearing a slot (which also drops that slot's pack ticks, since
// they described the old book). Terminal boxes keep final picks.
// Run with: bun tests/club-box-picks.test.ts
import { Database } from "bun:sqlite";
import {
  ensureClubCycleTables,
  updateClubBoxByAdmin,
  setClubBoxPack,
  getClubBox,
} from "../src/lib/club-cycles";
import { parsePackState } from "../src/lib/orders";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE books (slug TEXT PRIMARY KEY, title TEXT, topic TEXT, cover_key TEXT, status TEXT, picture_book_key TEXT, coloring_book_key TEXT, epub_key TEXT, color_book_key TEXT, audiobook_key TEXT);
CREATE TABLE club_signups (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, shelf TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL);
CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT NOT NULL, book_slugs TEXT NOT NULL, stripe_session_id TEXT, amount INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'usd', status TEXT NOT NULL DEFAULT 'complete', created_at INTEGER NOT NULL, items TEXT DEFAULT '', delivery_token TEXT);
CREATE TABLE email_outbox (id TEXT PRIMARY KEY, order_id TEXT, kind TEXT NOT NULL, to_email TEXT NOT NULL, subject TEXT NOT NULL, body_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL, sent_at INTEGER, send_after INTEGER, from_email TEXT);
INSERT INTO books (slug, title, status, picture_book_key, coloring_book_key) VALUES
  ('alpha', 'Alpha', 'complete', 'a/pic.pdf', 'a/col.pdf'),
  ('beta', 'Beta', 'ready_for_qa', 'b/pic.pdf', 'b/col.pdf'),
  ('gamma', 'Gamma', 'complete', 'g/pic.pdf', 'g/col.pdf');
INSERT INTO club_signups (id, name, email, shelf, status, created_at) VALUES ('m1', 'Member One', 'm1@example.com', 'tech', 'paid', 100);
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

await ensureClubCycleTables(db);
let boxSeq = 0;
function insertBox(id: string, status: string, extra: Record<string, any> = {}) {
  boxSeq += 1;
  raw.query(
    `INSERT INTO club_cycle_boxes (id, signup_id, ship_date, status, selected_book_slug, resolved_book_slug, second_selected_book_slug, second_resolved_book_slug, created_at, updated_at)
     VALUES (?, 'm1', ?, ?, ?, ?, ?, ?, 100, 100)`
  ).run(id, `2026-12-${String(boxSeq).padStart(2, "0")}`, status, extra.s1 ?? null, extra.r1 ?? null, extra.s2 ?? null, extra.r2 ?? null);
}
insertBox("box1", "awaiting_selection");
insertBox("box2", "shipped", { s1: "alpha", r1: "alpha" });
insertBox("box3", "awaiting_selection", { s1: "alpha" });

{
  // Fill both slots, then prove the second slot refuses the first
  // slot's book at the lib level (not just in the picker UI).
  const first = await updateClubBoxByAdmin(db, { boxId: "box1", bookSlug: "alpha" });
  assert(first.ok && first.box.status === "locked" && first.box.resolved_book_slug === "alpha",
    "picks: slot 1 resolves and locks, as before");
  const dupe = await updateClubBoxByAdmin(db, { boxId: "box1", bookSlug: "alpha", slot: 2 });
  assert(!dupe.ok && /already the other pick/.test(dupe.error || ""),
    "picks: the same book in slot 2 is rejected by the lib");
  const second = await updateClubBoxByAdmin(db, { boxId: "box1", bookSlug: "beta", slot: 2 });
  assert(second.ok && second.box.second_resolved_book_slug === "beta",
    "picks: slot 2 takes a different book");

  // A filled slot can be CHANGED (the reported defect: it could not).
  const changed = await updateClubBoxByAdmin(db, { boxId: "box1", bookSlug: "gamma", slot: 2 });
  assert(changed.ok && changed.box.second_resolved_book_slug === "gamma",
    "picks: a saved pick can be changed");

  // Changing a pick drops that slot's pack ticks only.
  await setClubBoxPack(db, "box1", { "slot1:story": true, "slot1:coloring": true, "slot2:story": true, "extras:stickers": true, "__label": true });
  const rePick = await updateClubBoxByAdmin(db, { boxId: "box1", bookSlug: "beta", slot: 1 });
  assert(rePick.ok && rePick.box.resolved_book_slug === "beta",
    "picks: slot 1 can be changed too");
  const afterChange = await getClubBox(db, "box1");
  const packAfterChange = parsePackState(afterChange.pack_json);
  assert(!packAfterChange["slot1:story"] && !packAfterChange["slot1:coloring"] &&
    packAfterChange["slot2:story"] === true && packAfterChange["extras:stickers"] === true && packAfterChange["__label"] === true,
    "picks: changing slot 1 cleared its pack ticks and kept slot 2's");

  // Clearing empties the slot and its ticks; the box stays locked
  // while its club book is in place, and drops to needs_attention
  // when the club book itself is cleared.
  const cleared2 = await updateClubBoxByAdmin(db, { boxId: "box1", slot: 2, clear: true });
  assert(cleared2.ok && !cleared2.box.second_resolved_book_slug && !cleared2.box.second_selected_book_slug &&
    cleared2.box.status === "locked",
    "picks: clearing slot 2 empties it and the box stays locked on its club book");
  const packAfterClear = parsePackState((await getClubBox(db, "box1")).pack_json);
  assert(!packAfterClear["slot2:story"], "picks: clearing slot 2 dropped its pack tick");
  const cleared1 = await updateClubBoxByAdmin(db, { boxId: "box1", slot: 1, clear: true });
  assert(cleared1.ok && !cleared1.box.resolved_book_slug && cleared1.box.status === "needs_attention",
    "picks: clearing the club book sends the box to needs_attention");

  // A member's own un-resolved selection also counts for duplicates.
  const dupeSelected = await updateClubBoxByAdmin(db, { boxId: "box3", bookSlug: "alpha", slot: 2 });
  assert(!dupeSelected.ok, "picks: slot 2 cannot duplicate a selected (unresolved) slot 1 book");

  // Terminal boxes keep final picks: no changes, no clears.
  const termSet = await updateClubBoxByAdmin(db, { boxId: "box2", bookSlug: "beta", slot: 2 });
  assert(!termSet.ok, "picks: a shipped box cannot take a new pick");
  const termClear = await updateClubBoxByAdmin(db, { boxId: "box2", slot: 1, clear: true });
  assert(!termClear.ok, "picks: a shipped box cannot be cleared");
}

if (failures) { console.error(failures + " club-box-picks test(s) failed"); process.exit(1); }
console.log("All club-box-picks tests passed.");
