// Focused tests for the page-takes logic (src/lib/takes.ts).
// The factory archives a book's artifacts to books/{slug}/archive/v{n}/
// before overwrites and lists them in versions.json; the editor's Takes
// UI flips a page (or the whole book) back to an archived take.
//
// Safety contract pinned here (2026-10-28 fix): every apply snapshots
// the live files it is about to overwrite into a NEW "takes" archive
// version BEFORE touching them; a snapshot failure aborts the apply
// with zero overwrites; applying a line take also applies the version's
// color twin when present, and records the stale-twin cost note when
// absent. The pre-apply snapshot is itself a take, which is what makes
// Apply undoable — proven below by a full round trip.
//
// Run with: bun tests/takes.test.ts
import {
  parseVersionsManifest,
  livePageKey,
  colorTwinKey,
  keyFromImageUrl,
  archiveKeyCandidates,
  getBookVersions,
  listPageTakes,
  applyPageTake,
  applyBookVersion,
  getPdfStaleness,
  STALE_TWIN_NOTE,
  PDF_STALE_WARNING,
} from "../src/lib/takes";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}
function eq(a: any, b: any) { return JSON.stringify(a) === JSON.stringify(b); }

/* ---------- manifest parsing ---------- */
const manifest = {
  slug: "docker",
  versions: [
    { version: 2, at: 1792985685, source: "regen", fingerprint: "x", files: 105, bytes: 72762468 },
    { version: 1, at: 1792836628, source: "regen", fingerprint: "y", files: 105, bytes: 72761942 },
    { version: "bad", at: 1, source: "regen" },
    { version: 3, at: 1792986232, source: "repair", files: 106, bytes: 73384420 },
  ],
};
const parsed = parseVersionsManifest(manifest);
assert(parsed.length === 3, "manifest: bad entries skipped");
assert(parsed[0].version === 1 && parsed[2].version === 3, "manifest: sorted by version");
assert(parsed[0].source === "regen" && parsed[0].files === 105, "manifest: fields carried through");
assert(eq(parseVersionsManifest(JSON.stringify(manifest)), parsed), "manifest: string form parses the same");
assert(eq(parseVersionsManifest("not json"), []), "manifest: garbage string -> empty list");
assert(eq(parseVersionsManifest(null), []), "manifest: null -> empty list");
assert(eq(parseVersionsManifest({}), []), "manifest: missing versions -> empty list");
assert(eq(parseVersionsManifest(undefined), []), "manifest: undefined -> empty list");

/* ---------- page -> file mapping ---------- */
assert(livePageKey("docker", 1, 0) === "books/docker/images/S1-page-0.jpg", "key: standard live page key");
assert(livePageKey("algorithms", 12, 3) === "books/algorithms/images/S12-page-3.jpg", "key: chapter/page interpolate");
assert(colorTwinKey("books/docker/images/S1-page-0.jpg", "docker") === "books/docker/images-color/S1-page-0.jpg",
  "twin: images/ swaps to images-color/");
assert(colorTwinKey("docker/S2-page-1.jpg", "docker") === "books/docker/images-color/S2-page-1.jpg",
  "twin: legacy key maps to the standard color location");
assert(colorTwinKey("books/docker/cover.jpg", "docker") === null, "twin: non-page file has no twin");
assert(
  keyFromImageUrl("https://pub-5e76d8a2d35343dbaa517e251b84e9c5.r2.dev/books/docker/images/S1-page-0.jpg") ===
    "books/docker/images/S1-page-0.jpg",
  "key: extracted from the editor's public image URL",
);
assert(keyFromImageUrl("https://x.r2.dev/docker/S2-page-1.jpg?v=9") === "docker/S2-page-1.jpg", "key: query string stripped");
assert(keyFromImageUrl("not a url") === null && keyFromImageUrl(42) === null, "key: junk -> null");
assert(
  eq(archiveKeyCandidates("books/docker/images/S1-page-0.jpg", "docker", 2),
     ["books/docker/archive/v2/images/S1-page-0.jpg"]),
  "archive: live prefix swaps to archive/v{n}",
);
assert(
  eq(archiveKeyCandidates("docker/S2-page-1.jpg", "docker", 4),
     ["books/docker/archive/v4/images/S2-page-1.jpg"]),
  "archive: legacy docker/ key maps into snapshot images/",
);
assert(eq(archiveKeyCandidates("books/docker/cover.jpg", "docker", 1), ["books/docker/archive/v1/cover.jpg"]),
  "archive: non-page files under books/{slug} still map");
