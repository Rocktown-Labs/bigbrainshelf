// Release announcement tests: published_at stamping (once, never
// overwritten), the two announcement waves (paid Book Club members
// first and immediate; subscribers minus members after 3 days),
// enqueue-time and send-time opt-out suppression, dedupe on repeat
// enqueue, debut vs returning cast framing, and the admin status
// rollup. Runs the real src/lib code against an in-memory bun:sqlite
// database. Run with: bun tests/releases.test.ts
import { Database } from "bun:sqlite";
import {
  ensurePublishedAtColumn,
  stampPublishedAt,
  enqueueReleaseAnnouncements,
  loadReleaseEmailModel,
  getReleaseAnnouncementStatus,
  RELEASE_CLUB_KIND,
  RELEASE_PUBLIC_KIND,
  RELEASE_PUBLIC_DELAY_SECONDS,
} from "../src/lib/releases";
import { flushOutbox } from "../src/lib/email";
import {
  getOrCreateUnsubscribeToken,
  recordOptOutByToken,
} from "../src/lib/marketing";
import { formatPublishedDate } from "../src/lib/offers";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE books (slug TEXT PRIMARY KEY, title TEXT, topic TEXT, status TEXT, price INTEGER, price_print INTEGER, cover_key TEXT, description TEXT, audiobook_key TEXT, picture_book_key TEXT, coloring_book_key TEXT);
CREATE TABLE characters (id TEXT PRIMARY KEY, name TEXT NOT NULL, species TEXT NOT NULL, book_slug TEXT);
CREATE TABLE club_signups (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, shelf TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL);
CREATE TABLE subscribers (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'footer');
CREATE TABLE email_outbox (id TEXT PRIMARY KEY, order_id TEXT, kind TEXT NOT NULL, to_email TEXT NOT NULL, subject TEXT NOT NULL, body_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL, sent_at INTEGER, send_after INTEGER, from_email TEXT, dedupe_key TEXT, club_box_id TEXT);
CREATE UNIQUE INDEX email_outbox_order_kind_idx ON email_outbox(order_id, kind) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX email_outbox_dedupe_idx ON email_outbox(dedupe_key) WHERE dedupe_key IS NOT NULL;
INSERT INTO books (slug, title, topic, status, price, price_print, cover_key, description, audiobook_key, picture_book_key, coloring_book_key) VALUES
  ('mastery', 'Mira the Heron and the Still Water', 'courage', 'ready_for_qa', 899, 2000, 'books/mastery/cover.jpg', 'A heron learns to wait.', 'books/mastery/audiobook.m4b', 'm/pic.pdf', 'm/col.pdf'),
  ('docker', 'Wally the Whale and the Great Harbor', 'tech', 'complete', 899, 2000, 'books/docker/cover.jpg', '', NULL, 'd/pic.pdf', 'd/col.pdf');
INSERT INTO characters (id, name, species, book_slug) VALUES
  ('char-mira', 'Mira', 'heron', 'mastery'),
  ('char-ansel', 'Ansel', 'heron', 'mastery'),
  ('char-dell', 'Dell', 'duck', 'mastery'),
  ('char-wally', 'Wally', 'whale', 'docker'),
  ('char-mira-cameo', 'Mira', 'heron', 'docker');
INSERT INTO club_signups (id, name, email, shelf, status, created_at) VALUES
  ('m1', 'Member One', 'member@example.com', 'courage', 'paid', 1700000000),
  ('m2', 'Member Two', 'both@example.com', 'courage', 'paid', 1700000000),
  ('m3', 'Queued One', 'queued@example.com', 'courage', 'queued', 1700000000),
  ('m4', 'Opted Member', 'optedmember@example.com', 'courage', 'paid', 1700000000);
INSERT INTO subscribers (id, email, created_at) VALUES
  ('s1', 'both@example.com', 1700000000),
  ('s2', 'fan@example.com', 1700000000),
  ('s3', 'optedout@example.com', 1700000000);
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
const T = 1700000000; // fixed publish moment for the whole scenario
const count = (sql: string, ...args: any[]) => (raw.query(sql).get(...args) as any).n as number;
const rowFor = (email: string, kind: string) =>
  raw.query("SELECT * FROM email_outbox WHERE to_email = ? AND kind = ?").get(email, kind) as any;

// --- published_at: column ensured, stamped once, never overwritten
await ensurePublishedAtColumn(db);
const cols = raw.query("SELECT name FROM pragma_table_info('books')").all() as any[];
assert(cols.some((c) => c.name === "published_at"), "ensurePublishedAtColumn adds books.published_at");
assert(formatPublishedDate(T) === "November 14, 2023", "published date formats as Month D, YYYY");
raw.query("UPDATE books SET status = 'complete' WHERE slug = 'mastery'").run();
assert((await stampPublishedAt(db, "mastery", T)) === true, "first publish stamps published_at");
assert((await stampPublishedAt(db, "mastery", T + 9999)) === false, "republish does not restamp");
const stamped = raw.query("SELECT published_at FROM books WHERE slug = 'mastery'").get() as any;
assert(stamped.published_at === T, "the original stamp survives a republish");

// --- Opt-outs recorded before the announcement goes out
for (const email of ["optedout@example.com", "optedmember@example.com"]) {
  const token = await getOrCreateUnsubscribeToken(db, email);
  await recordOptOutByToken(db, token);
}

