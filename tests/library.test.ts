// Customer library tests: digital entitlements (orders in every
// format, the club join grant orders, shipped club cycle boxes) and
// the reader's page data (twin staleness rule, docker fallback).
// Runs the real src/lib code against an in-memory bun:sqlite
// database and a fake R2 bucket. Run with: bun tests/library.test.ts
import { Database } from "bun:sqlite";
import {
  formatGrantsDigital,
  formatGrantsAudio,
  getDigitalEntitlements,
  getLibraryBooks,
  ownsDigitalBook,
  ownsAudioBook,
  entitlementDownloads,
  loadReaderBook,
} from "../src/lib/library";
import { ensureClubTable } from "../src/lib/club";
import { ensureClubCycleTables } from "../src/lib/club-cycles";
import {
  normalizeFormat,
  checkoutItemPrice,
  buildConfirmationEmailModel,
} from "../src/lib/orders";
import { AUDIO_PRICE_CENTS, audioEligible } from "../src/lib/offers";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE books (slug TEXT PRIMARY KEY, title TEXT, topic TEXT, cover_key TEXT, status TEXT, picture_book_key TEXT, coloring_book_key TEXT, epub_key TEXT, color_book_key TEXT, audiobook_key TEXT, price INTEGER, price_print INTEGER);
CREATE TABLE club_signups (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, shelf TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL);
CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, book_slugs TEXT, items TEXT, stripe_session_id TEXT, amount INTEGER DEFAULT 0, currency TEXT DEFAULT 'usd', status TEXT DEFAULT 'complete', delivery_token TEXT, cart_fingerprint TEXT, physical_status TEXT, ship_name TEXT, ship_address TEXT, shipping_cents INTEGER, created_at INTEGER NOT NULL DEFAULT 0);
INSERT INTO books (slug, title, topic, status, picture_book_key, coloring_book_key, audiobook_key, price, price_print) VALUES
  ('alpha', 'Alpha', 'tech', 'complete', 'a/pic.pdf', 'a/col.pdf', 'a/audio.m4b', 899, 2000),
  ('beta', 'Beta', 'money', 'complete', 'b/pic.pdf', 'b/col.pdf', NULL, 899, 2000),
  ('gamma', 'Gamma', 'courage', 'complete', 'g/pic.pdf', 'g/col.pdf', NULL, 899, 2000),
  ('delta', 'Delta', 'tech', 'complete', 'd/pic.pdf', 'd/col.pdf', NULL, 899, 2000),
  ('epsilon', 'Epsilon', 'tech', 'complete', 'e/pic.pdf', 'e/col.pdf', NULL, 899, 2000),
  ('zeta', 'Zeta', 'money', 'complete', 'z/pic.pdf', 'z/col.pdf', NULL, 899, 2000),
  ('eta', 'Eta', 'courage', 'complete', 'h/pic.pdf', 'h/col.pdf', NULL, 899, 2000);
INSERT INTO books (slug, title, topic, status, cover_key, picture_book_key, coloring_book_key, audiobook_key, price, price_print) VALUES
  ('theta', 'Theta', 'tech', 'ready_for_qa', 't/cover.jpg', 't/pic.pdf', 't/col.pdf', 't/audio.m4b', 0, 0),
  ('iota', 'Iota', 'money', 'repair_failed', 'i/cover.jpg', 'i/pic.pdf', 'i/col.pdf', 'i/audio.m4b', 0, 0);
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

await ensureClubTable(db);
await ensureClubCycleTables(db);

