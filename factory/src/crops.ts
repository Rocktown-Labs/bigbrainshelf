// Pose crops: single-pose character references cut from the approved
// character sheets (Phase 2 of the factory rethink, 2026-10-28).
//
// Why: the multi-pose sheets condition generation with EVERY pose the
// character owns, and the artist kept pasting several of them into one
// scene (the clone family: two sailor-hat Skippers, five Junos). A crop
// shows the artist exactly ONE pose of the character, so a scene that
// casts the character once gets the character once.
//
// Data model (written by the hub's Crop Mode, read here):
//   books/{slug}/crops.json            the manifest
//   books/{slug}/crops/{tag}.png|jpg   one file per crop
// Manifest entry: {tag, character, action, source: "sheet",
//   bbox: {x, y, w, h} (fractions of the source sheet), createdAt,
//   key? (the R2 key the hub wrote; factories probe .png/.jpg without it)}
// Tag grammar: {character}-p{n}-{action}, lowercase, props ride the
// action token (skipper-p2-megaphone).
//
// A book opts in by having a manifest at all: no crops.json means the
// legacy sheet path, byte for byte. Books WITH a manifest are gated:
// every bible character needs >= 1 tag before art proceeds.

export interface CropEntry {
  tag: string;
  character: string;
  action: string;
  source: string;
  bbox: { x: number; y: number; w: number; h: number };
  createdAt: number;
  key?: string;
}

export function cropsManifestKey(slug: string): string {
  return `books/${slug}/crops.json`;
}

export function cropKeyCandidates(slug: string, entry: CropEntry): string[] {
  if (entry.key) return [entry.key];
  return [
    `books/${slug}/crops/${entry.tag}.png`,
    `books/${slug}/crops/${entry.tag}.jpg`,
  ];
}

const cropsCache = new Map<string, CropEntry[] | null>();

// Load a book's crop manifest. Malformed or missing manifest reads as
// null (no crops), never as an error: conditioning must degrade to the
// sheet path, not break a build.
export async function loadCrops(env: any, slug: string): Promise<CropEntry[] | null> {
  if (cropsCache.has(slug)) return cropsCache.get(slug)!;
  let out: CropEntry[] | null = null;
  try {
    const obj = await env.BOOKS.get(cropsManifestKey(slug));
    if (obj) {
      const doc = JSON.parse(await obj.text());
      const list = Array.isArray(doc) ? doc : Array.isArray(doc?.crops) ? doc.crops : null;
      if (list) {
        out = list
          .filter(
            (e: any) =>
              e && typeof e.tag === "string" && typeof e.character === "string" && typeof e.action === "string"
          )
          .map((e: any) => ({
            tag: String(e.tag).toLowerCase(),
            character: String(e.character),
            action: String(e.action).toLowerCase(),
            source: String(e.source ?? "sheet"),
            bbox: {
              x: Number(e.bbox?.x) || 0,
              y: Number(e.bbox?.y) || 0,
              w: Number(e.bbox?.w) || 0,
              h: Number(e.bbox?.h) || 0,
            },
            createdAt: Number(e.createdAt) || 0,
            key: typeof e.key === "string" ? e.key : undefined,
          }));
      }
    }
  } catch (e: any) {
    console.log(`crops: manifest unreadable for ${slug} (${e?.message ?? e}); treating as no crops`);
    out = null;
  }
  cropsCache.set(slug, out);
  return out;
}

export function cropsForCharacter(crops: CropEntry[], character: string): CropEntry[] {
  const want = String(character ?? "").trim().toLowerCase();
  if (!want) return [];
  return crops.filter((c) => c.character.trim().toLowerCase() === want);
}

const cropBytesCache = new Map<string, Uint8Array | null>();
export async function loadCropBytes(env: any, slug: string, entry: CropEntry): Promise<Uint8Array | null> {
  for (const key of cropKeyCandidates(slug, entry)) {
    if (cropBytesCache.has(key)) {
      const hit = cropBytesCache.get(key)!;
      if (hit) return hit;
      continue;
    }
    try {
      const obj = await env.BOOKS.get(key);
      const bytes = obj ? new Uint8Array(await obj.arrayBuffer()) : null;
      cropBytesCache.set(key, bytes);
      if (bytes) return bytes;
    } catch {
      cropBytesCache.set(key, null);
    }
  }
  return null;
}

// ------------------------------------------------------------- pose matching
//
// Deterministic keyword map from scene language to crop actions. The
// scene side comes from the structured scene (each cast member's
// "doing") or, for legacy plans, the page's art prompt + character
// field. The crop side is the manifest's free-text action token.
// Matching is deliberately boring: normalize, tokenize, look the words
// up. No model call decides which pose a page gets.
export const ACTION_KEYWORDS: Record<string, string[]> = {
  flying: ["fly", "flying", "flight", "soar", "soaring", "glide", "gliding", "airborne", "wings", "flapping", "sky"],
  swimming: ["swim", "swimming", "dive", "diving", "underwater", "splashing", "paddling"],
  running: ["run", "running", "race", "racing", "dash", "dashing", "sprint", "sprinting", "chase", "chasing", "hurry", "hurrying"],
  sitting: ["sit", "sitting", "seated", "perch", "perched", "resting", "waiting"],
  standing: ["stand", "standing", "stands"],
  carrying: ["carry", "carrying", "hold", "holding", "haul", "hauling", "lift", "lifting", "bear", "bearing", "bring", "bringing"],
  pointing: ["point", "pointing", "show", "showing", "indicate", "indicating"],
  megaphone: ["megaphone", "shout", "shouting", "announce", "announcing", "calling", "yell", "yelling"],
  sleeping: ["sleep", "sleeping", "nap", "napping", "asleep", "dozing"],
  eating: ["eat", "eating", "peck", "pecking", "nibble", "nibbling", "drink", "drinking", "sip", "sipping"],
  building: ["build", "building", "stack", "stacking", "hammer", "hammering", "construct", "saw", "sawing"],
  reading: ["read", "reading", "book", "map"],
  waving: ["wave", "waving", "greet", "greeting"],
  jumping: ["jump", "jumping", "leap", "leaping", "hop", "hopping", "bounce", "bouncing"],
  digging: ["dig", "digging", "bury", "burying", "shovel"],
  singing: ["sing", "singing", "song", "chirp", "chirping"],
  pulling: ["pull", "pulling", "tug", "tugging", "drag", "dragging"],
  pushing: ["push", "pushing", "shove", "shoving"],
  rowing: ["row", "rowing", "paddle", "paddling"],
  climbing: ["climb", "climbing", "scramble", "scrambling"],
  dancing: ["dance", "dancing", "twirl", "twirling", "spin", "spinning"],
  fishing: ["fish", "fishing", "rod"],
  pouring: ["pour", "pouring", "fill", "filling"],
  writing: ["write", "writing", "draw", "drawing", "sketch"],
};

