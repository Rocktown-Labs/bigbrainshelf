// Pass 4 (2026-10-29): the collapsible admin sidebar and the SaaS
// dashboard. The nav model and editor-route rule are unit-tested
// directly; the dashboard's data function runs against an in-memory
// bun:sqlite fixture shaped like production (including the three
// real test orders: mastery digital, mastery audio, richdadpoordad
// audio, all pending), and the shell + dashboard markup are pinned
// at source level (a signed-in render is the owner's click; builders
// cannot mint admin sessions). Run with:
//   bun tests/admin-shell.test.ts
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { ADMIN_NAV, isEditorRoute } from "../src/lib/admin-nav";
import { getAdminDashboard, chicagoDayStartSec } from "../src/lib/admin-dashboard";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

// ---- Nav model -------------------------------------------------------
assert(ADMIN_NAV.map((g) => g.label).join(",") === "Overview,Catalog,Commerce,Media", "sidebar groups are Overview, Catalog, Commerce, Media");
const hrefs = ADMIN_NAV.flatMap((g) => g.items.map((i) => i.href));
for (const h of ["/admin", "/admin/books", "/admin/audiobooks", "/admin/bibles", "/admin/characters", "/admin/cast-gemini", "/admin/orders", "/admin/club", "/admin/reviews", "/admin/video", "/"]) {
  assert(hrefs.includes(h), `sidebar links ${h}`);
}

// ---- Editor routes start collapsed ------------------------------------
for (const p of ["/admin/books/mastery/edit", "/admin/books/mastery/crops", "/admin/books/mastery/review", "/admin/books/mastery", "/admin/characters/char-mira", "/admin/characters/cast-crops", "/admin/cast", "/admin/cast-gemini"]) {
  assert(isEditorRoute(p), `editor route (starts collapsed): ${p}`);
}
for (const p of ["/admin", "/admin/books", "/admin/orders", "/admin/club", "/admin/characters", "/admin/bibles", "/admin/reviews", "/admin/video", "/admin/audiobooks"]) {
  assert(!isEditorRoute(p), `not an editor route: ${p}`);
}