let seq = 0;
function insertOrder(opts: {
  userId: string; email: string; items?: any[]; slugs?: string[];
  status?: string; session?: string;
}) {
  seq += 1;
  raw.query(
    "INSERT INTO orders (id, user_id, email, book_slugs, items, stripe_session_id, amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)"
  ).run(
    `order-${seq}`,
    opts.userId,
    opts.email,
    JSON.stringify(opts.slugs ?? (opts.items || []).map((i: any) => i.slug)),
    opts.items ? JSON.stringify(opts.items) : "",
    opts.session || `sess-${seq}`,
    opts.status || "complete",
    1700000000 + seq
  );
}
function insertMember(email: string, userId: string, status = "paid"): string {
  seq += 1;
  const id = `member-${seq}`;
  raw.query(
    "INSERT INTO club_signups (id, name, email, shelf, status, created_at, user_id) VALUES (?, 'Member', ?, 'tech', ?, ?, ?)"
  ).run(id, email, status, 1700000000 + seq, userId);
  return id;
}
function insertBox(signupId: string, slug: string | null, status: string) {
  seq += 1;
  raw.query(
    `INSERT INTO club_cycle_boxes (id, signup_id, ship_date, selected_book_slug, resolved_book_slug, selection_source, allow_repeat, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pick', 0, ?, ?, ?)`
  ).run(`box-${seq}`, signupId, `2027-0${(seq % 9) + 1}-01`, slug, slug, status, 1700000000 + seq, 1700000000 + seq);
}

// ---- Format truth -------------------------------------------------------
assert(formatGrantsDigital("digital") === true, "digital format grants digital");
assert(formatGrantsDigital("printed") === true, "printed grants digital (formatDetail: digital included)");
assert(formatGrantsDigital("giftset") === true, "gift set grants digital (digital included)");
assert(formatGrantsDigital("audio") === false, "audio format does NOT grant digital");
assert(formatGrantsAudio("audio") === true, "audio format grants audio");
assert(formatGrantsAudio("digital") === true, "digital grants audio (bundle includes the audiobook)");
assert(formatGrantsAudio("printed") === true, "printed grants audio (through digital included)");
assert(formatGrantsAudio("giftset") === true, "gift set grants audio (through digital included)");
assert(AUDIO_PRICE_CENTS === 599, "audio price constant is 599");
assert(audioEligible({ audiobook_key: "a/audio.m4b" }) === true, "audio eligible with an audiobook");
assert(audioEligible({ audiobook_key: null }) === false, "audio not eligible without an audiobook");
assert(normalizeFormat("audio") === "audio", "checkout normalization keeps the audio format");
assert(normalizeFormat("bogus") === "digital", "unknown formats still fold into digital");

// ---- Orders -------------------------------------------------------------
const userA = { id: "user-1", email: "a@example.com" };
insertOrder({ userId: "user-1", email: "a@example.com", items: [{ slug: "alpha", format: "digital" }] });
insertOrder({ userId: "user-1", email: "a@example.com", items: [{ slug: "beta", format: "printed" }] });
insertOrder({ userId: "user-1", email: "a@example.com", items: [{ slug: "gamma", format: "giftset" }] });
insertOrder({ userId: "user-1", email: "a@example.com", items: [{ slug: "delta", format: "digital" }], status: "pending" });
insertOrder({ userId: "user-1", email: "a@example.com", items: [{ slug: "epsilon", format: "digital" }], status: "expired" });
insertOrder({ userId: "user-1", email: "a@example.com", slugs: ["zeta"] }); // legacy book_slugs only
insertOrder({ userId: "guest-9", email: "a@example.com", items: [{ slug: "eta", format: "digital" }] }); // email fallback

const entA = await getDigitalEntitlements(db, userA);
assert(entA.has("alpha"), "digital purchase grants");
assert(entA.has("beta"), "printed purchase grants digital");
assert(entA.has("gamma"), "gift set purchase grants digital");
assert(!entA.has("delta"), "pending order does not grant");
assert(!entA.has("epsilon"), "expired order does not grant");
assert(entA.has("zeta"), "legacy book_slugs order grants");
assert(entA.has("eta"), "order matched by account email grants");
assert(entA.get("alpha")?.sources.join() === "order", "order source recorded");
assert(entA.get("alpha")?.owned === true, "lock: an order grant is owned");
assert(entitlementDownloads(entA.get("alpha"), "book") === true, "lock: an owned digital grant downloads book files");
assert(entitlementDownloads(entA.get("alpha"), "audiobook") === true, "lock: an owned digital grant downloads the audiobook file");