function wordsOf(text: string): string[] {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Scene prose inflects ("swims", "flying", "perched"); crop actions
// are base forms. A light stem on both sides keeps the matching
// deterministic without pretending to be NLP.
function stem(w: string): string {
  return w.length > 3 ? w.replace(/(ingly|edly|ing|ed|es|s)$/, "") : w;
}

// stem -> families, precomputed over family names + keywords.
const STEM_TO_FAMILIES = new Map<string, Set<string>>();
for (const [fam, words] of Object.entries(ACTION_KEYWORDS)) {
  for (const w of [fam, ...words]) {
    const s = stem(w);
    if (!STEM_TO_FAMILIES.has(s)) STEM_TO_FAMILIES.set(s, new Set());
    STEM_TO_FAMILIES.get(s)!.add(fam);
  }
}

// The action a crop represents: its manifest action token, expanded
// through the same keyword map (a crop tagged "flight" answers to the
// "flying" family, a crop tagged "megaphone" to the megaphone family).
function actionFamilies(action: string): Set<string> {
  const out = new Set<string>();
  for (const tok of wordsOf(action)) {
    out.add(tok);
    if (ACTION_KEYWORDS[tok]) out.add(tok);
    for (const f of STEM_TO_FAMILIES.get(stem(tok)) ?? []) out.add(f);
  }
  return out;
}

function sceneFamilies(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of wordsOf(text)) {
    for (const f of STEM_TO_FAMILIES.get(stem(w)) ?? []) out.add(f);
  }
  return out;
}

export interface SceneLike {
  cast?: { name?: string; doing?: string }[];
  [k: string]: any;
}

// Resolve a pose crop for ONE character from scene language. Priority:
//   1. a crop whose action family intersects the scene's action words
//   2. the character's only crop (one pose beats the whole sheet)
//   3. a neutral "standing" crop
//   4. null (caller falls back to the sheet and logs the miss)
export function resolvePoseTag(
  sceneText: string,
  character: string,
  crops: CropEntry[]
): CropEntry | null {
  const mine = cropsForCharacter(crops, character);
  if (!mine.length) return null;
  const fams = sceneFamilies(sceneText);
  if (fams.size) {
    const hit = mine.find((c) => {
      const cf = actionFamilies(c.action);
      for (const f of fams) if (cf.has(f)) return true;
      return false;
    });
    if (hit) return hit;
  }
  if (mine.length === 1) return mine[0];
  const neutral = mine.find((c) => actionFamilies(c.action).has("standing"));
  if (neutral) return neutral;
  return null;
}

// Resolve crops for every named character on a page. The scene text
// per character is that character's own "doing" in a structured scene;
// legacy pages share the whole prompt text across the cast. Returns a
// Map keyed by the caller's character name, value the crop entry or
// null when nothing resolved.
export function resolveSceneCrops(
  scene: SceneLike | null | undefined,
  characterField: string | undefined,
  promptText: string,
  crops: CropEntry[]
): Map<string, CropEntry | null> {
  const out = new Map<string, CropEntry | null>();
  const names: { name: string; text: string }[] = [];
  if (scene?.cast?.length) {
    for (const c of scene.cast) {
      const name = String(c?.name ?? "").trim();
      if (name) names.push({ name, text: String(c?.doing ?? "") || promptText });
    }
  }
  if (!names.length && characterField) {
    for (const raw of String(characterField).split(",")) {
      const name = raw.replace(/[\[\]']/g, "").trim();
      if (name) names.push({ name, text: promptText });
    }
  }
  for (const { name, text } of names) {
    if (!out.has(name)) out.set(name, resolvePoseTag(text, name, crops));
  }
  return out;
}

// ------------------------------------------------------------- pipeline gate
//
// Opt-in coverage: a book with NO manifest is never gated (legacy
// path). A book WITH a manifest needs >= 1 tag per bible character
// before art proceeds; the untagged names are what the park message
// reports.
export async function cropsCoverage(
  env: any,
  slug: string,
  bible: any
): Promise<{ hasManifest: boolean; untagged: string[] }> {
  const crops = await loadCrops(env, slug);
  if (!crops) return { hasManifest: false, untagged: [] };
  const untagged: string[] = [];
  for (const c of bible?.characters ?? []) {
    const name = String(c?.name ?? "").trim();
    if (!name) continue;
    if (!cropsForCharacter(crops, name).length) untagged.push(name);
  }
  return { hasManifest: true, untagged };
}