assert(
  eq(archiveKeyCandidates("books/docker/images-color/S1-page-0.jpg", "docker", 3),
     ["books/docker/archive/v3/images-color/S1-page-0.jpg"]),
  "archive: color twin maps into snapshot images-color/",
);

/* ---------- fakes ---------- */
// Op-logging fake bucket: every put is recorded in order so tests can
// prove the snapshot lands before any live overwrite, and puts can be
// made to fail on chosen keys to prove the abort path trips.
function fakeBooks(store: Map<string, Uint8Array>, opts: { failPut?: (key: string) => boolean } = {}) {
  const puts: string[] = [];
  return {
    puts,
    async get(key: string) {
      const bytes = store.get(key);
      if (!bytes) return null;
      return {
        size: bytes.byteLength,
        httpMetadata: { contentType: "image/jpeg" },
        async text() { return new TextDecoder().decode(bytes); },
        async arrayBuffer() { return bytes.slice().buffer; },
      };
    },
    async head(key: string) {
      const bytes = store.get(key);
      return bytes ? { size: bytes.byteLength } : null;
    },
    async put(key: string, value: any) {
      if (opts.failPut && opts.failPut(key)) throw new Error("injected put failure: " + key);
      puts.push(key);
      let buf: Uint8Array;
      if (typeof value === "string") buf = new TextEncoder().encode(value);
      else if (value instanceof ArrayBuffer) buf = new Uint8Array(value);
      else if (value instanceof Uint8Array) buf = value;
      else buf = new Uint8Array(value as any);
      store.set(key, buf);
    },
  };
}
function fakeDb(firstHandler?: (sql: string, binds: any[]) => any) {
  const calls: { sql: string; binds: any[] }[] = [];
  return {
    calls,
    prepare(sql: string) {
      return {
        bind: (...binds: any[]) => ({
          async run() { calls.push({ sql, binds }); return {}; },
          async first() { return firstHandler ? firstHandler(sql, binds) : null; },
          async all() { return { results: [] }; },
        }),
      };
    },
  };
}
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b?: Uint8Array) => (b ? new TextDecoder().decode(b) : null);

function seedStore() {
  const store = new Map<string, Uint8Array>();
  store.set("books/docker/versions.json", enc(JSON.stringify(manifest)));
  store.set("books/docker/editor_chapters.json", enc(JSON.stringify([
    { num: 1, title: "One", pages: [
      { text: "a", image: "https://pub-x.r2.dev/books/docker/images/S1-page-0.jpg" },
      { text: "b", image: "https://pub-x.r2.dev/books/docker/images/S1-page-1.jpg" },
    ]},
    { num: 2, title: "Two", pages: [
      { text: "c", image: "https://pub-x.r2.dev/books/docker/images/S2-page-0.jpg" },
    ]},
  ])));
  store.set("books/docker/images/S1-page-0.jpg", enc("LIVE-0"));
  store.set("books/docker/images/S1-page-1.jpg", enc("LIVE-1"));
  store.set("books/docker/images/S2-page-0.jpg", enc("LIVE-2"));
  store.set("books/docker/archive/v1/images/S1-page-0.jpg", enc("V1-0"));
  store.set("books/docker/archive/v1/images/S1-page-1.jpg", enc("V1-1"));
  // S2-page-0 deliberately absent from v1; present in v2.
  store.set("books/docker/archive/v2/images/S2-page-0.jpg", enc("V2-2"));
  return store;
}

const store = seedStore();
const books = fakeBooks(store);