const userB = { id: "user-2", email: "b@example.com" };
insertOrder({ userId: "user-2", email: "b@example.com", items: [{ slug: "alpha", format: "digital" }] });
assert(await ownsDigitalBook(db, userB, "alpha"), "second buyer owns their purchase");
assert(!(await ownsDigitalBook(db, userB, "beta")), "another user's printed order does not grant");
assert(!(await ownsDigitalBook(db, userB, "nope")), "unknown slug is not owned");

// ---- Book Club ----------------------------------------------------------
const memberId = insertMember("c@example.com", "user-3");
// Day-one join grant: a $0 completed order, exactly as club.ts writes it.
insertOrder({
  userId: "user-3", email: "c@example.com",
  items: [{ slug: "alpha", format: "digital" }],
  session: `club_firstbox_${memberId}`,
});
insertBox(memberId, "beta", "shipped");
insertBox(memberId, "gamma", "delivered");
insertBox(memberId, "delta", "locked");
insertBox(memberId, null, "preparing");

const member = { id: "user-3", email: "c@example.com" };
const entC = await getDigitalEntitlements(db, member);
assert(entC.has("alpha"), "club join grant book is owned");
assert(entC.get("beta")?.sources.includes("club"), "shipped club box grants with club source");
assert(entC.has("gamma"), "delivered club box grants");
// The locked box itself grants nothing: delta reaches this member
// only through the ACTIVE physical membership layer (all-access).
// tests/club-plans.test.ts pins that the layer, and only the layer,
// disappears when billing health lapses.
assert(
  entC.get("delta")?.membership === "physical" && entC.get("delta")?.digital === true,
  "locked box book reaches an active member via the membership layer, not the box"
);
// Lock model ownership markers (CG, 2026-10-29): orders and shipped
// boxes own; the membership layer never does.
assert(entC.get("alpha")?.owned === true, "lock: the club join grant (a $0 order) is owned");
assert(entC.get("beta")?.owned === true, "lock: a shipped club box grant is owned");
assert(entC.get("gamma")?.owned === true, "lock: a delivered club box grant is owned");
assert(entC.get("delta")?.owned === false, "lock: a membership-layer-only grant is NOT owned");
assert(entitlementDownloads(entC.get("delta"), "book") === false, "lock: membership-only reach does not download book files");
assert(entitlementDownloads(entC.get("delta"), "audiobook") === false, "lock: membership-only reach does not download the audiobook file");
assert(entitlementDownloads(entC.get("beta"), "book") === true, "lock: a shipped box book downloads");
// With the membership layer inactive (past due), a locked box alone
// grants nothing at all.
const pastDueId = insertMember("pastdue@example.com", "user-6");
raw.query("UPDATE club_signups SET subscription_status = 'past_due' WHERE id = ?").run(pastDueId);
insertBox(pastDueId, "delta", "locked");
const entPastDue = await getDigitalEntitlements(db, { id: "user-6", email: "pastdue@example.com" });
assert(!entPastDue.has("delta"), "locked (not shipped) club box does not grant on its own");

// A member who cancels keeps books already shipped to them.
const canceledId = insertMember("d@example.com", "user-4", "canceled");
insertBox(canceledId, "epsilon", "shipped");
assert(
  await ownsDigitalBook(db, { id: "user-4", email: "d@example.com" }, "epsilon"),
  "canceled member keeps a book already shipped"
);

