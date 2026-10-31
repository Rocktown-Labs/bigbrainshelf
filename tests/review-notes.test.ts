// Story Review notes tests: table creation, page-key/kind validation,
// tag normalization (unknown tags dropped, canonical order), the
// note-or-a-tag requirement, resolved flipping, flagged-page counting,
// and slug isolation. Runs the real src/lib code against an in-memory
// bun:sqlite database. Run with: bun tests/review-notes.test.ts
import { Database } from "bun:sqlite";
import {
  ensureReviewNotesTable,
  listReviewNotes,
  addReviewNote,
  setReviewNoteResolved,
  countFlaggedPages,
  makePageKey,
  isValidPageKey,
  normalizeTags,
  REVIEW_TAGS,
} from "../src/lib/review-notes";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const raw = new Database(":memory:");
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

// --- pure helpers ---
assert(makePageKey(6, 2) === "6:2", "page key is chapter:pageIndex");
assert(isValidPageKey("6:2") && isValidPageKey("12:0"), "valid page keys pass");
assert(!isValidPageKey("0:1") && !isValidPageKey("6") && !isValidPageKey("6:-1") && !isValidPageKey("a:b"), "invalid page keys fail");
assert(JSON.stringify(normalizeTags(["text", "clone", "clone", "bogus"])) === JSON.stringify(["clone", "text"]), "tags dedupe, drop unknowns, canonical order");
assert(normalizeTags("clone").length === 0 && normalizeTags(null).length === 0, "non-array tags normalize to empty");
assert(REVIEW_TAGS.length === 6, "six defect tags");

// --- table + insert ---
await ensureReviewNotesTable(db);
await ensureReviewNotesTable(db); // idempotent
const tables = raw.query("SELECT name FROM sqlite_master WHERE type='table' AND name='review_notes'").all() as any[];
assert(tables.length === 1, "review_notes table created");

const r1 = await addReviewNote(db, { slug: "mastery", pageKey: "6:2", kind: "line", note: "Two Miras in the ditch scene.", tags: ["clone"], now: 1700000000, id: "n1" });
assert(r1.ok === true, "note with text + tag saves");
const r2 = await addReviewNote(db, { slug: "mastery", pageKey: "6:2", kind: "color", note: "", tags: ["anatomy"], now: 1700000001, id: "n2" });
assert(r2.ok === true, "tag-only note saves");
const r3 = await addReviewNote(db, { slug: "mastery", pageKey: "1:0", kind: "line", note: "Fine catch.", tags: [], now: 1700000002, id: "n3" });
assert(r3.ok === true, "text-only note saves");

// --- validation failures write nothing ---
assert((await addReviewNote(db, { slug: "mastery", pageKey: "6:2", kind: "line", note: "  ", tags: [] })).ok === false, "empty note with no tags rejected");
assert((await addReviewNote(db, { slug: "mastery", pageKey: "x", kind: "line", note: "hi", tags: [] })).ok === false, "bad page_key rejected");
assert((await addReviewNote(db, { slug: "mastery", pageKey: "6:2", kind: "sepia" as any, note: "hi", tags: [] })).ok === false, "bad kind rejected");
assert((await addReviewNote(db, { slug: "bad slug!", pageKey: "6:2", kind: "line", note: "hi", tags: [] })).ok === false, "bad slug rejected");
assert((await addReviewNote(db, { slug: "mastery", pageKey: "6:2", kind: "line", note: "", tags: ["bogus"] })).ok === false, "unknown-only tags count as empty and are rejected");

let notes = await listReviewNotes(db, "mastery");
assert(notes.length === 3, "exactly the three valid notes were stored");
assert(notes.every((n) => n.slug === "mastery"), "notes are slug-scoped");
const n1 = notes.find((n) => n.id === "n1")!;
assert(n1.page_key === "6:2" && n1.kind === "line" && n1.resolved === 0 && JSON.stringify(n1.tags) === '["clone"]', "stored note round-trips with parsed tags");

// --- flagged counting + resolve flow ---
assert(countFlaggedPages(notes) === 2, "two distinct pages flagged");
assert((await setReviewNoteResolved(db, "n1", true)).ok === true, "resolve works");
notes = await listReviewNotes(db, "mastery");
assert(notes.find((n) => n.id === "n1")!.resolved === 1, "resolved persisted");
assert(countFlaggedPages(notes) === 2, "page 6:2 still flagged by its color note");
assert((await setReviewNoteResolved(db, "n2", true)).ok === true, "second resolve works");
notes = await listReviewNotes(db, "mastery");
assert(countFlaggedPages(notes) === 1, "flagged count drops when a page clears");
assert((await setReviewNoteResolved(db, "n2", false)).ok === true, "reopen works");
assert((await setReviewNoteResolved(db, "missing-id", true)).ok === false, "resolving a missing note fails cleanly");
assert((await listReviewNotes(db, "docker")).length === 0, "other books see no notes");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