assert((await getBookVersions(books as any, "docker")).length === 3, "versions: read from manifest");
assert((await getBookVersions(books as any, "ghost")).length === 0, "versions: missing manifest -> empty, no throw");

const lt = await listPageTakes(books as any, "docker", 1, 0);
assert(lt.liveKey === "books/docker/images/S1-page-0.jpg", "takes: live key resolved from editor_chapters URL");
assert(lt.liveSize === 6, "takes: live size reported");
assert(lt.takes.length === 1 && lt.takes[0].version === 1 && lt.takes[0].size === 4, "takes: only versions containing the page are listed");
const lt2 = await listPageTakes(books as any, "docker", 2, 0);
assert(lt2.takes.length === 1 && lt2.takes[0].version === 2, "takes: per-page snapshot presence differs by version");

/* ---------- apply one page: snapshot lands BEFORE the overwrite ---------- */
const db1 = fakeDb();
const putsBefore = books.puts.length;
const applied = await applyPageTake(books as any, db1, "docker", 1, 0, 1);
assert(applied && applied.size === 4, "apply: reports copied size");
assert(dec(store.get("books/docker/images/S1-page-0.jpg")) === "V1-0", "apply: archived bytes now live");
assert(applied && applied.snapshotVersion === 4, "apply: pre-apply snapshot created as the next version (v4)");
assert(dec(store.get("books/docker/archive/v4/images/S1-page-0.jpg")) === "LIVE-0",
  "apply: snapshot holds the PRE-apply live bytes");
{
  const versions = await getBookVersions(books as any, "docker");
  const snapEntry = versions.find((v) => v.version === 4);
  assert(snapEntry && snapEntry.source === "takes" && snapEntry.files === 1,
    "apply: versions.json gained a 'takes' entry for the snapshot");
  const opSlice = books.puts.slice(putsBefore);
  const snapIdx = opSlice.indexOf("books/docker/archive/v4/images/S1-page-0.jpg");
  const manifestIdx = opSlice.indexOf("books/docker/versions.json");
  const liveIdx = opSlice.indexOf("books/docker/images/S1-page-0.jpg");
  assert(snapIdx !== -1 && manifestIdx !== -1 && liveIdx !== -1 && snapIdx < liveIdx && manifestIdx < liveIdx,
    "apply: snapshot copy and manifest write both precede the live overwrite");
}
assert(db1.calls.some((c) => c.sql.includes("page_approvals") && c.binds[0] === "docker" && c.binds[1] === 1 && c.binds[2] === 0),
  "apply: approval cleared for exactly that page");
assert(db1.calls.some((c) => c.sql.includes("page_takes") && c.binds[3] === 1), "apply: pick recorded with the version");
assert(db1.calls.some((c) => c.sql.includes("twin_applied") && c.binds[5] === 0 && typeof c.binds[6] === "string"),
  "apply: pick records twin_applied=0 and the stale-twin note (v1 has no color copy)");
const missing = await applyPageTake(books as any, fakeDb(), "docker", 2, 0, 1);
assert(missing === null, "apply: page with no copy in that version -> null, nothing copied");
assert(dec(store.get("books/docker/images/S2-page-0.jpg")) === "LIVE-2", "apply: untouched page keeps its bytes");
assert((await getBookVersions(books as any, "docker")).length === 4,
  "apply: the null apply created no snapshot (still 4 versions)");

/* ---------- abort path: a failed snapshot performs ZERO overwrites ---------- */
for (const [label, failPut] of [
  ["archive copy fails", (key: string) => key.includes("/archive/")],
  ["manifest write fails", (key: string) => key.endsWith("versions.json")],
] as [string, (key: string) => boolean][]) {
  const s = seedStore();
  const bk = fakeBooks(s, { failPut });
  let threw = false;
  try {
    await applyPageTake(bk as any, fakeDb(), "docker", 1, 0, 1);
  } catch { threw = true; }
  assert(threw, `abort (${label}): apply throws when the snapshot cannot be proven`);
  assert(dec(s.get("books/docker/images/S1-page-0.jpg")) === "LIVE-0",
    `abort (${label}): live page bytes are unchanged`);
  assert(!bk.puts.includes("books/docker/images/S1-page-0.jpg"),
    `abort (${label}): zero puts to the live key`);
}