// ---- Audiobook-only purchases --------------------------------------------
const userAudio = { id: "user-5", email: "e@example.com" };
insertOrder({ userId: "user-5", email: "e@example.com", items: [{ slug: "alpha", format: "audio" }] });
const entAudio = await getDigitalEntitlements(db, userAudio);
assert(entAudio.has("alpha"), "audio purchase puts the book in the library");
assert(entAudio.get("alpha")?.digital === false, "audio purchase grants NO digital");
assert(entAudio.get("alpha")?.audio === true, "audio purchase grants audio");
assert(entAudio.get("alpha")?.owned === true, "lock: an audiobook-only purchase is owned");
assert(entitlementDownloads(entAudio.get("alpha"), "audiobook") === true, "lock: an owned audio grant downloads the audiobook file");
assert(entitlementDownloads(entAudio.get("alpha"), "book") === false, "lock: an owned audio grant still downloads no book files");
assert(!(await ownsDigitalBook(db, userAudio, "alpha")), "audio owner does not own digital (book_slugs does not widen it)");
assert(await ownsAudioBook(db, userAudio, "alpha"), "audio owner owns audio");
assert(await ownsAudioBook(db, userA, "alpha"), "digital owner owns audio too");
const libAudio = await getLibraryBooks(db, userAudio);
const libAudioAlpha = libAudio.find((b) => b.slug === "alpha");
assert(!!libAudioAlpha, "audio owner's shelf includes the book");
assert(libAudioAlpha?.audioOnly === true, "audio owner's shelf entry is listen-only");
assert((await getLibraryBooks(db, userA)).find((b) => b.slug === "alpha")?.audioOnly === false, "digital owner's shelf entry is not listen-only");

// ---- Audio purchases of audio-published (not book-published) books ---
// Theta (ready_for_qa) and iota (repair_failed) have a cover and an
// audiobook, so their audio editions are published and purchasable
// (CG, 2026-10-29) while their book editions stay gated. The grant
// layer is format-based, not status-based: the audio order grants
// listening and nothing else, exactly like a published book's.
const userAudioPub = { id: "user-9", email: "i@example.com" };
insertOrder({ userId: "user-9", email: "i@example.com", items: [{ slug: "theta", format: "audio" }, { slug: "iota", format: "audio" }] });
const entAudioPub = await getDigitalEntitlements(db, userAudioPub);
for (const s of ["theta", "iota"]) {
  assert(entAudioPub.get(s)?.audio === true && entAudioPub.get(s)?.digital === false, `audio purchase of the ${s} audio edition grants listening only`);
  assert(await ownsAudioBook(db, userAudioPub, s), `audio buyer owns ${s} audio (listen + download routes open)`);
  assert(!(await ownsDigitalBook(db, userAudioPub, s)), `audio buyer does NOT own ${s} digital (reading stays gated)`);
}
const libAudioPub = await getLibraryBooks(db, userAudioPub);
assert(libAudioPub.find((b) => b.slug === "theta")?.audioOnly === true, "audio-published purchase lands on the shelf as listen-only");
assert(libAudioPub.find((b) => b.slug === "iota")?.audioOnly === true, "repair_failed book's audio purchase also lands listen-only");

// The upgrade: the same buyer then buys digital and becomes full digital.
insertOrder({ userId: "user-5", email: "e@example.com", items: [{ slug: "alpha", format: "digital" }] });
assert(await ownsDigitalBook(db, userAudio, "alpha"), "audio owner who buys digital becomes a digital owner");
assert((await getLibraryBooks(db, userAudio)).find((b) => b.slug === "alpha")?.audioOnly === false, "upgraded entry is no longer listen-only");

// ---- Checkout pricing (server-side; the client never names a price) -----
const pricedBook = {
  slug: "alpha", price: 1299, price_print: 2499,
  picture_book_key: "a/pic.pdf", coloring_book_key: "a/col.pdf", audiobook_key: "a/audio.m4b",
};
const noAudioBook = { ...pricedBook, audiobook_key: null };
const nobody = { digital: false, audio: false };
const audioOwner = { digital: false, audio: true };
const digitalOwner = { digital: true, audio: true };