// ---- Dashboard data against a production-shaped fixture ----------------
const raw = new Database(":memory:");
raw.exec(`
CREATE TABLE books (slug TEXT PRIMARY KEY, title TEXT, status TEXT, stage TEXT);
CREATE TABLE orders (id TEXT PRIMARY KEY, email TEXT, book_slugs TEXT, items TEXT, amount INTEGER, status TEXT, physical_status TEXT, created_at INTEGER);
CREATE TABLE email_outbox (id TEXT PRIMARY KEY, status TEXT);
CREATE TABLE reviews (id TEXT PRIMARY KEY, status TEXT);
CREATE TABLE subscribers (id TEXT PRIMARY KEY, email TEXT);
CREATE TABLE club_signups (id TEXT PRIMARY KEY, status TEXT, plan TEXT, club_plan TEXT, shelf TEXT);
CREATE TABLE club_cycle_boxes (id TEXT PRIMARY KEY, signup_id TEXT, ship_date TEXT, status TEXT);
CREATE TABLE characters (name TEXT, book_slug TEXT);
CREATE TABLE character_voices (character_name TEXT PRIMARY KEY, voice_id TEXT);
INSERT INTO books VALUES ('mastery', 'Mira the Heron and the Still Water', 'complete', 'done');
INSERT INTO books VALUES ('richdadpoordad', 'Penny the Squirrel and the Acorn Orchard', 'ready_for_qa', 'repair_failed');
INSERT INTO books VALUES ('iwillteach', 'Tilda the Magpie and the Treasure That Sorted Itself', 'failed', 'images');
INSERT INTO books VALUES ('docker', 'Wally the Whale and the Great Harbor', 'ready_for_qa', 'done');
INSERT INTO characters VALUES ('Mira', 'mastery');
INSERT INTO characters VALUES ('Wally', 'docker');
INSERT INTO character_voices VALUES ('Wally', 'riko');
`);
const now = Math.floor(Date.now() / 1000);
// "Today's" fixture orders anchor to the Chicago day start, not to
// now-minus-hours: run in the first hours after Chicago midnight,
// now-3600/7200/9000 land yesterday and the orders-today count
// flakes to zero (hit 2026-10-31 00:05 CT). Day-start offsets are
// inside today at any hour the suite runs.
const dayStart = chicagoDayStartSec(now);
assert(dayStart <= now && now - dayStart < 86400 + 3600, "Chicago day start is earlier today");
raw.exec(`
INSERT INTO orders VALUES ('o1', '', '["richdadpoordad"]', '[{"slug":"richdadpoordad","format":"audio"}]', 199, 'pending', NULL, ${dayStart + 9000});
INSERT INTO orders VALUES ('o2', 'cg@rocktownlabs.com', '["mastery"]', '[{"slug":"mastery","format":"audio"}]', 199, 'pending', NULL, ${dayStart + 7200});
INSERT INTO orders VALUES ('o3', '', '["mastery"]', '[{"slug":"mastery","format":"digital"}]', 899, 'pending', NULL, ${dayStart + 3600});
INSERT INTO orders VALUES ('o4', 'buyer@example.com', '["mastery"]', '[{"slug":"mastery","format":"printed"}]', 2000, 'complete', 'preorder_received', ${now - 86400});
INSERT INTO orders VALUES ('o5', 'buyer@example.com', '["mastery"]', '[{"slug":"mastery","format":"digital"}]', 899, 'complete', NULL, ${now - 2 * 86400});
INSERT INTO email_outbox VALUES ('e1', 'pending');
INSERT INTO email_outbox VALUES ('e2', 'failed');
INSERT INTO email_outbox VALUES ('e3', 'sent');
INSERT INTO reviews VALUES ('r1', 'pending');
INSERT INTO subscribers VALUES ('s1', 'a@example.com');
INSERT INTO subscribers VALUES ('s2', 'b@example.com');
INSERT INTO club_cycle_boxes VALUES ('b1', 'sg1', '${new Date((dayStart + 2 * 86400) * 1000).toISOString().slice(0, 10)}', 'needs_attention');
`);
const db = {
  prepare(sql: string) {
    const stmt = () => raw.query(sql);
    return {
      bind(...args: any[]) {
        return {
          async run() { stmt().run(...args); return {}; },
          async first() { return stmt().get(...args) ?? null; },
          async all() { return { results: stmt().all(...args) }; },
        };
      },
      async first() { return stmt().get() ?? null; },
      async all() { return { results: stmt().all() }; },
    };
  },
} as any;

const d = await getAdminDashboard(db, now);
assert(d.ordersTotal === 5, "total orders counts every order row, all time");
assert(d.ordersToday === 3, "orders today counts today's three test orders");
assert(d.orders7d === 5, "orders last 7 days counts all five fixture orders");
assert(d.revenue30dCents === 2899, "revenue counts complete orders only ($20.00 + $8.99)");
assert(d.pendingFulfillment.printedWaiting === 1 && d.pendingFulfillment.boxesNeedAttention === 1 && d.pendingFulfillment.total === 2, "pending fulfillment = printed waiting + boxes needing attention");
assert(d.attention.brokenBooks.some((b) => b.title.startsWith("Penny") && b.state === "repair failed"), "needs attention names the repair-failed book by title");
assert(d.attention.brokenBooks.some((b) => b.title.startsWith("Tilda") && b.state.startsWith("failed")), "needs attention names the failed book by title");
assert(d.attention.booksAtGates === 2, "two books sit at review gates (ready_for_qa)");
assert(d.attention.outboxPending === 1 && d.attention.outboxFailed === 1, "outbox pending and failed counts are real");
assert(d.attention.reviewsPending === 1, "reviews awaiting moderation counted");
assert(d.attention.uncastLeads.length === 1 && d.attention.uncastLeads[0].lead === "Mira", "the published book with an uncast lead is flagged (Mira); the cast lead (Wally) is not");
assert(d.fulfillment.printedByStatus.find((s) => s.status === "preorder_received")?.count === 1, "fulfillment snapshot counts printed orders by stage");
assert(d.fulfillment.boxesDue7d === 1, "the club box due in two days is counted in the 7-day window");
assert(d.audience.subscribers === 2, "subscriber count is real");
assert(d.audience.clubActiveByPlan.length === 0 && d.audience.audioClubActive === 0, "club audience reads honestly as zero");
assert(d.recentOrders.length === 5, "recent orders returns the latest orders (bounded at 8)");
assert(d.recentOrders[0].items[0] === "Penny the Squirrel and the Acorn Orchard (audiobook only)", "recent orders render the Penny title, per the display rule");
assert(!JSON.stringify(d.recentOrders).includes("richdadpoordad"), "no internal slug anywhere in the recent-orders payload");