/* ---------- twin round trip: apply, then undo via the takes snapshot ---------- */
function seedTwinStore() {
  const s = new Map<string, Uint8Array>();
  s.set("books/docker/versions.json", enc(JSON.stringify({
    slug: "docker",
    versions: [{ version: 2, at: 1792985685, source: "regen", fingerprint: "x", files: 105, bytes: 1000 }],
  })));
  s.set("books/docker/editor_chapters.json", enc(JSON.stringify([
    { num: 1, title: "One", pages: [{ text: "a", image: "https://pub-x.r2.dev/books/docker/images/S1-page-0.jpg" }] },
  ])));
  s.set("books/docker/images/S1-page-0.jpg", enc("LINE-ORIG"));
  s.set("books/docker/images-color/S1-page-0.jpg", enc("COLOR-ORIG"));
  s.set("books/docker/archive/v2/images/S1-page-0.jpg", enc("LINE-V2"));
  s.set("books/docker/archive/v2/images-color/S1-page-0.jpg", enc("COLOR-V2"));
  return s;
}
{
  const s = seedTwinStore();
  const bk = fakeBooks(s);
  const db = fakeDb();
  const r = await applyPageTake(bk as any, db, "docker", 1, 0, 2);
  assert(r && r.twinApplied === true && r.twinNote === null, "twin: color twin applied with the line take, no stale note");
  assert(r && r.snapshotVersion === 3, "twin: pre-apply snapshot is v3");
  assert(dec(s.get("books/docker/images/S1-page-0.jpg")) === "LINE-V2", "twin: line art swapped");
  assert(dec(s.get("books/docker/images-color/S1-page-0.jpg")) === "COLOR-V2", "twin: color art swapped to the same version");
  assert(dec(s.get("books/docker/archive/v3/images/S1-page-0.jpg")) === "LINE-ORIG", "twin: snapshot holds pre-apply line bytes");
  assert(dec(s.get("books/docker/archive/v3/images-color/S1-page-0.jpg")) === "COLOR-ORIG", "twin: snapshot holds pre-apply color bytes");
  assert(db.calls.some((c) => c.sql.includes("twin_applied") && c.binds[5] === 1 && c.binds[6] === null),
    "twin: pick records twin_applied=1, note null");
  const takesNow = await listPageTakes(bk as any, "docker", 1, 0);
  assert(takesNow.takes.some((t) => t.version === 3 && t.source === "takes"),
    "twin: the snapshot appears in the page's takes list (undoable from the same dropdown)");

  // Undo through the feature's own path: apply the takes snapshot back.
  const undo = await applyPageTake(bk as any, fakeDb(), "docker", 1, 0, 3);
  assert(undo && undo.twinApplied === true, "undo: applying the takes snapshot applies its twin too");
  assert(dec(s.get("books/docker/images/S1-page-0.jpg")) === "LINE-ORIG", "undo: line bytes identical to the original");
  assert(dec(s.get("books/docker/images-color/S1-page-0.jpg")) === "COLOR-ORIG", "undo: color bytes identical to the original");
}

/* ---------- stale twin: no color copy in the version ---------- */
{
  const s = seedTwinStore();
  s.delete("books/docker/archive/v2/images-color/S1-page-0.jpg");
  const bk = fakeBooks(s);
  const db = fakeDb();
  const r = await applyPageTake(bk as any, db, "docker", 1, 0, 2);
  assert(r && r.twinApplied === false, "stale twin: twin not applied when the version has no color copy");
  assert(r && r.twinNote === STALE_TWIN_NOTE, "stale twin: result carries the stale-twin note");
  assert(STALE_TWIN_NOTE.includes("paid generation") && STALE_TWIN_NOTE.includes("discard the current color art"),
    "stale twin: the note states the cost (paid redo, current color art discarded)");
  assert(dec(s.get("books/docker/images-color/S1-page-0.jpg")) === "COLOR-ORIG", "stale twin: live color page untouched");
  assert(!s.has("books/docker/archive/v3/images-color/S1-page-0.jpg"),
    "stale twin: snapshot set excludes the twin (it was not overwritten)");
  assert(db.calls.some((c) => c.sql.includes("twin_applied") && c.binds[5] === 0 && c.binds[6] === STALE_TWIN_NOTE),
    "stale twin: pick records twin_applied=0 and the note");
}