assert(checkoutItemPrice(pricedBook, "audio", nobody)?.cents === 599, "audio checkout charges 599");
assert(checkoutItemPrice(noAudioBook, "audio", nobody) === null, "audio checkout refused without an audiobook");
// An audio-published row (cover + audio, book unpublished, prices
// still 0 like the real ready_for_qa rows) prices its audio at the
// flat 599. Its other formats are refused one layer up, by the
// checkout route's audio_only gate (pinned in guest-checkout.test.ts).
const audioPubRow = { slug: "theta", price: 0, price_print: 0, picture_book_key: "t/pic.pdf", coloring_book_key: "t/col.pdf", audiobook_key: "t/audio.m4b" };
assert(checkoutItemPrice(audioPubRow, "audio", nobody)?.cents === 599, "audio-published book: audio checkout charges the flat 599");
assert(checkoutItemPrice(pricedBook, "digital", nobody)?.cents === 1299, "non-owner digital checkout charges 1299");
assert(checkoutItemPrice(pricedBook, "digital", nobody)?.upgrade === undefined, "non-owner digital has no credit marker");
const upgradePrice = checkoutItemPrice(pricedBook, "digital", audioOwner);
assert(upgradePrice?.cents === 700, "audio owner digital checkout charges 700 (1299 minus the 599 credit)");
assert(upgradePrice?.upgrade === "audio-upgrade", "upgrade charge carries the audio-upgrade marker");
assert(checkoutItemPrice(pricedBook, "printed", audioOwner)?.cents === 2499, "audio owner print checkout charges the full 2499");
assert(checkoutItemPrice(pricedBook, "printed", audioOwner)?.upgrade === undefined, "print never carries the audio credit");
assert(checkoutItemPrice(pricedBook, "giftset", audioOwner)?.cents === 3500, "audio owner gift set charges the full 3500");
assert(checkoutItemPrice(pricedBook, "digital", digitalOwner)?.cents === 1299, "digital owner rebuying digital pays full 1299 (no double credit)");
const floored = checkoutItemPrice({ ...pricedBook, price: 150 }, "digital", audioOwner);
assert(floored?.cents === 0 && floored?.upgrade === "audio-upgrade", "credit larger than the digital price floors at 0 with the marker");

// Confirmation email content follows the purchased format: an audio
// order's links are the audiobook alone; a digital order's are all files.
const alphaFiles = [{
  slug: "alpha", title: "Alpha",
  picture_book_key: "a/pic.pdf", coloring_book_key: "a/col.pdf",
  epub_key: "a/book.epub", color_book_key: "a/color.pdf", audiobook_key: "a/audio.m4b",
}];
const audioModel = buildConfirmationEmailModel(
  "https://bigbrainshelf.com",
  { delivery_token: "tok", items: JSON.stringify([{ slug: "alpha", format: "audio" }]), book_slugs: JSON.stringify(["alpha"]) },
  alphaFiles as any
);
assert(audioModel.items[0]?.formatLabel === "audiobook only", "audio order is labeled audiobook only in the confirmation");
assert(audioModel.downloads[0]?.links.length === 1 && audioModel.downloads[0].links[0].label === "Audiobook", "audio order email links the audiobook alone");
const digitalModel = buildConfirmationEmailModel(
  "https://bigbrainshelf.com",
  { delivery_token: "tok", items: JSON.stringify([{ slug: "alpha", format: "digital" }]), book_slugs: JSON.stringify(["alpha"]) },
  alphaFiles as any
);
assert(digitalModel.downloads[0]?.links.length === 5, "digital order email links every file");

// ---- Book page: ?format=audio preselects the audio format -----------------
const bookPageSrc = await Bun.file(new URL("../src/pages/books/[slug].astro", import.meta.url)).text();
assert(bookPageSrc.includes('searchParams.get("format") === "audio"'), "book page reads ?format=audio");
assert(bookPageSrc.includes('value="audio"'), "book page offers the audio format option");
assert(bookPageSrc.includes("Audiobook only"), "book page labels the format Audiobook only");