// ---- Shell + dashboard source pins --------------------------------------
const shell = read("../src/components/AdminShell.astro");
assert(shell.includes("ADMIN_NAV"), "the shell renders the grouped nav model");
assert(shell.includes('localStorage.getItem("bbs-admin-sidebar")') && shell.includes('localStorage.setItem("bbs-admin-sidebar"'), "the sidebar persists its collapsed choice");
assert(shell.includes('data-sidebar') && shell.includes('data-mobile-nav'), "the shell drives collapsed and mobile states from html data attributes");
assert(shell.includes("data-label={item.label}"), "collapsed rail items carry hover labels");
assert(shell.includes("isEditorRoute(Astro.url.pathname)"), "the shell auto-collapses on editor routes");
assert(shell.includes('id="bbs-signout"'), "sign out is pinned at the rail's foot");

const adminDir = new URL("../src/pages/admin/", import.meta.url);
const pageFiles: string[] = [];
(function walk(u: URL) {
  for (const ent of readdirSync(u, { withFileTypes: true })) {
    if (ent.isDirectory()) walk(new URL(ent.name + "/", u));
    else if (ent.name.endsWith(".astro")) pageFiles.push(new URL(ent.name, u).pathname);
  }
})(adminDir);
let shellPages = 0;
for (const f of pageFiles) {
  const src = readFileSync(f, "utf8");
  if (src.includes("AdminShell")) shellPages += 1;
  assert(!src.includes("AdminHeader"), `${f.split("/").slice(-2).join("/")} no longer uses the old top nav`);
}
assert(shellPages >= 20, `the shell is on every admin page (${shellPages} found)`);

const dash = read("../src/pages/admin/index.astro");
for (const marker of ["Total orders", "in the last 7 days", "Pending fulfillment", "Revenue, last 30 days", "Completed orders only", "Needs attention", "Fulfillment", "Audience", "Recent orders", "getAdminDashboard", "View all", "Club boxes due in the next 7 days"]) {
  assert(dash.includes(marker), `dashboard carries: ${marker}`);
}
// Round 3 layout pins: three stat cards, actions below them, native
// list sections instead of the old chips and table.
assert(dash.includes("grid-template-columns:repeat(3,1fr)"), "stats are three across at every width");
assert(dash.indexOf('class="stats"') < dash.indexOf('class="actions"'), "the actions pill row sits below the stat cards");
assert(!dash.includes("Orders today") && !dash.includes("Orders, last 7 days"), "the old per-window order cards are gone");
assert(dash.includes('class="steps"') && dash.includes('class="step'), "fulfillment stages render as a segmented stepper");
assert(dash.includes('class="row"') && dash.includes('class="sec-head"'), "sections use native list rows and tappable headers");
assert(!dash.includes("<table"), "recent orders is a list, not the cramped table");
for (const h of ["/admin/orders", "/admin/club", "/admin/books", "/admin/reviews", "/admin/cast-gemini"]) {
  assert(dash.includes(`href="${h}"`), `dashboard links through to ${h}`);
}

console.log(failures === 0 ? "\nALL ADMIN SHELL TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
