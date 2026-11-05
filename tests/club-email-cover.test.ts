// Club cycle email cover (CG, 2026-11-05): the locked-in email was a
// plain wall of text; it should show the book. The model loader pulls
// the resolved book's cover from the books row as a media-host URL,
// and the template renders it on the locked and shipped emails only.
// Runs the real src/lib code against an in-memory bun:sqlite
// database. Run with: bun tests/club-email-cover.test.ts
import { Database } from "bun:sqlite";
import { createElement } from "react";
import { render } from "@react-email/render";
import { ensureClubCycleTables } from "../src/lib/club-cycles";
import {
  buildClubCycleEmailModel,
  loadClubCycleEmailModel,
  CLUB_BOX_SHIPPED_KIND,
  CLUB_CYCLE_ATTENTION_KIND,
  CLUB_CYCLE_LOCKED_KIND,
} from "../src/lib/club-emails";
import ClubCycleEmail from "../emails/ClubCycleEmail";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE books (slug TEXT PRIMARY KEY, title TEXT, topic TEXT, cover_key TEXT, status TEXT, picture_book_key TEXT, coloring_book_key TEXT, epub_key TEXT, color_book_key TEXT, audiobook_key TEXT);
INSERT INTO books (slug, title, cover_key, status, picture_book_key, coloring_book_key) VALUES
  ('alpha', 'Alpha the Fox', 'books/alpha/cover-titled.jpg', 'complete', 'a/pic.pdf', 'a/col.pdf'),
  ('beta', 'Beta the Bear', NULL, 'complete', 'b/pic.pdf', 'b/col.pdf');
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

const SITE = "https://bigbrainshelf.com";
const COVER_URL = "https://media.bigbrainshelf.com/books/alpha/cover-titled.jpg";
const unix = (dateStr: string) => Math.floor(Date.parse(`${dateStr}T12:00:00Z`) / 1000);

await ensureClubCycleTables(db);
raw.query(
  `INSERT INTO club_cycle_boxes (id, signup_id, ship_date, resolved_book_slug, status, carrier, tracking_number, created_at, updated_at)
   VALUES ('box-locked', 'member-1', '2026-10-31', 'alpha', 'locked', NULL, NULL, ?, ?)`
).run(unix("2026-10-28"), unix("2026-10-28"));
raw.query(
  `INSERT INTO club_cycle_boxes (id, signup_id, ship_date, resolved_book_slug, status, carrier, tracking_number, created_at, updated_at)
   VALUES ('box-shipped', 'member-1', '2026-07-31', 'alpha', 'shipped', 'USPS', '9400100000000000000000', ?, ?)`
).run(unix("2026-07-28"), unix("2026-07-28"));
raw.query(
  `INSERT INTO club_cycle_boxes (id, signup_id, ship_date, resolved_book_slug, status, carrier, tracking_number, created_at, updated_at)
   VALUES ('box-waiting', 'member-1', '2027-01-31', NULL, 'awaiting_selection', NULL, NULL, ?, ?)`
).run(unix("2027-01-28"), unix("2027-01-28"));

// --- The loader resolves the cover from the book row ---------------
const locked = await loadClubCycleEmailModel(db, SITE, { kind: CLUB_CYCLE_LOCKED_KIND, club_box_id: "box-locked" });
assert(locked?.bookTitle === "Alpha the Fox", "locked model carries the resolved book's title");
assert(locked?.bookCoverUrl === COVER_URL, "locked model carries the cover as a media-host URL");

const shipped = await loadClubCycleEmailModel(db, SITE, { kind: CLUB_BOX_SHIPPED_KIND, club_box_id: "box-shipped" });
assert(shipped?.bookCoverUrl === COVER_URL, "shipped model carries the same cover");

const waiting = await loadClubCycleEmailModel(db, SITE, { kind: "club_cycle_reminder_14", club_box_id: "box-waiting" });
assert(waiting?.bookCoverUrl === null, "a box with no resolved book has no cover to show");

// --- The template renders the cover on locked and shipped only -----
const lockedHtml = await render(createElement(ClubCycleEmail, { model: locked! }));
assert(lockedHtml.includes(`src="${COVER_URL}"`), "locked email HTML shows the cover image");
assert(lockedHtml.includes('alt="Alpha the Fox cover"'), "the cover image is labeled with the book title");

const shippedHtml = await render(createElement(ClubCycleEmail, { model: shipped! }));
assert(shippedHtml.includes(`src="${COVER_URL}"`), "shipped email HTML shows the cover image");

const attention = buildClubCycleEmailModel({
  kind: CLUB_CYCLE_ATTENTION_KIND,
  site: SITE,
  shipDate: "2026-10-31",
  bookTitle: "Alpha the Fox",
  bookCoverUrl: COVER_URL,
});
const attentionHtml = await render(createElement(ClubCycleEmail, { model: attention }));
assert(!attentionHtml.includes(COVER_URL), "the action-needed email never shows a cover, even when one slot has resolved");

console.log(failures === 0 ? "\nALL CLUB EMAIL COVER TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
