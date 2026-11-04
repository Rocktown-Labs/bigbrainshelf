// Tests for the cast gallery manifest's fresh-read contract
// (src/lib/cast-gallery.ts). The manifest cache is per-isolate and
// a save only updates the SAVING isolate's cache, so a plain load
// can serve a pre-save snapshot for up to the TTL: that is the
// divergence behind "I saved and it was not there". Pinned here:
// mutation paths read through to R2 (fresh), so a save built on a
// warm cache can never clobber another save's character, and the
// crop editor's reads return the saved truth.
//
// Run with: bun tests/cast-gallery-fresh.test.ts
import UPNG from "upng-js";
import {
  loadCastGallery, saveCharacterGallery, invalidateCastGalleryCache,
  GALLERY_MANIFEST_KEY, type GalleryManifest,
} from "../src/lib/cast-gallery";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

function fakeBooks(seed: Record<string, Uint8Array | string>) {
  const store = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(seed)) {
    store.set(k, typeof v === "string" ? new TextEncoder().encode(v) : v);
  }
  return {
    store,
    async get(key: string) {
      const data = store.get(key);
      if (!data) return null;
      return {
        async text() { return new TextDecoder().decode(data); },
        async arrayBuffer() { return data.slice().buffer as ArrayBuffer; },
      };
    },
    async put(key: string, value: any) {
      if (typeof value === "string") store.set(key, new TextEncoder().encode(value));
      else if (value instanceof ArrayBuffer) store.set(key, new Uint8Array(value));
      else store.set(key, new Uint8Array(value));
    },
    async delete(key: string) { store.delete(key); },
    async list(opts: { prefix: string }) {
      const objects = [...store.keys()].filter((k) => k.startsWith(opts.prefix)).map((key) => ({ key }));
      return { objects, truncated: false };
    },
  };
}

function makeSheetPng(): Uint8Array {
  const w = 200, h = 100;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 240; data[i * 4 + 1] = 235; data[i * 4 + 2] = 220; data[i * 4 + 3] = 255;
  }
  return new Uint8Array(UPNG.encode([data.buffer as ArrayBuffer], w, h, 0));
}

function entryFor(name: string, slug: string) {
  return {
    name,
    bookSlug: "testbook",
    sheetKey: `characters/${slug}.png`,
    portrait: `https://media.bigbrainshelf.com/cast-gallery/${slug}/portrait.png`,
    poses: [`https://media.bigbrainshelf.com/cast-gallery/${slug}/pose-1.png`],
    poseCount: 1,
    boxes: [{ x: 0.1, y: 0.1, w: 0.5, h: 0.8 }],
    portraitIndex: 0,
    sheetSize: { w: 200, h: 100 },
    v: 1,
  };
}

const sheet = makeSheetPng();
const baseManifest: GalleryManifest = {
  generatedAt: 1,
  characters: { testo: entryFor("Testo", "testo") },
};
const books = fakeBooks({
  [GALLERY_MANIFEST_KEY]: JSON.stringify(baseManifest),
  "characters/testo.png": sheet,
  "cast-gallery/testo/pose-1.png": sheet,
  "cast-gallery/testo/portrait.png": sheet,
});

/* ---------- the hazard: a warm cache serves the pre-save snapshot ---------- */
invalidateCastGalleryCache();
const first = await loadCastGallery(books as any);
assert(!!first.characters.testo && !first.characters.nova, "cache: first load warms this isolate");

// Another isolate saves: a new character lands in R2 behind our back.
const external: GalleryManifest = JSON.parse(JSON.stringify(first));
external.characters.nova = entryFor("Nova", "nova");
await books.put(GALLERY_MANIFEST_KEY, JSON.stringify(external));

const stale = await loadCastGallery(books as any);
assert(!stale.characters.nova, "cache: plain load within the TTL still serves the snapshot (the hazard, documented)");
const fresh = await loadCastGallery(books as any, { fresh: true });
assert(!!fresh.characters.nova, "fresh: read-through returns the saved truth immediately");

/* ---------- a mutation built on the warm cache keeps the other save ---------- */
invalidateCastGalleryCache();
await loadCastGallery(books as any); // warm WITHOUT nova? no: R2 already has nova now.
// Re-warm a cache that lacks the external change by restoring the base manifest in R2
// AFTER warming is impossible; instead point the cache at the base manifest, then
// re-apply the external change, then save testo through the mutation path.
await books.put(GALLERY_MANIFEST_KEY, JSON.stringify(baseManifest));
invalidateCastGalleryCache();
await loadCastGallery(books as any); // cache = base (testo only)
await books.put(GALLERY_MANIFEST_KEY, JSON.stringify(external)); // nova lands "elsewhere"

const { entry } = await saveCharacterGallery(books as any, "testo", [{ x: 0.2, y: 0.1, w: 0.5, h: 0.8 }], 0);
assert(entry.v === 2, `mutation: testo saved and bumped (v=${entry.v})`);
const after = JSON.parse(new TextDecoder().decode(books.store.get(GALLERY_MANIFEST_KEY)!)) as GalleryManifest;
assert(!!after.characters.nova, "mutation: the other isolate's character survives my save (no clobber)");
assert(after.characters.testo.v === 2, "mutation: R2 manifest carries the new testo version");
const readBack = await loadCastGallery(books as any, { fresh: true });
assert(readBack.characters.testo.v === 2 && !!readBack.characters.nova,
  "persist: fresh read after the save returns both characters at their saved versions");

if (failures) { console.error(failures + " FAILURES"); process.exit(1); }
console.log("ALL PASS");