/* ---------- apply whole book: one snapshot before any overwrite ---------- */
const store2 = seedStore();
const books2 = fakeBooks(store2);
const db2 = fakeDb();
const summary = await applyBookVersion(books2 as any, db2, "docker", 1);
assert(summary.applied === 2 && summary.missing === 1, "book apply: 2 pages applied, 1 missing from v1");
assert(summary.changed === 2, "book apply: changed counted by size difference");
assert(summary.snapshotVersion === 4, "book apply: pre-load snapshot created as v4");
assert(dec(store2.get("books/docker/archive/v4/images/S1-page-0.jpg")) === "LIVE-0" &&
       dec(store2.get("books/docker/archive/v4/images/S1-page-1.jpg")) === "LIVE-1",
  "book apply: snapshot holds every overwritten page's pre-load bytes");
{
  const firstLivePut = books2.puts.findIndex((k) => k.startsWith("books/docker/images/"));
  const manifestPut = books2.puts.indexOf("books/docker/versions.json");
  assert(manifestPut !== -1 && firstLivePut !== -1 && manifestPut < firstLivePut,
    "book apply: the snapshot (incl. manifest) completes before the first live overwrite");
}
assert(dec(store2.get("books/docker/images/S1-page-1.jpg")) === "V1-1", "book apply: second page swapped too");
assert(dec(store2.get("books/docker/images/S2-page-0.jpg")) === "LIVE-2", "book apply: missing page left as-is");
assert(db2.calls.filter((c) => c.sql.includes("page_approvals")).length === 2, "book apply: approvals cleared only for applied pages");
assert(db2.calls.filter((c) => c.sql.includes("page_takes")).length === 2, "book apply: picks recorded per applied page");

/* ---------- publish staleness ---------- */
function stalenessBooks(withPdf: boolean, uploadedIso?: string) {
  const s = new Map<string, Uint8Array>();
  if (withPdf) s.set("books/docker/picture-book.pdf", enc("%PDF-fake"));
  const base = fakeBooks(s);
  return {
    ...base,
    async head(key: string) {
      const h = await base.head(key);
      if (!h) return null;
      return key.endsWith("picture-book.pdf") && uploadedIso ? { ...h, uploaded: new Date(uploadedIso) } : h;
    },
  };
}
{
  const noTakes = fakeDb(() => ({ latest: null }));
  const a = await getPdfStaleness(stalenessBooks(true, "2026-10-27T00:00:00.000Z") as any, noTakes, "docker");
  assert(a.stale === false && a.warning === null, "staleness: no takes recorded -> no warning");

  const newerTake = fakeDb(() => ({ latest: "2026-10-28T12:00:00.000Z" }));
  const b = await getPdfStaleness(stalenessBooks(true, "2026-10-27T00:00:00.000Z") as any, newerTake, "docker");
  assert(b.stale === true && b.warning === PDF_STALE_WARNING, "staleness: take after PDF assembly -> warning");

  const olderTake = fakeDb(() => ({ latest: "2026-10-26T12:00:00.000Z" }));
  const c = await getPdfStaleness(stalenessBooks(true, "2026-10-27T00:00:00.000Z") as any, olderTake, "docker");
  assert(c.stale === false && c.warning === null, "staleness: take before PDF assembly -> no warning");

  const d = await getPdfStaleness(stalenessBooks(false) as any, newerTake, "docker");
  assert(d.stale === false && d.warning === null, "staleness: no PDF in R2 -> no warning even with takes");
}

console.log(failures === 0 ? "\nALL TAKES TESTS PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
