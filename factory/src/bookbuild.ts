import { assembleVerifiedPdf } from "./assembly";
import { stampLine } from "../../packages/core/src/assembly-identity";
import { recordWorkflowRun } from "../../packages/core/src/run-provenance";
// BookBuildWorkflow: full 8-stage book pipeline on Cloudflare.
// Port of run_book_end_to_end.py (which remains the local reference).
// Stages: extract -> split -> bookinfo -> bible -> plan -> images -> assemble -> register
// Each stage is idempotent (checks R2 for existing outputs) and updates
// books.stage / books.stage_detail in D1. Never touches books/docker/.
import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import { extractText as unpdfExtractText } from "unpdf";
import { generateImage, generateImageMetered, generateColorImage, generateColorImageMetered, qcImage, qcImageDetailed, qcColorImage, qcColorImageDetailed, sheetKeyFor, anchoredPrompt, judgeCastListing, castListingOk } from "./ai";
import { loadCrops, loadCropBytes, resolveSceneCrops, cropsCoverage } from "./crops";
import { linePurity, analyzePage, pageVerdict, purifyPage } from "./purity";
import { gatewayConfigured, generateGatewayImage, generateGatewayImageMetered, colorPagePrompt, linePromptFromScene } from "./gateway";
import { validateBible, normalizeBible } from "./biblegate";
import { snapshotIfChanged } from "./versioning";
import { clairicExtract, clairicHeadings, splitOnHeadings } from "./clairic";
import { composeMatter, ensureBackCoverImages } from "./matter";
import { callModel } from "./models";
import { buildBiblePrompt, buildBibleRepairPrompt } from "./bibleprompt";
import { planChapterAttempt } from "./planv3";
import { runReadPass } from "./readpass";
import { checkSourceDuplicate, duplicateMessage, parseSourceIdentity } from "./sourceguard";
import { budgetGate, budgetSettle } from "./budget";
import { emitEvent } from "./events";
import { recordEdition } from "./editions";
import { emitAttemptMetric } from "./metrics";

export interface BookBuildParams {
  slug: string;
}

export interface BookBuildEnv {
  BBS_BUILD_PROVENANCE?: string;
  AI: any;
  BOOKS: R2Bucket;
  DB: D1Database;
  BUDGET?: DurableObjectNamespace;
  METRICS?: any;
  AI_GATEWAY_KEY?: string;
  AI_GATEWAY_IMAGE_MODEL?: string;
  // Cast-listing gate mode: "hard" | "flag" | "off" (default in castGateMode).
  CAST_GATE?: string;
}