// ---- Library book rows ----------------------------------------------------
const libA = await getLibraryBooks(db, userA);
const libSlugs = libA.map((b) => b.slug).sort();
assert(
  JSON.stringify(libSlugs) === JSON.stringify(["alpha", "beta", "eta", "gamma", "zeta"]),
  `library rows match entitlements (got ${libSlugs.join(",")})`
);
assert(libA.find((b) => b.slug === "alpha")?.audiobook_key === "a/audio.m4b", "library row carries audiobook key");
assert(libA.find((b) => b.slug === "alpha")?.owned === true, "lock: shelf row for a purchased book carries owned true");
const libC = await getLibraryBooks(db, member);
assert(libC.find((b) => b.slug === "delta")?.owned === false, "lock: shelf row for a membership-only book carries owned false");
assert(libC.find((b) => b.slug === "beta")?.owned === true, "lock: shelf row for a shipped box book carries owned true");

// ---- Reader page data -----------------------------------------------------
const R2 = "https://pub-5e76d8a2d35343dbaa517e251b84e9c5.r2.dev/";
const chaptersJson = JSON.stringify([
  {
    title: "The Start",
    pages: [
      { image: `${R2}books/x/images/S1-page-0.jpg`, text: "Once upon a time." },
      { image: `${R2}books/x/images/S1-page-1.jpg`, text: "And then." },
    ],
  },
]);
const fakeBooks = {
  async get(key: string) {
    if (key === "books/x/editor_chapters.json") return { text: async () => chaptersJson };
    return null;
  },
  async list({ prefix }: any) {
    if (prefix === "books/x/images/") {
      return {
        objects: [
          { key: "books/x/images/S1-page-0.jpg", uploaded: new Date(1000) },
          { key: "books/x/images/S1-page-1.jpg", uploaded: new Date(1000) },
        ],
        truncated: false,
      };
    }
    if (prefix === "books/x/images-color/") {
      return {
        objects: [
          { key: "books/x/images-color/S1-page-0.jpg", uploaded: new Date(2000) }, // fresh twin
          { key: "books/x/images-color/S1-page-1.jpg", uploaded: new Date(500) }, // stale twin
        ],
        truncated: false,
      };
    }
    return { objects: [], truncated: false };
  },
};
const reader = await loadReaderBook(fakeBooks, "x");
assert(reader.error === null && reader.chapters.length === 1, "reader loads chapters");
assert(reader.totalPages === 2, "reader counts pages");
assert(reader.chapters[0].pages[0].viewer === 1 && reader.chapters[0].pages[1].viewer === 2, "viewer numbers are 1-based within the chapter");
assert(reader.chapters[0].pages[0].text === "Once upon a time.", "story text passes through");
assert(reader.chapters[0].pages[0].colorUrl === `/api/library/page/x?key=${encodeURIComponent("books/x/images-color/S1-page-0.jpg")}`, "fresh color twin is offered through the gated reader route");
assert(reader.chapters[0].pages[0].lineUrl === `/api/library/page/x?key=${encodeURIComponent("books/x/images/S1-page-0.jpg")}`, "line pages are served through the gated reader route, never a public URL");
assert(!JSON.stringify(reader).includes("r2.dev"), "reader data contains no public bucket URLs");
assert(reader.chapters[0].pages[1].colorUrl === null, "stale color twin is refused");
assert(reader.hasColor === true && reader.colorCount === 1, "color availability reflects current twins only");

const missing = await loadReaderBook(fakeBooks, "missing-book");
assert(missing.chapters.length === 0 && !!missing.error, "missing page data degrades to a friendly error");

const docker = await loadReaderBook(fakeBooks, "docker");
assert(docker.chapters.length > 0 && docker.totalPages > 0, "docker falls back to the bundled chapters");
assert(docker.chapters[0].pages[0].lineUrl.startsWith("/api/library/page/docker?key="), "docker legacy page keys are gated too");
assert(!JSON.stringify(docker).includes("r2.dev"), "docker reader data contains no public bucket URLs");

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll library tests passed.");