// --- The two waves
const counts = await enqueueReleaseAnnouncements(db, SITE, "mastery", T);
assert(counts.club === 2, `wave 1 enqueues the 2 reachable paid members (got ${counts.club})`);
assert(counts.public === 1, `wave 2 enqueues the 1 reachable non-member subscriber (got ${counts.public})`);
assert(count("SELECT COUNT(*) n FROM email_outbox") === 3, "exactly 3 announcement rows exist");

const memberRow = rowFor("member@example.com", RELEASE_CLUB_KIND);
assert(memberRow && memberRow.send_after === null, "wave 1 is immediate (no send_after)");
assert(memberRow && memberRow.from_email === "news@bigbrainshelf.com", "wave 1 sends from news@");
assert(!rowFor("member@example.com", RELEASE_PUBLIC_KIND), "a member is not also a wave 2 recipient");
const bothRow = rowFor("both@example.com", RELEASE_CLUB_KIND);
assert(bothRow && !rowFor("both@example.com", RELEASE_PUBLIC_KIND), "a member who also subscribes hears once, in wave 1");
assert(!rowFor("queued@example.com", RELEASE_CLUB_KIND), "a queued (unpaid) signup is not a wave 1 member");
assert(!rowFor("optedout@example.com", RELEASE_PUBLIC_KIND), "an opted-out subscriber is skipped at enqueue");
assert(!rowFor("optedmember@example.com", RELEASE_CLUB_KIND), "an opted-out member is skipped at enqueue");

const fanRow = rowFor("fan@example.com", RELEASE_PUBLIC_KIND);
assert(fanRow && fanRow.send_after === T + RELEASE_PUBLIC_DELAY_SECONDS, "wave 2 waits out the 3 day members-first window");
assert(fanRow && fanRow.from_email === "news@bigbrainshelf.com", "wave 2 sends from news@");
assert(fanRow.subject === "New on the shelf: Mira the Heron and the Still Water", "wave 2 subject names the book");
assert(memberRow.subject.indexOf("Members first:") === 0, "wave 1 subject carries the members-first framing");

// --- Cast framing: debuts introduced, returning names welcomed back
const fanText: string = fanRow.body_text;
assert(fanText.includes("Introducing Ansel"), "a first-appearance character is introduced");
assert(fanText.includes("Introducing Dell"), "a second debut is introduced");
assert(!fanText.includes("Introducing Mira"), "a character from an earlier book is not introduced");
assert(fanText.includes("Mira, the heron, is back"), "a returning character is framed as back");
assert(fanText.includes("Digital bundle $8.99, audiobook included"), "the price line comes from the book row");
assert(fanText.includes("/api/unsubscribe?token="), "the text carries the tokened unsubscribe link");
assert(!fanText.includes("—") && !fanRow.subject.includes("—"), "no em dashes in the announcement copy");
assert(fanText.includes("published November 14, 2023"), "the text marks the publication date");

// --- Dedupe: a repeat enqueue (republish, double click) adds nothing
const again = await enqueueReleaseAnnouncements(db, SITE, "mastery", T + 5000);
assert(again.club === 2 && again.public === 1, "repeat enqueue converges on the same counts");
assert(count("SELECT COUNT(*) n FROM email_outbox") === 3, "repeat enqueue creates no duplicate rows");

// --- HTML model rebuild for the renderer
const model = await loadReleaseEmailModel(db, SITE, bothRow);
assert(model && model.wave === "club" && model.cast.length === 3, "the renderer model rebuilds with the full cast");
assert(model && model.cast.find((c) => c.name === "Ansel")?.debut === true, "the model flags debuts");
assert(model && model.cast.find((c) => c.name === "Mira")?.debut === false, "the model flags returning characters");
assert(model && !!model.coverUrl && model.coverUrl.endsWith("books/mastery/cover.jpg"), "the model carries the cover image");

// --- Send-time suppression: opt out after enqueue, flush, no send
const fanToken = await getOrCreateUnsubscribeToken(db, "fan@example.com");
await recordOptOutByToken(db, fanToken);
const deadTransport = { EMAIL: { send: async () => { throw new Error("test transport down"); } } };
await flushOutbox(db, deadTransport, 100, SITE);
const fanAfter = rowFor("fan@example.com", RELEASE_PUBLIC_KIND);
assert(fanAfter.status === "suppressed", "a release enqueued before opt-out is suppressed at send");
const memberAfter = rowFor("member@example.com", RELEASE_CLUB_KIND);
assert(memberAfter.status !== "suppressed", "a reachable member row is not suppressed (its send was attempted)");

// --- Admin rollup
const status = await getReleaseAnnouncementStatus(db);
assert(status.length === 1 && status[0].slug === "mastery", "the rollup lists the published book");
assert(status[0].publishedLabel === "November 14, 2023", "the rollup carries the formatted date");
assert(status[0].club.queued === 2 && status[0].club.sent === 0, "the rollup counts wave 1 rows as queued after failed sends");
assert(status[0].public.suppressed === 1, "the rollup counts the suppressed wave 2 row");

if (failures) { console.error(`\n${failures} FAILURES`); process.exit(1); }
console.log("\nAll release announcement tests passed.");