const RETRIES = { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" } } as const;
const R2_PUBLIC = "https://pub-5e76d8a2d35343dbaa517e251b84e9c5.r2.dev";

// ---------------------------------------------------------------- R2 helpers

export async function r2ListAll(BOOKS: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const r = await BOOKS.list({ prefix, cursor });
    for (const o of r.objects ?? []) keys.push(o.key);
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return keys;
}

export async function r2GetBytes(BOOKS: R2Bucket, key: string): Promise<Uint8Array | null> {
  const o = await BOOKS.get(key);
  return o ? new Uint8Array(await o.arrayBuffer()) : null;
}

async function r2GetText(BOOKS: R2Bucket, key: string): Promise<string | null> {
  const b = await r2GetBytes(BOOKS, key);
  return b ? new TextDecoder().decode(b) : null;
}

export async function r2GetJson(BOOKS: R2Bucket, key: string): Promise<any | null> {
  const t = await r2GetText(BOOKS, key);
  return t ? JSON.parse(t) : null;
}

export async function r2Put(
  BOOKS: R2Bucket,
  key: string,
  data: string | Uint8Array,
  contentType: string
): Promise<void> {
  await BOOKS.put(key, data, { httpMetadata: { contentType } });
}

async function setStage(env: BookBuildEnv, slug: string, stage: string, detail = ""): Promise<void> {
  try {
    await env.DB.prepare("UPDATE books SET stage=?, stage_detail=?, updated_at=? WHERE slug=?")
      .bind(stage, detail, Math.floor(Date.now() / 1000), slug)
      .run();
    await emitEvent(env, { slug, kind: "stage", stage, event: "stage_changed", detail });
  } catch (e: any) {
    console.log(`setStage(${stage}) failed: ${e?.message ?? e}`);
  }
}

// ---------------------------------------------------------------- stage 2: split (pure logic, ported)

export function splitChapters(text: string): { title: string; body: string }[] {
  const chunks: { title: string; body: string }[] = [];
  const parts = text.split(/^(#{1,3}\s+.+)$/m);
  if (parts.length >= 5) {
    for (let i = 1; i < parts.length; i += 2) {
      const heading = parts[i].replace(/^#+\s*/, "").trim();
      const body = (parts[i + 1] ?? "").trim();
      if (body.length > 500) chunks.push({ title: heading, body });
    }
  }
  if (chunks.length < 3) {
    const paras = text.split("\n\n").map((p) => p.trim()).filter(Boolean);
    const n = Math.min(18, Math.max(3, Math.floor(paras.length / 8)));
    const per = Math.max(1, Math.floor(paras.length / n));
    chunks.length = 0;
    for (let i = 0; i < n; i++) {
      const seg = i < n - 1 ? paras.slice(i * per, (i + 1) * per) : paras.slice(i * per);
      const title = seg.length ? seg[0].slice(0, 60).replace(/\W+/g, " ").trim() : `Part ${i + 1}`;
      chunks.push({ title, body: seg.join("\n\n") });
    }
  }
  return chunks;
}

// ---------------------------------------------------------------- editor_chapters.json (shared with redo routes)

export function pageImageUrl(slug: string, imageKey: string): string {
  return `${R2_PUBLIC}/${imageKey}`;
}

export async function rebuildEditorChapters(env: BookBuildEnv, slug: string): Promise<void> {
  const keys = (await r2ListAll(env.BOOKS, `books/${slug}/plans/`))
    .filter((k) => /\/plans\/S\d+\.json$/.test(k))
    .sort();
  const chapters: any[] = [];
  for (const key of keys) {
    const ch = key.match(/\/plans\/(S\d+)\.json$/)![1];
    const plan = await r2GetJson(env.BOOKS, key);
    if (!plan?.pages?.length) continue;
    chapters.push({
      num: parseInt(ch.slice(1), 10),
      title: plan.storyTitle ?? ch,
      pages: plan.pages.map((pg: any, pi: number) => {
        const imageKey = pg.imageKey ?? `books/${slug}/images/${ch}-page-${pi}.jpg`;
        return {
          text: pg.storyText ?? "",
          image: pageImageUrl(slug, imageKey),
          ...(pg.imageColorKey ? { imageColor: pageImageUrl(slug, pg.imageColorKey) } : {}),
          imagePrompt: pg.imagePrompt ?? "",
          character: pg.character ?? (Array.isArray(pg.characters) ? pg.characters.join(", ") : ""),
          concept: pg.concept ?? plan.concept ?? "",
        };
      }),
    });
  }
  chapters.sort((a, b) => a.num - b.num);
  await r2Put(env.BOOKS, `books/${slug}/editor_chapters.json`, JSON.stringify(chapters, null, 1), "application/json");
}

// ---------------------------------------------------------------- image gen with QC (mirrors python: one retry, keep going)

// Character sheet bytes, cached per isolate so a book build fetches each
// sheet once. The bookstore's character registry (D1 characters.jpg_key)
// is the source of truth: it holds the owner-approved sheets. The legacy
// per-book R2 key is the fallback for books built before the registry.
// Missing sheet = generate without a reference (still fine).
const sheetCache = new Map<string, Uint8Array | null>();
async function loadSheet(
  env: BookBuildEnv,
  slug: string,
  character?: string,
  kind: "color" | "line" = "color"
): Promise<Uint8Array | null> {
  if (!character) return null;
  const name = String(character).replace(/[\[\]']/g, "").split(",")[0].trim();
  if (!name) return null;
  const cacheKey = `${slug}/${kind}/${name.toLowerCase()}`;
  if (sheetCache.has(cacheKey)) return sheetCache.get(cacheKey)!;
  let bytes: Uint8Array | null = null;
  if (kind === "line") {
    // Line-art sheets (single pose, black and white) live apart from
    // the color sheets: the color multi-pose sheets were verified on
    // 2026-10-26 to be the source of both the color leaks (their exact
    // signature colors) and the copied poses in line pages. A book
    // without line sheets yet falls through to its color sheet below.
    const nameKey = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    try {
      const row: any = await env.DB.prepare(
        "SELECT line_jpg_key FROM characters WHERE book_slug=? AND lower(name)=lower(?)"
      ).bind(slug, name).first();
      if (row?.line_jpg_key) bytes = await r2GetBytes(env.BOOKS, String(row.line_jpg_key));
    } catch { /* line_jpg_key column may not exist yet */ }
    if (!bytes) {
      try {
        bytes = await r2GetBytes(env.BOOKS, `characters/line/${nameKey}.png`);
      } catch {
        bytes = null;
      }
    }
    if (bytes) {
      sheetCache.set(cacheKey, bytes);
      return bytes;
    }
  }
  try {
    const row: any = await env.DB.prepare(
      "SELECT jpg_key FROM characters WHERE book_slug=? AND lower(name)=lower(?)"
    ).bind(slug, name).first();
    if (row?.jpg_key) bytes = await r2GetBytes(env.BOOKS, String(row.jpg_key));
  } catch { /* registry unavailable: fall through to the legacy key */ }
  if (!bytes) {
    try {
      bytes = await r2GetBytes(env.BOOKS, sheetKeyFor(slug, name));
    } catch {
      bytes = null;
    }
  }
  sheetCache.set(cacheKey, bytes);
  return bytes;
}

// Sheets for every character named on a page (comma-joined field), up to
// maxRefs. Gateway scenes condition on all of them; line art uses one.
// kind "line" prefers the black-and-white single-pose sheets (falling
// back to the color sheets); kind "color" is the original behavior.
export async function loadSheets(
  env: BookBuildEnv,
  slug: string,
  characterField: string | undefined,
  maxRefs = 3,
  kind: "color" | "line" = "color"
): Promise<Uint8Array[]> {
  if (!characterField) return [];
  const names = String(characterField).split(",").map((s) => s.trim()).filter(Boolean).slice(0, maxRefs);
  const out: Uint8Array[] = [];
  for (const n of names) {
    const b = await loadSheet(env, slug, n, kind);
    if (b) out.push(b);
  }
  return out;
}

// ------------------------------------------------------- page references
//
// The reference set one page is conditioned on. Without a crops
// manifest this is exactly the sheet behavior the factory has always
// had (loadSheets over the character field). With a manifest (Phase 2,
// crops.ts), each named character whose pose tag resolves conditions
// on its single-pose CROP instead of its full sheet; characters
// without a resolution keep their sheet. The QC drift comparison keeps
// using the first character's SHEET either way (the sheet is the
// canonical design reference; the crop is a pose selector).
export interface PageRefs {
  refs: Uint8Array[];
  sheet: Uint8Array | null;
  cropUsed: string[]; // tags that conditioned the page
  cropMissed: string[]; // characters with crops on file but no resolution
}

export async function loadPageRefs(
  env: BookBuildEnv,
  slug: string,
  characterField: string | undefined,
  kind: "color" | "line",
  scene?: any,
  promptText?: string
): Promise<PageRefs> {
  const crops = await loadCrops(env, slug);
  if (!crops) {
    const sheets = await loadSheets(env, slug, characterField, 3, kind);
    return { refs: sheets, sheet: sheets[0] ?? null, cropUsed: [], cropMissed: [] };
  }
  const resolved = resolveSceneCrops(scene, characterField, promptText ?? "", crops);
  const names: string[] = [];
  for (const n of resolved.keys()) if (!names.includes(n)) names.push(n);
  if (characterField) {
    for (const raw of String(characterField).split(",")) {
      const n = raw.replace(/[\[\]']/g, "").trim();
      if (n && !names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n);
    }
  }
  const refs: Uint8Array[] = [];
  const cropUsed: string[] = [];
  const cropMissed: string[] = [];
  let sheet: Uint8Array | null = null;
  for (const name of names.slice(0, 3)) {
    const entry = resolved.get(name) ?? null;
    let used = false;
    if (entry) {
      const bytes = await loadCropBytes(env, slug, entry);
      if (bytes) {
        refs.push(bytes);
        cropUsed.push(entry.tag);
        used = true;
      }
    }
    if (!used) {
      const sheetBytes = await loadSheet(env, slug, name, kind);
      if (sheetBytes) refs.push(sheetBytes);
      if (crops.some((c) => c.character.trim().toLowerCase() === name.toLowerCase())) {
        cropMissed.push(name);
      }
    }
    if (sheet === null) sheet = await loadSheet(env, slug, name, kind);
  }
  if (cropUsed.length) {
    console.log(`crops: ${slug} page conditioned on ${cropUsed.join(", ")}`);
  }
  if (cropMissed.length) {
    console.log(`crops: ${slug} no pose tag resolved for ${cropMissed.join(", ")}; sheet fallback`);
  }
  return { refs, sheet, cropUsed, cropMissed };
}

// ------------------------------------------------------- page cast
//
// Who is DRAWN on a page: the structured scene cast when the plan
// carries one; otherwise every bible character whose name appears in
// the character field or the art prompt, OR whose visual description
// is embedded in the art prompt. Legacy plans embed visuals verbatim
// and name nobody in the prompt, so name-only matching saw a single
// character on two-character pages: QC asked whether the lead was
// duplicated while two herons stood in frame, and the reference set
// shipped only the lead's sheet, so the colorist painted the co-star
// as a second lead (Mira colorize census, 2026-11-01). Never match
// against the story text: narration names characters off-scene.
export function visualInPrompt(visual: string, promptText: string): boolean {
  const words = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean);
  const v = words(visual);
  if (v.length < 6) return false;
  const p = " " + words(promptText).join(" ") + " ";
  const win = Math.min(8, v.length);
  for (let i = 0; i + win <= v.length; i++) {
    if (p.includes(" " + v.slice(i, i + win).join(" ") + " ")) return true;
  }
  return false;
}

export function castForPage(
  bible: any,
  characterField?: string,
  promptText?: string,
  sceneCast?: any[]
): any[] {
  const chars: any[] = bible?.characters ?? [];
  if (!chars.length) return [];
  if (sceneCast?.length) {
    const wanted = new Set(
      sceneCast.map((c: any) => String(c?.name ?? "").toLowerCase()).filter(Boolean)
    );
    const named = chars.filter((c: any) => wanted.has(String(c.name).toLowerCase()));
    if (named.length) return named;
  }
  const field = (characterField ?? "").toLowerCase();
  const prompt = promptText ?? "";
  const promptLower = prompt.toLowerCase();
  return chars.filter((c: any) => {
    const name = String(c.name).toLowerCase();
    return (
      field.includes(name) ||
      promptLower.includes(name) ||
      visualInPrompt(String(c.visual ?? ""), prompt)
    );
  });
}

export function castTextOf(named: any[]): string | null {
  return named.length
    ? named.map((c: any) => `${c.name} (a ${c.species})`).join(", ")
    : null;
}

export function castListOf(named: any[]): any[] | null {
  return named.length
    ? named.map((c: any) => ({
        name: String(c.name),
        species: String(c.species),
        visual: String(c.visual ?? ""),
      }))
    : null;
}

// ------------------------------------------------------- cast-listing gate
//
// The cast-listing judge (ai.ts judgeCastListing + castListingOk) as a
// QC gate. Calibrated offline 2026-10-28 on the factory-ops labeled
// corpus (33 pages: 12 verified clone/cast defects, 21 verified-clean
// pages from the cast audit + the Basil/Penny 40/40 sweeps; harness in
// factory-ops/calib-cast-gate/). Two independent runs agreed:
// castListingOk as-is scores recall 11/12 (0.92) on defects but falsely
// rejects 5/21 clean pages (24%) — background flocks, background
// ducklings, and lister count noise on busy pages. That false-reject
// rate would burn paid re-rolls on good pages, so the gate ships in
// FLAG mode: verdicts are recorded in gen_events (cast_flag) for human
// review and never reject on their own. CAST_GATE=hard is one env flip
// away when a future calibration earns it. Mode from the CAST_GATE env:
//   "hard"  a listing failure rejects the roll like a Clef failure
//   "flag"  a listing failure is recorded (gen_events cast_flag) and
//           the page still ships its Clef verdict
//   "off"   the listing judge is never called
// A null listing (judge unavailable) is NO OPINION in every mode: it
// never rejects and never flags.
export type CastGateMode = "hard" | "flag" | "off";
export const CAST_GATE_DEFAULT: CastGateMode = "flag";

export function castGateMode(env: any): CastGateMode {
  const v = String(env?.CAST_GATE ?? "").trim().toLowerCase();
  if (v === "hard" || v === "flag" || v === "off") return v;
  return CAST_GATE_DEFAULT;
}

// Expected cast for the listing comparison: species counts from the
// page's cast list (two squirrels in the cast means two squirrels are
// wanted; background animals of unlisted species are the comparison's
// known blind spot, which is why the default mode flags, not rejects).
export function expectedFromCastList(castList: { species: string }[] | null | undefined): { species: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const c of castList ?? []) {
    const sp = String(c?.species ?? "").toLowerCase().trim();
    if (sp) counts.set(sp, (counts.get(sp) ?? 0) + 1);
  }
  return [...counts.entries()].map(([species, count]) => ({ species, count }));
}

export async function castGateVerdict(
  env: BookBuildEnv,
  bytes: Uint8Array,
  castList: { species: string }[] | null | undefined
): Promise<{ mode: CastGateMode; reason: string | null }> {
  const mode = castGateMode(env);
  if (mode === "off" || !castList?.length) return { mode, reason: null };
  const listing = await judgeCastListing(env, bytes);
  if (!listing) return { mode, reason: null };
  return { mode, reason: castListingOk(expectedFromCastList(castList), listing) };
}

// ---------------------------------------------------------------- generation metering

// One row per PAID image generation, written to D1 gen_events: which
// book/chapter/page, which attempt, what the gates decided, and what
// the gateway charged. Before this existed (2026-10-25) rejection
// counts lived only in console logs, so "how many times did that page
// regenerate?" had no answer. Metering is best-effort: it never
// blocks or fails the art it measures.
export interface GenEvent {
  attempt: number;
  outcome:
    | "accepted"
    | "autofixed"
    | "purity_reject"
    | "qc_reject"
    | "mask_reject"
    | "held_for_review"
    | "spend_capped"
    | "shipped_flagged" // historical only; the no-ship rule (2026-10-27) retired it
    | "gateway_error"
    // Phase 2 (2026-10-28): pose-crop conditioning notes (attempt 0,
    // cost null: bookkeeping, not rolls) and cast-listing gate verdicts.
    | "crop_used"
    | "crop_miss"
    | "cast_reject"
    | "cast_flag";
  cost: number | null;
}

let genTableReady = false;
export async function logGenEvents(
  env: BookBuildEnv,
  slug: string,
  kind: string,
  chapter: string | null,
  page: number | null,
  events: GenEvent[]
): Promise<void> {
  if (!events.length) return;
  try {
    if (!genTableReady) {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS gen_events (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT, kind TEXT, chapter TEXT, page INTEGER, attempt INTEGER, outcome TEXT, cost REAL, created_at INTEGER)"
      ).run();
      genTableReady = true;
    }
    const now = Math.floor(Date.now() / 1000);
    await env.DB.batch(
      events.map((e) =>
        env.DB.prepare(
          "INSERT INTO gen_events (slug, kind, chapter, page, attempt, outcome, cost, created_at) VALUES (?,?,?,?,?,?,?,?)"
        ).bind(slug, kind, chapter, page, e.attempt, e.outcome, e.cost, now)
      )
    );
  } catch {
    // metering must never break a build
  }
}

// ------------------------------------------------- attempt archive
//
// CG (2026-11-01): every paid roll is kept, good and bad, with the
// gates' scores and the deciding reason, so rejects can be reviewed
// (Story Review in the hub admin) and the archive can seed future
// model tuning. Before this, rejected bytes were discarded and the
// scores lived only in worker logs. One row per roll in D1
// gen_attempts + the roll's bytes under books/{slug}/attempts/.
// Best-effort like metering: archiving never blocks or fails a build.
export interface GenAttemptDetail {
  outcome: string;
  reason?: string | null;
  scores?: Record<string, number | null> | null;
  cost?: number | null;
}

let genAttemptsReady = false;
export async function logGenAttempt(
  env: BookBuildEnv,
  slug: string,
  kind: string,
  chapter: string | null,
  page: number | null,
  attempt: number,
  detail: GenAttemptDetail,
  bytes?: Uint8Array | null
): Promise<void> {
  try {
    let imageKey: string | null = null;
    if (bytes && bytes.length) {
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
      const uniq = `-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      imageKey = `books/${slug}/attempts/${kind}/${chapter ?? "na"}-p${page ?? "na"}-a${attempt}${uniq}.${isPng ? "png" : "jpg"}`;
      await env.BOOKS.put(imageKey, bytes, {
        httpMetadata: { contentType: isPng ? "image/png" : "image/jpeg" },
      });
    }
    if (!genAttemptsReady) {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS gen_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT, kind TEXT, chapter TEXT, page INTEGER, attempt INTEGER, outcome TEXT, reason TEXT, scores TEXT, cost REAL, image_key TEXT, created_at INTEGER)"
      ).run();
      genAttemptsReady = true;
    }
    await env.DB.prepare(
      "INSERT INTO gen_attempts (slug, kind, chapter, page, attempt, outcome, reason, scores, cost, image_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    )
      .bind(
        slug,
        kind,
        chapter,
        page,
        attempt,
        detail.outcome,
        detail.reason ?? null,
        detail.scores ? JSON.stringify(detail.scores) : null,
        detail.cost ?? null,
        imageKey,
        Math.floor(Date.now() / 1000)
      )
      .run();
    // Budget counter + metrics plane ride this choke point: every paid
    // roll in the factory reports its real cost through here.
    if (typeof detail.cost === "number" && detail.cost > 0) {
      await budgetSettle(env, slug, detail.cost);
    }
    emitAttemptMetric(env, slug, kind, chapter, page, attempt, detail);
  } catch {
    // archiving must never break a build
  }
}

// ------------------------------------------------------- retry policy
//
// MAX_ROLLS = 2 (merged factory-scale plan, CG approved 2026-11-01):
// the blind third roll converted under 11% on both surfaces and ate
// 22.5% of the metered window. These loops never change strategy
// between rolls, so a third identical roll is a lottery ticket. A
// further attempt at a page happens only when a caller changes the
// strategy first (Repair rounds, a prompt or reference fix, or a
// human re-fire), never as an automatic identical re-roll.
export const MAX_ROLLS = 2;

// ------------------------------------------------------- run budget + holds
//
// The no-ship rule (CG, via the 2026-10-26 factory review): a page that
// fails its gates after every attempt is HELD for review, never shipped
// as the "best" failure. Held pages are flagged on the plan, assembly
// refuses to build while any exist, and the gen functions return null.
// Paired with a per-run spend cap: when a run's metered image spend
// reaches the cap, further pages hold instead of rolling.
export const DEFAULT_RUN_CAP_USD = 10;

let runColsReady = false;
export async function ensureRunCols(env: BookBuildEnv): Promise<void> {
  if (runColsReady) return;
  for (const sql of [
    "ALTER TABLE books ADD COLUMN run_started_at INTEGER",
    "ALTER TABLE books ADD COLUMN spend_cap_usd REAL",
    "ALTER TABLE books ADD COLUMN pilot_approved INTEGER",
  ]) {
    try {
      await env.DB.prepare(sql).run();
    } catch { /* column already exists */ }
  }
  runColsReady = true;
}

export async function beginRun(env: BookBuildEnv, slug: string): Promise<void> {
  try {
    await ensureRunCols(env);
    await env.DB.prepare("UPDATE books SET run_started_at=? WHERE slug=?")
      .bind(Math.floor(Date.now() / 1000), slug)
      .run();
  } catch { /* budget tracking is best-effort */ }
}

// The cap in force for this run when metered spend has reached it, else
// null. Inactive when no run start is recorded (ad-hoc route calls).
export async function spendCapHit(env: BookBuildEnv, slug: string): Promise<number | null> {
  try {
    const row: any = await env.DB.prepare(
      "SELECT run_started_at, spend_cap_usd FROM books WHERE slug=?"
    ).bind(slug).first();
    if (!row?.run_started_at) return null;
    const cap =
      typeof row.spend_cap_usd === "number" && row.spend_cap_usd > 0
        ? row.spend_cap_usd
        : DEFAULT_RUN_CAP_USD;
    const s: any = await env.DB.prepare(
      "SELECT COALESCE(SUM(cost),0) AS spent FROM gen_events WHERE slug=? AND created_at>=?"
    ).bind(slug, row.run_started_at).first();
    return (s?.spent ?? 0) >= cap ? cap : null;
  } catch {
    return null;
  }
}

// Pages flagged held across a book's plans. Assembly (base and color)
// refuses while this list is non-empty.
export async function heldPages(
  env: BookBuildEnv,
  slug: string,
  n: number,
  kind: "line" | "color" = "line"
): Promise<string[]> {
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    const ch = `S${i}`;
    const plan = await r2GetJson(env.BOOKS, `books/${slug}/plans/${ch}.json`);
    if (!plan?.pages) continue;
    plan.pages.forEach((pg: any, pi: number) => {
      if (kind === "line" ? pg.held : pg.colorHeld) out.push(`${ch}p${pi}`);
    });
    if (kind === "line" ? plan.finale?.held : plan.finale?.colorHeld) out.push(`${ch} finale`);
  }
  return out;
}

// Coloring-book caption for one page: "Name: concept", with the
// concept's own leading repetition of the name stripped (the PDF showed
// "Juno: Juno counts..." because concepts often open with the name).
export function coloringCaption(pg: any): string {
  const name = String(pg?.character ?? "").split(",")[0].trim();
  let concept = String(pg?.concept ?? "").trim();
  if (name && concept.toLowerCase().startsWith(name.toLowerCase())) {
    concept = concept.slice(name.length).replace(/^[:\s,]+/, "").trim();
    if (concept) concept = concept.charAt(0).toUpperCase() + concept.slice(1);
  }
  return name ? `${name}: ${concept}` : concept;
}

// ---- QC edit pass (CG, 2026-11-02) -----------------------------------
// Fresh rolls re-roll the same dice: nothing carries over between
// attempts but the prompt and the sheets, so a page whose composition
// is right but whose gates keep missing can burn rolls forever
// (Penny S2p3: eight rejects in a day, all near misses). The edit
// pass is the escalation: after the fresh rolls fail, take the best
// reject, hand it back to the artist AS A REFERENCE with its own QC
// diagnosis translated into fix instructions, and gate the result
// with the exact same gates. One edit pass per gen call, budgeted
// and capped like any other roll, archived like any other attempt.
function editFixLines(reasons: string[]): string[] {
  const fixes = new Set<string>();
  const joined = reasons.join(" | ").toLowerCase();
  if (joined.includes("anatomy")) fixes.add("Correct the anatomy so every paw, foot, limb, and tail is natural and correctly drawn.");
  if (joined.includes("dupe") || joined.includes("appears more than once") || joined.includes("more than 1"))
    fixes.add("Each named character must appear exactly once in the scene. Remove any duplicate of a character.");
  if (joined.includes("single_scene") || joined.includes("collage") || joined.includes("pose-sheet") || joined.includes("pose sheet"))
    fixes.add("One single scene only: no panels, no collage, no model-sheet or pose-sheet layout.");
  if (joined.includes("character_match") || joined.includes("does not match"))
    fixes.add("Match each character to their model sheet (the other reference images) exactly: same face, markings, and accessories.");
  if (joined.includes("cast") || joined.includes("missing"))
    fixes.add("Every character named in the scene direction must be present in the scene, drawn once, matching their model sheet.");
  if (joined.includes("color") || joined.includes("chroma"))
    fixes.add("Remove all color: pure black and white line art only.");
  if (joined.includes("gray") || joined.includes("fill") || joined.includes("shading"))
    fixes.add("Use clean black outlines on a white background only: no gray fills, no shading, no signature marks.");
  if (joined.includes("text") || joined.includes("letter"))
    fixes.add("Remove any text, letters, or words from the image.");
  if (joined.includes("human")) fixes.add("No humans or human-like figures anywhere in the scene.");
  return [...fixes];
}

function editFindings(reasons: string[]): string {
  // The artist cannot use gate scores; strip them and keep the prose.
  return reasons
    .map((r) => r.replace(/scored?\\s*[\\d.]+/gi, "below the quality bar").replace(/score\\s*=\\s*[\\d.]+/gi, "score below the quality bar").replace(/\\s+/g, " ").trim())
    .filter(Boolean)
    .join("; ");
}

export async function genImageWithQC(
  env: BookBuildEnv,
  slug: string,
  prompt: string,
  character?: string,
  meta?: { chapter?: string; page?: number },
  sceneText?: string,
  scene?: any
): Promise<Uint8Array | null> {
  // Whole-cast list for the species QC. With a structured scene, the
  // cast is the scene's cast (names live there, never in the assembled
  // prompt). Otherwise the legacy rule: names in the (anchored) prompt
  // or the character field. Never the story text: narration mentions
  // characters who are not in the scene (Wren S5, 2026-10-25).
  let castText: string | null = null;
  let castList: any[] | null = null;
  try {
    const bible: any = await r2GetJson(env.BOOKS, `books/${slug}/bible.json`);
    const named = castForPage(bible, character, prompt, scene?.cast);
    castText = castTextOf(named);
    castList = castListOf(named);
  } catch {
    // bible unreadable: QC falls back to the sheet comparison alone
  }
  // Reference conditioning (Phase 2): pose crops where the book has
  // them and a tag resolves for a character, sheets otherwise. With no
  // crops manifest this is exactly the old loadSheets behavior.
  const pageRefs = await loadPageRefs(env, slug, character, "line", scene, prompt);
  const sheets = pageRefs.refs;
  const sheet = pageRefs.sheet;
  // Up to 3 attempts, every one gated. Gate order: the deterministic
  // pixel gate first (aspect, chroma, gray fill — with auto-strip for
  // signature-marking specks), then Clef QC. NO fallback ship: if every
  // attempt fails, the page is held for review and null comes back.
  const events: GenEvent[] = [];
  if (pageRefs.cropUsed.length) events.push({ attempt: 0, outcome: "crop_used", cost: null });
  if (pageRefs.cropMissed.length) events.push({ attempt: 0, outcome: "crop_miss", cost: null });
  let strikes = 0;
  // Best reject so far, for the edit pass below: a Clef reject beats
  // a purity reject (the composition at least rendered), and among
  // Clef rejects the one with the fewest failing clauses wins.
  let bestReject: { bytes: Uint8Array; reasons: string[]; failCount: number } | null = null;
  const noteReject = (bytes: Uint8Array, reasons: string[], failCount: number) => {
    if (!bestReject || failCount < bestReject.failCount) bestReject = { bytes, reasons, failCount };
  };
  for (let attempt = 1; attempt <= MAX_ROLLS; attempt++) {
    const cap = await spendCapHit(env, slug);
    if (cap !== null) {
      events.push({ attempt, outcome: "spend_capped", cost: null });
      await logGenAttempt(env, slug, "line", meta?.chapter ?? null, meta?.page ?? null, attempt, { outcome: "spend_capped", reason: `spend cap $${cap} reached before this roll` });
      console.log(`spend cap ($${cap}) reached for ${slug}; holding the page for review`);
      await logGenEvents(env, slug, "line", meta?.chapter ?? null, meta?.page ?? null, events);
      return null;
    }
    const bcap = await budgetGate(env, slug);
    if (bcap !== null) {
      events.push({ attempt, outcome: "spend_capped", cost: null });
      await logGenAttempt(env, slug, "line", meta?.chapter ?? null, meta?.page ?? null, attempt, { outcome: "budget_capped", reason: `book budget $${bcap} reached before this roll (cross-run budget)` });
      await logGenEvents(env, slug, "line", meta?.chapter ?? null, meta?.page ?? null, events);
      console.log(`book budget ($${bcap}) reached for ${slug}; holding the page for review`);
      return null;
    }
    const cur = await generateImageMetered(env, prompt, sheets.length ? sheets : null);
    let bytes = cur.bytes;
    const a = analyzePage(bytes);
    // Line pages are pinned to 3:4 at the gateway; a square or
    // landscape roll is the wrong render (Maisie's square pages left
    // the PDF gap Claude found in the 2026-10-26 review).
    if (a.decoded && Math.abs(a.width / a.height - 0.75) > 0.06) {
      events.push({ attempt, outcome: "purity_reject", cost: cur.cost });
      await logGenAttempt(env, slug, "line", meta?.chapter ?? null, meta?.page ?? null, attempt, { outcome: "purity_reject", reason: `aspect ${a.width}x${a.height} is not 3:4`, cost: cur.cost }, bytes);
      noteReject(bytes, [`the image is ${a.width}x${a.height}, not the required 3:4 portrait`], 90);
      strikes++;
      console.log(`aspect rejected image (attempt ${attempt} of ${MAX_ROLLS}): ${a.width}x${a.height}`);
      if (strikes >= 2) break;
      continue;
    }
    const v = pageVerdict(a);
    let autofixed = false;
    if (v.verdict === "reject") {
      events.push({ attempt, outcome: "purity_reject", cost: cur.cost });
      await logGenAttempt(env, slug, "line", meta?.chapter ?? null, meta?.page ?? null, attempt, { outcome: "purity_reject", reason: v.reasons.join("; "), cost: cur.cost }, bytes);
      noteReject(bytes, v.reasons, 90);
      strikes++;
      console.log(`purity rejected image (attempt ${attempt} of ${MAX_ROLLS}): ${v.reasons.join("; ")}`);
      // Two purity failures on one page means the STYLE is wrong, not
      // the roll: a third identical-prompt attempt rarely fixes it and
      // just burns credit (Juno's flat fills, 2026-10-24).
      if (strikes >= 2) break;
      continue;
    }
    if (v.verdict === "autofix") {
      const fixed = purifyPage(bytes);
      if (fixed && pageVerdict(analyzePage(fixed)).verdict === "clean") {
        bytes = fixed;
        autofixed = true;
        console.log(`purity autofixed image (attempt ${attempt}): ${v.reasons.join("; ")}`);
      } else {
        events.push({ attempt, outcome: "purity_reject", cost: cur.cost });
        await logGenAttempt(env, slug, "line", meta?.chapter ?? null, meta?.page ?? null, attempt, { outcome: "purity_reject", reason: `autofix failed: ${v.reasons.join("; ")}`, cost: cur.cost }, bytes);
        noteReject(bytes, v.reasons, 90);
        strikes++;
        console.log(`purity autofix failed (attempt ${attempt} of ${MAX_ROLLS}): ${v.reasons.join("; ")}`);
        if (strikes >= 2) break;
        continue;
      }
    }
    const qd = await qcImageDetailed(env.AI, bytes, sheet, castText, castList);
    if (qd.pass) {
      // Cast-listing gate (Phase 2): one listing per Clef-accepted
      // roll. Hard mode rejects like a QC failure; flag mode records
      // the verdict and lets the page through.
      const gate = await castGateVerdict(env, bytes, castList);
      if (gate.reason && gate.mode === "hard") {
        events.push({ attempt, outcome: "cast_reject", cost: cur.cost });
        await logGenAttempt(env, slug, "line", meta?.chapter ?? null, meta?.page ?? null, attempt, { outcome: "cast_reject", reason: gate.reason, scores: qd.scores, cost: cur.cost }, bytes);
        noteReject(bytes, [gate.reason], 1);
        console.log(`cast gate rejected image (attempt ${attempt} of ${MAX_ROLLS}): ${gate.reason}`);
        continue;
      }
      if (gate.reason) {
        events.push({ attempt: 0, outcome: "cast_flag", cost: null });
        console.log(`cast gate flag (mode ${gate.mode}): ${gate.reason}`);
      }
      events.push({ attempt, outcome: autofixed ? "autofixed" : "accepted", cost: cur.cost });
      await logGenAttempt(env, slug, "line", meta?.chapter ?? null, meta?.page ?? null, attempt, { outcome: autofixed ? "autofixed" : "accepted", reason: gate.reason ? `cast flag (${gate.mode}): ${gate.reason}` : null, scores: qd.scores, cost: cur.cost }, bytes);
      await logGenEvents(env, slug, "line", meta?.chapter ?? null, meta?.page ?? null, events);
      return bytes;
    }
    events.push({ attempt, outcome: "qc_reject", cost: cur.cost });
    await logGenAttempt(env, slug, "line", meta?.chapter ?? null, meta?.page ?? null, attempt, { outcome: "qc_reject", reason: qd.reason, scores: qd.scores, cost: cur.cost }, bytes);
    noteReject(bytes, [qd.reason ?? "quality control rejected the page"], (qd.reason ?? "").split(/[;|]/).filter((s) => s.trim()).length || 5);
    console.log(`QC rejected image (attempt ${attempt} of ${MAX_ROLLS})`);
  }
  // ---- QC edit pass: one correction attempt on the best reject ----
  // (see editFixLines above). Same caps, same gates, same archive.
  if (bestReject) {
    const editAttempt = MAX_ROLLS + 1;
    const cap = await spendCapHit(env, slug);
    const bcap = cap === null ? await budgetGate(env, slug) : null;
    if (cap !== null || bcap !== null) {
      events.push({ attempt: editAttempt, outcome: "spend_capped", cost: null });
      console.log("edit pass skipped: spend cap or book budget reached");
    } else {
      try {
        const fixes = editFixLines(bestReject.reasons);
        const editPrompt =
          "Edit the first reference image, a children's book page that failed quality control. " +
          "Keep the scene, the composition, and the characters the same except for the fixes below.\n" +
          `What failed quality control: ${editFindings(bestReject.reasons)}.\n` +
          (fixes.length ? `Fix exactly these problems: ${fixes.join(" ")}\n` : "") +
          `The scene to preserve, in full: ${prompt}\n` +
          "The other reference images are the characters' model sheets: match them. " +
          "Black and white line art, clean bold outlines, one single scene, no text, no color.";
        const cur = await generateImageMetered(env, editPrompt, [bestReject.bytes, ...sheets.slice(0, 3)]);
        let bytes = cur.bytes;
        const a = analyzePage(bytes);
        let failReason: string | null = null;
        let failScores: any = null;
        if (a.decoded && Math.abs(a.width / a.height - 0.75) > 0.06) {
          failReason = `edit pass: aspect ${a.width}x${a.height} is not 3:4`;
        } else {
          const v = pageVerdict(a);
          if (v.verdict === "reject") {
            failReason = `edit pass: purity: ${v.reasons.join("; ")}`;
          } else {
            if (v.verdict === "autofix") {
              const fixed = purifyPage(bytes);
              if (fixed && pageVerdict(analyzePage(fixed)).verdict === "clean") bytes = fixed;
              else failReason = `edit pass: purity autofix failed: ${v.reasons.join("; ")}`;
            }
            if (!failReason) {
              const qd = await qcImageDetailed(env.AI, bytes, sheet, castText, castList);
              if (!qd.pass) {
                failReason = qd.reason;
                failScores = qd.scores;
              } else {
                const gate = await castGateVerdict(env, bytes, castList);
                if (gate.reason && gate.mode === "hard") {
                  failReason = gate.reason;
                  failScores = qd.scores;
                } else {
                  events.push({ attempt: editAttempt, outcome: "accepted_edit", cost: cur.cost });
                  await logGenAttempt(env, slug, "line", meta?.chapter ?? null, meta?.page ?? null, editAttempt, { outcome: "accepted_edit", reason: `edit pass on the best reject (${editFindings(bestReject.reasons)})${gate.reason ? `; cast flag (${gate.mode}): ${gate.reason}` : ""}`, scores: qd.scores, cost: cur.cost }, bytes);
                  await logGenEvents(env, slug, "line", meta?.chapter ?? null, meta?.page ?? null, events);
                  console.log("edit pass accepted: page fixed from its best reject");
                  return bytes;
                }
              }
            }
          }
        }
        events.push({ attempt: editAttempt, outcome: "edit_reject", cost: cur.cost });
        await logGenAttempt(env, slug, "line", meta?.chapter ?? null, meta?.page ?? null, editAttempt, { outcome: "edit_reject", reason: failReason ?? "edit pass failed a gate", scores: failScores, cost: cur.cost }, bytes);
        console.log(`edit pass rejected: ${failReason}`);
      } catch (e: any) {
        events.push({ attempt: editAttempt, outcome: "edit_error", cost: null });
        console.log(`edit pass errored: ${e?.message ?? e}`);
      }
    }
  }
  events.push({ attempt: MAX_ROLLS, outcome: "held_for_review", cost: null });
  await logGenEvents(env, slug, "line", meta?.chapter ?? null, meta?.page ?? null, events);
  console.log("all attempts failed a gate; page held for review, NOT shipped");
  return null;
}

// Color art with QC (back covers): same 3-attempt discipline, color QC.
// No-ship rule applies here too: all attempts failing returns null.
export async function genColorImageWithQC(
  env: BookBuildEnv,
  slug: string,
  prompt: string
): Promise<Uint8Array | null> {
  const events: GenEvent[] = [];
  for (let attempt = 1; attempt <= MAX_ROLLS; attempt++) {
    const cap = await spendCapHit(env, slug);
    if (cap !== null) {
      events.push({ attempt, outcome: "spend_capped", cost: null });
      await logGenAttempt(env, slug, "color", null, null, attempt, { outcome: "spend_capped", reason: `spend cap $${cap} reached before this roll` });
      await logGenEvents(env, slug, "color", null, null, events);
      console.log(`spend cap ($${cap}) reached for ${slug}; color art held`);
      return null;
    }
    const bcap = await budgetGate(env, slug);
    if (bcap !== null) {
      events.push({ attempt, outcome: "spend_capped", cost: null });
      await logGenAttempt(env, slug, "color", null, null, attempt, { outcome: "budget_capped", reason: `book budget $${bcap} reached before this roll (cross-run budget)` });
      await logGenEvents(env, slug, "color", null, null, events);
      console.log(`book budget ($${bcap}) reached for ${slug}; color art held`);
      return null;
    }
    const cur = await generateColorImageMetered(env, prompt, null);
    const bytes = cur.bytes;
    const qd = await qcColorImageDetailed(env.AI, bytes);
    if (qd.pass) {
      events.push({ attempt, outcome: "accepted", cost: cur.cost });
      await logGenAttempt(env, slug, "color", null, null, attempt, { outcome: "accepted", scores: qd.scores, cost: cur.cost }, bytes);
      await logGenEvents(env, slug, "color", null, null, events);
      return bytes;
    }
    events.push({ attempt, outcome: "qc_reject", cost: cur.cost });
    await logGenAttempt(env, slug, "color", null, null, attempt, { outcome: "qc_reject", reason: qd.reason, scores: qd.scores, cost: cur.cost }, bytes);
    console.log(`color QC rejected image (attempt ${attempt} of ${MAX_ROLLS})`);
  }
  events.push({ attempt: MAX_ROLLS, outcome: "held_for_review", cost: null });
  await logGenEvents(env, slug, "color", null, null, events);
  console.log("color QC rejected all ${MAX_ROLLS} attempts; held for review, NOT shipped");
  return null;
}

// Color picture page via the Vercel AI Gateway (Nano Banana), with the
// approved character sheets as references and color + drift QC. Returns
// null when the gateway is not configured or unreachable, so the
// line-art book still ships exactly as it did before the gateway
// existed. A later build or regen fills the color twin in (head check).
export async function genPictureColorWithQC(
  env: BookBuildEnv,
  slug: string,
  rawPrompt: string,
  characterField?: string,
  sceneText?: string,
  aspect?: string,
  meta?: { chapter?: string; page?: number }
): Promise<Uint8Array | null> {
  const kind = aspect === "1:1" ? "cover" : "color";
  if (!gatewayConfigured(env)) {
    await logGenAttempt(env, slug, kind, meta?.chapter ?? null, meta?.page ?? null, 0, { outcome: "gateway_unavailable", reason: "gateway not configured; color twin skipped with no record before 2026-11-01" });
    return null;
  }
  // Cast first (names or embedded visuals, never the story text), so
  // the reference set carries every drawn character's sheet, not just
  // the character field's one name (Mira colorize census, 2026-11-01).
  let castText: string | null = null;
  let castList: any[] | null = null;
  let castField = characterField;
  try {
    const bible: any = await r2GetJson(env.BOOKS, `books/${slug}/bible.json`);
    const named = castForPage(bible, characterField, rawPrompt);
    castText = castTextOf(named);
    castList = castListOf(named);
    if (named.length) castField = named.map((c: any) => String(c.name)).join(", ");
  } catch {
    // bible unreadable: QC falls back to the sheet comparison alone
  }
  // Pose crops substitute for sheets per character when the book has
  // them (Phase 2); no manifest means the exact old sheet behavior.
  const pageRefs = await loadPageRefs(env, slug, castField, "color", undefined, rawPrompt);
  const sheets = pageRefs.refs;
  const prompt = colorPagePrompt(rawPrompt, sheets.length > 0);
  const events: GenEvent[] = [];
  if (pageRefs.cropUsed.length) events.push({ attempt: 0, outcome: "crop_used", cost: null });
  if (pageRefs.cropMissed.length) events.push({ attempt: 0, outcome: "crop_miss", cost: null });
  let bytes: Uint8Array | null = null;
  for (let attempt = 1; attempt <= MAX_ROLLS; attempt++) {
    const cap = await spendCapHit(env, slug);
    if (cap !== null) {
      events.push({ attempt, outcome: "spend_capped", cost: null });
      await logGenAttempt(env, slug, kind, meta?.chapter ?? null, meta?.page ?? null, attempt, { outcome: "spend_capped", reason: `spend cap $${cap} reached before this roll` });
      await logGenEvents(env, slug, kind, meta?.chapter ?? null, meta?.page ?? null, events);
      console.log(`spend cap ($${cap}) reached for ${slug}; color page held`);
      return null;
    }
    const bcap = await budgetGate(env, slug);
    if (bcap !== null) {
      events.push({ attempt, outcome: "spend_capped", cost: null });
      await logGenAttempt(env, slug, kind, meta?.chapter ?? null, meta?.page ?? null, attempt, { outcome: "budget_capped", reason: `book budget $${bcap} reached before this roll (cross-run budget)` });
      await logGenEvents(env, slug, kind, meta?.chapter ?? null, meta?.page ?? null, events);
      console.log(`book budget ($${bcap}) reached for ${slug}; color page held`);
      return null;
    }
    let cost: number | null = null;
    try {
      const out = await generateGatewayImageMetered(env, prompt, sheets, aspect);
      bytes = out.bytes;
      cost = out.cost;
    } catch (e: any) {
      events.push({ attempt, outcome: "gateway_error", cost: null });
      await logGenEvents(env, slug, kind, meta?.chapter ?? null, meta?.page ?? null, events);
      console.log(`gateway image failed (attempt ${attempt} of ${MAX_ROLLS}): ${e?.message ?? e}; skipping color for this page`);
      return null;
    }
    const qd = await qcColorImageDetailed(env.AI, bytes, pageRefs.sheet, castText, castList);
    if (qd.pass) {
      // Cast-listing gate, same contract as the line path.
      const gate = await castGateVerdict(env, bytes, castList);
      if (gate.reason && gate.mode === "hard") {
        events.push({ attempt, outcome: "cast_reject", cost });
        await logGenAttempt(env, slug, kind, meta?.chapter ?? null, meta?.page ?? null, attempt, { outcome: "cast_reject", reason: gate.reason, scores: qd.scores, cost }, bytes);
        console.log(`cast gate rejected color image (attempt ${attempt} of ${MAX_ROLLS}): ${gate.reason}`);
        continue;
      }
      if (gate.reason) {
        events.push({ attempt: 0, outcome: "cast_flag", cost: null });
        console.log(`cast gate flag (mode ${gate.mode}): ${gate.reason}`);
      }
      events.push({ attempt, outcome: "accepted", cost });
      await logGenAttempt(env, slug, kind, meta?.chapter ?? null, meta?.page ?? null, attempt, { outcome: "accepted", reason: gate.reason ? `cast flag (${gate.mode}): ${gate.reason}` : null, scores: qd.scores, cost }, bytes);
      await logGenEvents(env, slug, kind, meta?.chapter ?? null, meta?.page ?? null, events);
      return bytes;
    }
    events.push({ attempt, outcome: "qc_reject", cost });
    await logGenAttempt(env, slug, kind, meta?.chapter ?? null, meta?.page ?? null, attempt, { outcome: "qc_reject", reason: qd.reason, scores: qd.scores, cost }, bytes);
    console.log(`color QC rejected image (attempt ${attempt} of ${MAX_ROLLS})`);
  }
  events.push({ attempt: MAX_ROLLS, outcome: "held_for_review", cost: null });
  await logGenEvents(env, slug, kind, meta?.chapter ?? null, meta?.page ?? null, events);
  console.log("color QC rejected all ${MAX_ROLLS} attempts; held for review, NOT shipped");
  return null;
}

/** Character names other books already own; the bible gate's set. */
async function takenNameSet(env: BookBuildEnv, slug: string): Promise<Set<string>> {
  const rows: any = await env.DB.prepare(
    "SELECT name FROM characters WHERE book_slug != ?"
  ).bind(slug).all();
  return new Set<string>(
    ((rows?.results ?? []) as any[]).map((r) => String(r.name).toLowerCase())
  );
}

async function loadLibrary(env: BookBuildEnv): Promise<any[]> {
  try {
    const keys = await r2ListAll(env.BOOKS, "library/characters/");
    const lib: any[] = [];
    for (const k of keys.filter((x) => x.endsWith(".json"))) {
      const c = await r2GetJson(env.BOOKS, k);
      if (c?.name) {
        lib.push({ name: c.name, species: c.species ?? "", visual: c.visual ?? "", personality: c.personality ?? [] });
      }
    }
    return lib;
  } catch (e: any) {
    console.log(`loadLibrary failed: ${e?.message ?? e}; continuing with empty library`);
    return [];
  }
}

// ---------------------------------------------------------------- the workflow

export class BookBuildWorkflow extends WorkflowEntrypoint<BookBuildEnv, BookBuildParams> {
  async run(event: WorkflowEvent<BookBuildParams>, step: WorkflowStep) {
    await recordWorkflowRun(this.env, step, event, "bookbuild", event.payload.slug);
    const slug = event.payload.slug;
    if (!slug) throw new Error(`refusing to build slug '${slug}'`);
    try {
      return await this.build(slug, step);
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 500);
      console.log(`BookBuildWorkflow failed for ${slug}: ${msg}`);
      try {
        await this.env.DB.prepare(
          "UPDATE books SET status='failed', stage_detail=?, updated_at=? WHERE slug=?"
        )
          .bind(msg, Math.floor(Date.now() / 1000), slug)
          .run();
      } catch {}
      throw e;
    }
  }

  private async build(slug: string, step: WorkflowStep) {
    const env = this.env;

    // ---- 0. version snapshot ----------------------------------------
    // Archive the book's current artifacts before any stage can
    // overwrite them. No-op on a first build (nothing exists yet) and
    // on idempotent resumes (fingerprint unchanged).
    await step.do(
      "version snapshot",
      { retries: { limit: 1, delay: "30 seconds", backoff: "constant" }, timeout: "10 minutes" } as const,
      async () => await snapshotIfChanged(env.BOOKS, slug, "bookbuild")
    );

    // ---- 0b. run budget + pilot precheck ------------------------------
    // Stamp the run start (the spend cap measures from here) and note
    // whether chapter 1 art already exists: the pilot gate below only
    // arms for a genuinely new book, never for a resume.
    const pilotPre: any = await step.do("begin run", RETRIES, async () => {
      await beginRun(env, slug);
      return { s1Existed: !!(await env.BOOKS.head(`books/${slug}/images/S1-page-0.jpg`)) };
    });

    // ---- 1. extract -------------------------------------------------
    const sourceText: string = await step.do("extract", RETRIES, async () => {
      await setStage(env, slug, "extract", "");
      const existing = await r2GetText(env.BOOKS, `books/${slug}/source.txt`);
      if (existing && existing.length > 0) return existing;
      const keys = (await r2ListAll(env.BOOKS, `uploads/${slug}/`))
        .filter((k) => !k.endsWith("/"))
        .sort();
      if (!keys.length) throw new Error(`no source documents in R2 uploads/${slug}/`);
      const texts: string[] = [];
      for (const key of keys) {
        const ext = (key.split(".").pop() ?? "").toLowerCase();
        const buf = await r2GetBytes(env.BOOKS, key);
        if (!buf) continue;
        if (ext === "txt" || ext === "md" || ext === "markdown") {
          texts.push(new TextDecoder().decode(buf));
        } else if (ext === "pdf") {
          const { text } = await unpdfExtractText(buf.buffer as ArrayBuffer);
          texts.push(Array.isArray(text) ? (text as string[]).join("\n\n") : String(text ?? ""));
        } else {
          console.log(`extract: skipping ${key} (unsupported .${ext})`);
        }
      }
      const combined = texts.map((t) => t.trim()).filter(Boolean).join("\n\n\n");
      if (!combined) throw new Error("no text extracted from source documents");
      await r2Put(env.BOOKS, `books/${slug}/source.txt`, combined, "text/plain");
      return combined;
    });

    // ---- 2. split ---------------------------------------------------
    const splits: { title: string; body: string }[] = await step.do("split", RETRIES, async () => {
      await setStage(env, slug, "split", "");
      const existing = await r2GetText(env.BOOKS, `books/${slug}/split/S1.md`);
      if (existing) {
        const keys = (await r2ListAll(env.BOOKS, `books/${slug}/split/`))
          .filter((k) => /\/split\/S\d+\.md$/.test(k))
          .sort();
        const out: { title: string; body: string }[] = [];
        for (const k of keys) {
          const t = (await r2GetText(env.BOOKS, k)) ?? "";
          const nl = t.indexOf("\n");
          out.push({ title: t.slice(0, nl).replace(/^#+\s*/, "").trim(), body: t.slice(nl + 1).trim() });
        }
        if (out.length) return out;
      }
      // No markdown headings (typical for PDF/Word exports): ask Clairic
      // for the chapter headings with offsets and split on them. Any doubt
      // or failure falls back to the regex/paragraph splitter.
      let chunks: { title: string; body: string }[] | null = null;
      if (!/^#{1,3}\s+.+$/m.test(sourceText) && sourceText.length <= 400_000) {
        const heads = await clairicHeadings(env.AI, sourceText);
        if (heads) {
          chunks = splitOnHeadings(sourceText, heads);
          if (chunks) console.log(`split: clairic found ${chunks.length} chapters`);
        }
      }
      if (!chunks) chunks = splitChapters(sourceText);
      for (let i = 0; i < chunks.length; i++) {
        await r2Put(env.BOOKS, `books/${slug}/split/S${i + 1}.md`, `# ${chunks[i].title}\n\n${chunks[i].body}`, "text/markdown");
      }
      return chunks;
    });

    // ---- 3. bookinfo ------------------------------------------------
    const bookInfo: any = await step.do("bookinfo", RETRIES, async () => {
      await setStage(env, slug, "bookinfo", "");
      const existing = await r2GetJson(env.BOOKS, `books/${slug}/book_info.json`);
      if (existing?.chapters?.length) return existing;
      const row: any = await env.DB.prepare("SELECT title, description FROM books WHERE slug=?").bind(slug).first();
      let title = row?.title ?? "";
      if (!title || title === slug) {
        // No real title on file: extract one from the document itself.
        const answers = await clairicExtract(env.AI, splits.map((s) => s.body).join("\n\n").slice(0, 20_000), {
          book_title: { type: "text", instructions: "The title of this book or document" },
        });
        const t = answers?.book_title;
        title = t?.value && (t.confidence ?? 0) >= 0.5 ? String(t.value) : slug.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
      }
      const subject = row?.description ?? "";
      const chapters = splits.map((s) => {
        const sents = s.body.split(/(?<=[.!?])\s+/);
        return { title: s.title, summary: sents.slice(0, 2).join(" ").slice(0, 400) };
      });
      const info = {
        title,
        subject: subject || `A children's storybook about ${title}`,
        cover_description: `Colorful cover for '${title}', kid-friendly`,
        chapters,
      };
      await r2Put(env.BOOKS, `books/${slug}/book_info.json`, JSON.stringify(info, null, 1), "application/json");
      return info;
    });

    // ---- 3b. source dedup guard --------------------------------------
    // One source book, one adaptation, ever (CG, 2026-10-28). The
    // source title is always known by now (pre-uploaded book_info, the
    // D1 row, or extracted from the document itself), and no model
    // money has been spent beyond extraction. A duplicate parks the
    // book as failed with the refusal in stage_detail and ends the run
    // here, before the bible step. The book's own slug is excluded: a
    // rebuild of the same book always matches itself and is allowed.
    const sourceVerdict: any = await step.do("source guard", RETRIES, async () => {
      const candidates = [bookInfo?.sourceTitle, bookInfo?.title]
        .filter((x: any) => typeof x === "string" && x.trim());
      for (const c of candidates as string[]) {
        const m = await checkSourceDuplicate(env, c, { excludeSlug: slug });
        if (m.duplicate) return { blocked: true, message: duplicateMessage(c, m) };
      }
      // Passed: stamp the canonical source identity onto book_info so
      // future registry harvests are exact (the books table has no
      // source column; book_info carries the stamp).
      const checkedTitle = bookInfo?.sourceTitle ?? bookInfo?.title ?? "";
      const id = parseSourceIdentity(checkedTitle);
      if (id && (bookInfo.sourceKey !== id.key || bookInfo.sourceTitleChecked !== checkedTitle)) {
        await r2Put(
          env.BOOKS,
          `books/${slug}/book_info.json`,
          JSON.stringify({ ...bookInfo, sourceKey: id.key, sourceTitleChecked: checkedTitle }, null, 1),
          "application/json"
        );
        console.log(`source guard: stamped source key '${id.key}' for ${slug}`);
      }
      return { blocked: false };
    });
    if (sourceVerdict?.blocked) {
      console.log(`source guard: REFUSED build for '${slug}': ${sourceVerdict.message}`);
      try {
        await env.DB.prepare(
          "UPDATE books SET status='failed', stage='duplicate_source', stage_detail=?, updated_at=? WHERE slug=?"
        )
          .bind(String(sourceVerdict.message).slice(0, 500), Math.floor(Date.now() / 1000), slug)
          .run();
      } catch (e: any) {
        console.log(`source guard: could not record refusal for ${slug}: ${e?.message ?? e}`);
      }
      return { slug, blocked: "duplicate_source", message: sourceVerdict.message };
    }

    // ---- 4. bible ---------------------------------------------------
    const rawBible: any = await step.do("bible", RETRIES, async () => {
      await setStage(env, slug, "bible", "");
      const existing = await r2GetJson(env.BOOKS, `books/${slug}/bible.json`);
      if (existing?.conceptLadder?.length) return existing;
      // A bible attached in the bookstore (admin Bibles page) wins over
      // generating one: it carries an approved framing for the book.
      try {
        const row: any = await env.DB.prepare(
          "SELECT data FROM bibles WHERE book_slug = ? ORDER BY created_at DESC LIMIT 1"
        ).bind(slug).first();
        if (row?.data) {
          const attached = JSON.parse(String(row.data));
          if (attached?.conceptLadder?.length) {
            attached._bible_source = "bookstore";
            await r2Put(env.BOOKS, `books/${slug}/bible.json`, JSON.stringify(attached, null, 1), "application/json");
            return attached;
          }
        }
      } catch { /* no attached bible: generate below */ }
      const library = await loadLibrary(env);
      const taken = await takenNameSet(env, slug);
      const prompt = buildBiblePrompt(bookInfo, library, [...taken]);
      // 32768, not 8192: the schema's tail sections (worldInventory,
      // vocab) sit late in the output and came back starved and
      // under-filled at 8192 on all three 2026-11-06 hero builds.
      const { data, model } = await callModel(env, prompt, 32768, "writer", { slug, purpose: "bible" });
      if (!data.conceptLadder?.length) throw new Error("bible response has no conceptLadder");
      data._bible_model = model;
      await r2Put(env.BOOKS, `books/${slug}/bible.json`, JSON.stringify(data, null, 1), "application/json");
      return data;
    });
    // ---- 4b. bible normalize + gate -----------------------------------
    // Fold generated-shape bibles into the canonical shape and persist
    // the result, so the planner, sheet loader and matter composer all
    // read characters[] and inline metaphors. Then structural
    // validation before a single token of planning spend: complete
    // ladder, exact S1..Sn chapters, one metaphor per chapter, a real
    // failure case where the bible carries them, and no character name
    // another book already owns (names never repeat across stories).
    const bible: any = await step.do("bible gate", RETRIES, async () => {
      const taken = await takenNameSet(env, slug);
      let current = normalizeBible(rawBible);
      if (JSON.stringify(current) !== JSON.stringify(rawBible)) {
        await r2Put(env.BOOKS, `books/${slug}/bible.json`, JSON.stringify(current, null, 1), "application/json");
        console.log(`bible normalized for ${slug} (cast + metaphors folded into canonical shape)`);
      }
      let reasons = validateBible(current, taken);
      // Gate-feedback repair (2026-11-06): a bible that fails on
      // fixable shortfalls gets the gate's own reasons back for up
      // to two revision passes instead of killing the build on the
      // first draft. All three hero builds died at this gate on
      // under-filled world inventories, unmapped forbidden terms,
      // and library names cast as new characters, because the
      // writer never saw the verdict it was judged by.
      for (let attempt = 1; attempt <= 2 && reasons.length; attempt++) {
        console.log(`bible gate repair ${attempt} for ${slug}: ${reasons.join("; ").slice(0, 300)}`);
        const { data } = await callModel(env, buildBibleRepairPrompt(current, reasons, [...taken]), 32768, "writer", { slug, purpose: "bible-repair" });
        if (!data?.conceptLadder?.length) break;
        current = normalizeBible(data);
        await r2Put(env.BOOKS, `books/${slug}/bible.json`, JSON.stringify(current, null, 1), "application/json");
        reasons = validateBible(current, taken);
      }
      if (reasons.length) {
        throw new Error(`bible gate failed: ${reasons.join("; ").slice(0, 400)}`);
      }
      await setStage(env, slug, "bible", "gate passed");
      return current;
    });
    const ladder: any[] = bible.conceptLadder;
    const n = ladder.length;

    // ---- 5. plan ----------------------------------------------------
    // One workflow step per ATTEMPT, mirroring the regen pipeline: a
    // chapter that needs several planner calls can never blow the step
    // timeout (the all-attempts-in-one-step version died at 600s on
    // Fern S2, 2026-10-23). Rejected drafts persist to rejected/ so
    // critic failures stay visible.
    const PLAN_STEP = { retries: { limit: 1, delay: "10 seconds", backoff: "constant" }, timeout: "8 minutes" } as const;
    const prevPlans: any[] = [];
    for (let i = 1; i <= n; i++) {
      const ch = `S${i}`;
      await setStage(env, slug, "plan", `${ch}/${n}`);
      const existing: any = await step.do(`plan ${ch} head`, RETRIES, async () => {
        const ex = await r2GetJson(env.BOOKS, `books/${slug}/plans/${ch}.json`);
        return ex?.pages?.length ? ex : null;
      });
      if (existing) { prevPlans.push(existing); continue; }
      let notes = "";
      let plan: any = null;
      for (let a = 1; a <= 5; a++) {
        const prev = prevPlans[prevPlans.length - 1];
        let r: any;
        try {
          r = await step.do(`plan ${ch} a${a}`, PLAN_STEP, async () => {
            const att = await planChapterAttempt(env, bible, ch, prev?.newStorySoFar ?? "", prev?.hook ?? "", notes, prevPlans, slug);
            if (!att.passed) {
              // Persist the critic's notes WITH the rejected draft:
              // a rejection nobody can read later is a dead end (the
              // Fern S5 loop, 2026-10-23, was only diagnosable from
              // the final error message).
              await r2Put(env.BOOKS, `books/${slug}/rejected/${ch}-a${a}.json`, JSON.stringify({ ...att.plan, _critic: { attempt: a, model: att.model, notes: att.notes } }, null, 1), "application/json");
              return { done: false, notes: att.notes };
            }
            att.plan.storyChapter = ch;
            att.plan._v3_attempts = a;
            att.plan._model = att.model;
            await r2Put(env.BOOKS, `books/${slug}/plans/${ch}.json`, JSON.stringify(att.plan, null, 1), "application/json");
            return { done: true, plan: att.plan };
          });
        } catch (e: any) {
          r = { done: false, notes: `planner step error: ${e?.message ?? e}` };
        }
        if (r.done) { plan = r.plan; break; }
        notes = r.notes ?? "";
        if (a === 5) throw new Error(`chapter ${ch} failed planning after 5 attempts: ${String(notes).slice(0, 200)}`);
      }
      prevPlans.push(plan);
    }

    // ---- 5b. whole-book read pass gate --------------------------------
    // After ALL chapters are planned and BEFORE any art spend: the head
    // of the writer chain reads the whole book at once (bible, ladder,
    // every chapter's real text). The report lands at
    // books/{slug}/readpass.json. A "revise" verdict parks the book at
    // needs_review with zero art spend, the same review convention the
    // held-pages path uses at assembly. ship / ship_with_warnings flow
    // through (warnings are stored in the report, never blocking). If
    // the pass itself errors (gateway down), the build continues and
    // the failure is logged loudly: an infra outage must not strand a
    // fully planned book, and the pass can be re-run per book via
    // POST /book/{slug}/readpass.
    {
      const readReport: any = await step.do(
        "read pass",
        { retries: { limit: 1, delay: "20 seconds", backoff: "constant" }, timeout: "10 minutes" },
        async () => {
          await setStage(env, slug, "readpass", "");
          try {
            return await runReadPass(env as any, slug, bible, prevPlans);
          } catch (e: any) {
            console.log(
              `READ PASS UNAVAILABLE for ${slug} (${e?.message ?? e}); continuing to art without the gate. Re-run POST /book/${slug}/readpass once the gateway is back.`
            );
            return null;
          }
        }
      );
      if (readReport && readReport.verdict === "revise") {
        const blocks = (readReport.checks ?? [])
          .filter((c: any) => c.severity === "block" && !c.pass)
          .map((c: any) => `check ${c.id} (${c.key})`)
          .join(", ");
        await setStage(
          env,
          slug,
          "needs_review",
          `read pass verdict: revise (${blocks}); full report at books/${slug}/readpass.json`
        );
        return { slug, readpass: readReport };
      }
    }

    // ---- 5c. crops gate ----------------------------------------------
    // Opt-in pose-crop coverage (Phase 2): a book with NO crops.json
    // is never gated (legacy sheet path). A book WITH a manifest has
    // opted in, and every bible character needs >= 1 pose tag before
    // art proceeds; otherwise the book parks at needs_review naming
    // the untagged characters, same review convention as the read pass.
    {
      const cov: any = await step.do("crops gate", RETRIES, async () => {
        return cropsCoverage(env, slug, bible);
      });
      if (cov?.hasManifest && Array.isArray(cov.untagged) && cov.untagged.length) {
        await setStage(
          env,
          slug,
          "needs_review",
          `crops gate: no pose tags yet for ${cov.untagged.join(", ")}; tag every character in Crop Mode before art proceeds`
        );
        return { slug, cropsGate: cov.untagged };
      }
    }

    // ---- 6. images --------------------------------------------------
    // One step per page image, mirroring regen: a chapter's five images
    // in a single step carries the same timeout risk as batched planning.
    for (let i = 1; i <= n; i++) {
      const ch = `S${i}`;
      await setStage(env, slug, "images", `${ch}/${n}`);
      const planHead: any = await step.do(`images ${ch} head`, RETRIES, async () => {
        const plan = await r2GetJson(env.BOOKS, `books/${slug}/plans/${ch}.json`);
        if (!plan?.pages?.length) throw new Error(`missing plan for ${ch}`);
        return { pages: plan.pages.length, hasFinale: !!plan.finale?.imagePrompt };
      });
      for (let pi = 0; pi < planHead.pages; pi++) {
        await step.do(`images ${ch} p${pi}`, RETRIES, async () => {
          const plan = await r2GetJson(env.BOOKS, `books/${slug}/plans/${ch}.json`);
          const key = `books/${slug}/images/${ch}-page-${pi}.jpg`;
          if (!(await env.BOOKS.head(key))) {
            const scene = plan.pages[pi].scene;
            const promptText = scene?.cast?.length
              ? linePromptFromScene(scene, bible)
              : anchoredPrompt(plan.pages[pi].imagePrompt, plan.pages[pi].character, bible);
            const bytes = await genImageWithQC(env, slug, promptText, plan.pages[pi].character, { chapter: ch, page: pi }, plan.pages[pi].storyText, scene);
            if (!bytes) {
              // Held for review (gates failed or spend cap): flag the
              // plan page; assembly refuses while the flag stands.
              plan.pages[pi].held = true;
              plan.pages[pi].heldReason = "failed gates or spend cap reached; see gen_events";
              await r2Put(env.BOOKS, `books/${slug}/plans/${ch}.json`, JSON.stringify(plan, null, 1), "application/json");
              return;
            }
            await env.BOOKS.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
            stampLine(bible, plan, plan.pages[pi], bytes);
            await r2Put(env.BOOKS, `books/${slug}/plans/${ch}.json`, JSON.stringify(plan, null, 1), "application/json");
            if (plan.pages[pi].held) {
              delete plan.pages[pi].held;
              delete plan.pages[pi].heldReason;
              plan.pages[pi].imageKey = key;
              await r2Put(env.BOOKS, `books/${slug}/plans/${ch}.json`, JSON.stringify(plan, null, 1), "application/json");
              return;
            }
          }
          if (plan.pages[pi].imageKey !== key) {
            plan.pages[pi].imageKey = key;
            await r2Put(env.BOOKS, `books/${slug}/plans/${ch}.json`, JSON.stringify(plan, null, 1), "application/json");
          }
        });
        // No color twins in a base build (factory reset, 2026-10-24):
        // the base book is line art only. Color arrives later through
        // the Colorize process, which colors these exact line pages.
      }
      if (planHead.hasFinale) {
        await step.do(`images ${ch} finale`, RETRIES, async () => {
          const plan = await r2GetJson(env.BOOKS, `books/${slug}/plans/${ch}.json`);
          const fkey = `books/${slug}/images/${ch}-finale.jpg`;
          if (!(await env.BOOKS.head(fkey))) {
            // Finales are group scenes: no single character sheet (forcing
            // one produced character_match ~0.03 failures in the v3 regen).
            const fscene = plan.finale.scene;
            const fprompt = fscene?.cast?.length ? linePromptFromScene(fscene, bible) : plan.finale.imagePrompt;
            const bytes = await genImageWithQC(env, slug, fprompt, undefined, { chapter: ch, page: -1 }, plan.finale.storyText, fscene);
            if (!bytes) {
              (plan.finale as any).held = true;
              (plan.finale as any).heldReason = "failed gates or spend cap reached; see gen_events";
              await r2Put(env.BOOKS, `books/${slug}/plans/${ch}.json`, JSON.stringify(plan, null, 1), "application/json");
              return;
            }
            await env.BOOKS.put(fkey, bytes, { httpMetadata: { contentType: "image/jpeg" } });
            stampLine(bible, plan, plan.finale, bytes);
            await r2Put(env.BOOKS, `books/${slug}/plans/${ch}.json`, JSON.stringify(plan, null, 1), "application/json");
            if ((plan.finale as any).held) {
              delete (plan.finale as any).held;
              delete (plan.finale as any).heldReason;
              (plan.finale as any).imageKey = fkey;
              await r2Put(env.BOOKS, `books/${slug}/plans/${ch}.json`, JSON.stringify(plan, null, 1), "application/json");
              return;
            }
          }
          if ((plan.finale as any).imageKey !== fkey) {
            (plan.finale as any).imageKey = fkey;
            await r2Put(env.BOOKS, `books/${slug}/plans/${ch}.json`, JSON.stringify(plan, null, 1), "application/json");
          }
        });
      }
      // ---- pilot gate -------------------------------------------------
      // Sample-first, made structural (CG's spend rule, and the
      // 2026-10-26 review): a NEW book pauses after chapter 1 until the
      // owner approves the pilot art in the admin. Resumes (chapter 1
      // art already existed when the run began) never gate.
      if (i === 1 && n > 1 && !pilotPre.s1Existed) {
        await step.do("pilot gate arm", RETRIES, async () => {
          try {
            await ensureRunCols(env);
            await env.DB.prepare("UPDATE books SET pilot_approved=0 WHERE slug=?").bind(slug).run();
          } catch { /* best effort */ }
          await setStage(env, slug, "awaiting_pilot_approval", "chapter 1 drawn; approve the pilot in the admin to continue the build");
          return true;
        });
        if (typeof (step as any).sleep === "function") {
          let approved = false;
          for (let k = 0; k < 168 && !approved; k++) {
            await (step as any).sleep(`pilot wait ${k}`, "1 hour");
            approved = await step.do(`pilot check ${k}`, RETRIES, async () => {
              const row: any = await env.DB.prepare("SELECT pilot_approved FROM books WHERE slug=?")
                .bind(slug)
                .first();
              return !!row?.pilot_approved;
            });
          }
          if (!approved) throw new Error("pilot approval timed out after 7 days");
          await setStage(env, slug, "images", "pilot approved");
        } else {
          console.log("pilot gate: step.sleep unavailable on this runtime; continuing without the gate");
        }
      }
    }

    // ---- 6b. cover art ------------------------------------------------
    // A dedicated color cover scene (cast sheets as references, same QC
    // discipline as the color pages). Wally's cover was composed by
    // hand outside the build; every book now gets one here. The file
    // feeds both the PDF's front cover and the storefront's composed
    // cover. No gateway or a QC shutout just means no cover.jpg: the
    // cover falls back to the first page's art, never to nothing.
    await step.do("cover art", RETRIES, async () => {
      if (!gatewayConfigured(env)) return;
      const key = `books/${slug}/cover.jpg`;
      if (await env.BOOKS.head(key)) return;
      const chars = bible.characters ?? [];
      const cast = chars.map((c: any) => c.name).join(", ");
      const hero = chars[0];
      const heroDesc = hero ? `${hero.name} the ${hero.species}` : "the story's hero";
      const prompt =
        `Book cover illustration for a children's picture book: ${heroDesc} in ` +
        `${bible.setting ?? "the story's world"}, a joyful hero scene that sums up ` +
        `the whole adventure, with the other main characters welcome if they fit ` +
        `naturally. Rich warm color, inviting light, the hero large and clear. ` +
        `Compose the scene in the lower two thirds of the frame and keep the top ` +
        `quarter as clear open sky with no characters, trees, or objects, so ` +
        `nothing important ever sits where the title goes.`;
      // Cover art generates at 1:1 (the composed cover's art region is
      // landscape-ish); the old 3:4 portrait pin made every fit wrong.
      const bytes = await genPictureColorWithQC(env, slug, prompt, cast || undefined, undefined, "1:1");
      if (bytes) {
        await env.BOOKS.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
        console.log(`cover art stored for ${slug}`);
      } else {
        console.log(`cover art unavailable for ${slug}; first-page art will carry the cover`);
      }
    });

    // ---- 7. assemble ------------------------------------------------
    const pdfKeys: { pictureKey: string; coloringKey: string; held?: string[] } = await step.do("assemble", RETRIES, async () => {
      await setStage(env, slug, "assemble", "");
      const coloring = await assembleVerifiedPdf(env, slug, 'coloring');
      const picture = await assembleVerifiedPdf(env, slug, 'picture', coloring.revision);
      await recordEdition(env, slug, "line", [
        { key: picture.key, role: "picture_book_pdf" }, { key: coloring.key, role: "coloring_book_pdf" },
        { key: `books/${slug}/cover.jpg`, role: "cover" },
      ]);
      return { pictureKey: picture.key, coloringKey: coloring.key, titledCover: picture.titledCover };
    });
    if ((pdfKeys as any).held?.length) {
      return { slug, held: (pdfKeys as any).held };
    }

    // ---- 8. register ------------------------------------------------
    await step.do("register", RETRIES, async () => {
      await setStage(env, slug, "register", "");
      await rebuildEditorChapters(env, slug);
      const title = bible.bookTitle ?? slug;
      const now = Math.floor(Date.now() / 1000);
      // The cover art when the cover stage produced one; the composed
      // titled cover replaces this key as soon as the compositor runs.
      // The bare first page is only the last resort.
      const coverKey = (await env.BOOKS.head(`books/${slug}/cover-titled.jpg`))
        ? `books/${slug}/cover-titled.jpg`
        : (await env.BOOKS.head(`books/${slug}/cover.jpg`))
          ? `books/${slug}/cover.jpg`
          : `books/${slug}/images/S1-page-0.jpg`;
      // Assembly QA for the hub's delivery-readiness panel (see
      // regen.ts): recorded by the composer, best-effort.
      try {
        await env.DB.prepare(
          "INSERT OR REPLACE INTO book_qa (slug, cover_typeset, coloring_captions_truncated, back_cover_truncated, source, measured_at) VALUES (?, ?, 0, 0, 'factory build assembly', ?)"
        )
          .bind(slug, (pdfKeys as any).titledCover ? 0 : 1, now)
          .run();
      } catch { /* book_qa is created by the hub; absence is not a build failure */ }
      const existing: any = await env.DB.prepare("SELECT id FROM books WHERE slug=?").bind(slug).first();
      if (existing) {
        await env.DB.prepare(
          "UPDATE books SET title=?, status='ready_for_qa', stage='done', stage_detail='', picture_book_key=?, coloring_book_key=?, cover_key=?, updated_at=? WHERE slug=?"
        )
          .bind(title, pdfKeys.pictureKey, pdfKeys.coloringKey, coverKey, now, slug)
          .run();
      } else {
        await env.DB.prepare(
          "INSERT INTO books (id, slug, title, status, stage, picture_book_key, coloring_book_key, cover_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
        )
          .bind(crypto.randomUUID(), slug, title, "ready_for_qa", "done", pdfKeys.pictureKey, pdfKeys.coloringKey, coverKey, now, now)
          .run();
      }
    });

    return { slug, pictureKey: pdfKeys.pictureKey, coloringKey: pdfKeys.coloringKey };
  }
}
