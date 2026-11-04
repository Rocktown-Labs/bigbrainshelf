import { assembleVerifiedPdf } from "./assembly";
import { stampColor, holdColor, pageSourceRevision, bytesHash, colorIdentityCurrent } from "../../packages/core/src/assembly-identity";
import { recordWorkflowRun } from "../../packages/core/src/run-provenance";
// ColorizeWorkflow: the factory's color process (reset, 2026-10-24).
//
// Base books are black-and-white line art only. Color is a separate,
// owner-triggered process: this workflow takes a finished book's OWN
// line pages and colorizes those exact drawings (the line page itself
// is the image-edit reference, so the color edition can never drift
// into different art the way the old independently generated color
// twins did). Output: books/{slug}/picture-book-color.pdf plus a
// color_book_key on the book row. The base book is never touched.
import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import { composeMatter, ensureBackCoverImages } from "./matter";
import {
  BookBuildEnv,
  GenEvent,
  logGenEvents,
  logGenAttempt,
  castForPage,
  castTextOf,
  castListOf,
  r2GetJson,
  r2Put,
  r2GetBytes,
  r2ListAll,
  loadPageRefs,
  castGateVerdict,
  beginRun,
  spendCapHit,
  MAX_ROLLS,
  heldPages,
  rebuildEditorChapters,
} from "./bookbuild";
import { gatewayConfigured, generateGatewayImageMetered, colorizeExtra } from "./gateway";
import { budgetGate } from "./budget";
import { emitEvent } from "./events";
import { recordEdition } from "./editions";
import { runVisualPass } from "./visualpass";
import { qcColorImage, qcColorImageDetailed } from "./ai";
import { snapshotIfChanged } from "./versioning";

export interface ColorizeParams {
  slug: string;
  force?: boolean;
}

const RETRIES = { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" } } as const;

async function setStage(env: BookBuildEnv, slug: string, detail = ""): Promise<void> {
  try {
    await env.DB.prepare("UPDATE books SET stage='colorize', stage_detail=?, updated_at=? WHERE slug=?")
      .bind(detail, Math.floor(Date.now() / 1000), slug)
      .run();
    await emitEvent(env, { slug, kind: "stage", stage: "colorize", event: "stage_changed", detail });
  } catch { /* stage reporting is best-effort */ }
}

const COLORIZE_PROMPT =
  "Colorize the first image: a black-and-white line drawing from a children's picture book. " +
  "Keep every line, character, pose, and object exactly where it is. Only add rich, warm " +
  "watercolor color inside the existing lines, matching the character reference sheets " +
  "when they are provided. Do not add, remove, move, or redraw anything. " +
  "No text, no letters, no words, no numbers anywhere in the image.";

export type ColorizeResult =
  | { status: "ok"; bytes: Uint8Array }
  | { status: "held" | "gateway" };

// One page's colorization with the color QC discipline used everywhere
// else in the factory: 3 attempts, Clef color questions (is_color,
// has_text, sheet match, cast species, anatomy, cast integrity). The
// no-ship rule applies: all attempts failing returns "held", never the
// least-bad roll (the old fallback is how multiplied color pages
// shipped). "gateway" = the gateway failed outright. A held page is
// flagged on the plan and blocks assembly of the color edition.
// NOTE (2026-10-27): a dark-mask IoU structure check was calibrated
// for this spot and does not separate good color pages from
// multiplied ones (the artist re-renders; lines drift on every page),
// so multiplication defense stays with the cast-integrity questions
// and the cast-listing judge.
export async function genColorizeWithQC(
  env: BookBuildEnv,
  slug: string,
  lineBytes: Uint8Array,
  characterField?: string,
  sceneText?: string,
  meta?: { chapter?: string; page?: number },
  scene?: any
): Promise<ColorizeResult> {
  if (!gatewayConfigured(env)) {
    await logGenAttempt(env, slug, "colorize", meta?.chapter ?? null, meta?.page ?? null, 0, { outcome: "gateway_unavailable", reason: "gateway not configured" });
    return { status: "gateway" };
  }
  // Cast first (castForPage: scene cast, field/prompt names, or the
  // bible visuals embedded verbatim in legacy prompts), so the
  // reference set carries every drawn character's sheet. The first
  // cut keyed refs and QC off the character field alone, which names
  // ONE character on two-character pages: the colorist painted the
  // co-star as a second lead and Clef failed the page for duplicating
  // her (Mira colorize census, 2026-11-01).
  let castText: string | null = null;
  let castList: any[] | null = null;
  let castField = characterField;
  try {
    const bible: any = await r2GetJson(env.BOOKS, `books/${slug}/bible.json`);
    const named = castForPage(bible, characterField, scene?.imagePrompt ?? "", scene?.cast);
    castText = castTextOf(named);
    castList = castListOf(named);
    if (named.length) castField = named.map((c: any) => String(c.name)).join(", ");
  } catch { /* sheet comparison alone */ }
  // Pose crops substitute for sheets per character when the book has
  // them (Phase 2); the line page itself stays the first reference.
  const pageRefs = await loadPageRefs(env, slug, castField, "color", scene, undefined);
  const sheets = pageRefs.refs;
  const refs = [lineBytes, ...sheets];
  const prompt = COLORIZE_PROMPT + colorizeExtra(scene);
  const events: GenEvent[] = [];
  if (pageRefs.cropUsed.length) events.push({ attempt: 0, outcome: "crop_used", cost: null });
  if (pageRefs.cropMissed.length) events.push({ attempt: 0, outcome: "crop_miss", cost: null });
  for (let attempt = 1; attempt <= MAX_ROLLS; attempt++) {
    const cap = await spendCapHit(env, slug);
    if (cap !== null) {
      events.push({ attempt, outcome: "spend_capped", cost: null });
      await logGenAttempt(env, slug, "colorize", meta?.chapter ?? null, meta?.page ?? null, attempt, { outcome: "spend_capped", reason: `spend cap $${cap} reached before this roll` });
      await logGenEvents(env, slug, "colorize", meta?.chapter ?? null, meta?.page ?? null, events);
      console.log(`spend cap ($${cap}) reached for ${slug}; colorize page held`);
      return { status: "held" };
    }
    const bcap = await budgetGate(env, slug);
    if (bcap !== null) {
      events.push({ attempt, outcome: "spend_capped", cost: null });
      await logGenAttempt(env, slug, "colorize", meta?.chapter ?? null, meta?.page ?? null, attempt, { outcome: "budget_capped", reason: `book budget $${bcap} reached before this roll (cross-run budget)` });
      await logGenEvents(env, slug, "colorize", meta?.chapter ?? null, meta?.page ?? null, events);
      console.log(`book budget ($${bcap}) reached for ${slug}; colorize page held`);
      return { status: "held" };
    }
    let bytes: Uint8Array;
    let cost: number | null = null;
    try {
      const out = await generateGatewayImageMetered(env, prompt, refs);
      bytes = out.bytes;
      cost = out.cost;
    } catch (e: any) {
      events.push({ attempt, outcome: "gateway_error", cost: null });
      await logGenAttempt(env, slug, "colorize", meta?.chapter ?? null, meta?.page ?? null, attempt, { outcome: "gateway_error", reason: String(e?.message ?? e).slice(0, 300) });
      await logGenEvents(env, slug, "colorize", meta?.chapter ?? null, meta?.page ?? null, events);
      console.log(`colorize gateway failed (attempt ${attempt} of ${MAX_ROLLS}): ${e?.message ?? e}`);
      return { status: "gateway" };
    }
    const qd = await qcColorImageDetailed(env.AI, bytes, pageRefs.sheet, castText, castList);
    if (qd.pass) {
      // Cast-listing gate, same contract as the line/color paths.
      const gate = await castGateVerdict(env, bytes, castList);
      if (gate.reason && gate.mode === "hard") {
        events.push({ attempt, outcome: "cast_reject", cost });
        await logGenAttempt(env, slug, "colorize", meta?.chapter ?? null, meta?.page ?? null, attempt, { outcome: "cast_reject", reason: gate.reason, scores: qd.scores, cost }, bytes);
        console.log(`cast gate rejected colorize image (attempt ${attempt} of ${MAX_ROLLS}): ${gate.reason}`);
        continue;
      }
      if (gate.reason) {
        events.push({ attempt: 0, outcome: "cast_flag", cost: null });
        console.log(`cast gate flag (mode ${gate.mode}): ${gate.reason}`);
      }
      events.push({ attempt, outcome: "accepted", cost });
      await logGenAttempt(env, slug, "colorize", meta?.chapter ?? null, meta?.page ?? null, attempt, { outcome: "accepted", reason: gate.reason ? `cast flag (${gate.mode}): ${gate.reason}` : null, scores: qd.scores, cost }, bytes);
      await logGenEvents(env, slug, "colorize", meta?.chapter ?? null, meta?.page ?? null, events);
      return { status: "ok", bytes };
    }
    events.push({ attempt, outcome: "qc_reject", cost });
    await logGenAttempt(env, slug, "colorize", meta?.chapter ?? null, meta?.page ?? null, attempt, { outcome: "qc_reject", reason: qd.reason, scores: qd.scores, cost }, bytes);
    console.log(`colorize QC rejected image (attempt ${attempt} of ${MAX_ROLLS})`);
  }
  events.push({ attempt: MAX_ROLLS, outcome: "held_for_review", cost: null });
  await logGenEvents(env, slug, "colorize", meta?.chapter ?? null, meta?.page ?? null, events);
  console.log(`colorize QC rejected all ${MAX_ROLLS} attempts; page held for review, NOT shipped`);
  return { status: "held" };
}


// Hash-bound provenance, never upload-time ordering.
async function colorIsCurrent(env: BookBuildEnv, bible: any, plan: any, pg: any, ckey: string, lineKey: string): Promise<boolean> {
  if (pg.held || pg.colorHeld || pg.imageColorKey !== ckey) return false;
  const line = await r2GetBytes(env.BOOKS, lineKey);
  const color = await r2GetBytes(env.BOOKS, ckey);
  return !!line && !!color && colorIdentityCurrent(bible, plan, pg, bytesHash(line), bytesHash(color));
}

function chNum(key: string): number {
  const m = key.match(/S(\d+)\.json$/);
  return m ? parseInt(m[1], 10) : 0;
}

export class ColorizeWorkflow extends WorkflowEntrypoint<BookBuildEnv, ColorizeParams> {
  async run(event: WorkflowEvent<ColorizeParams>, step: WorkflowStep) {
    await recordWorkflowRun(this.env, step, event, "colorize", event.payload.slug);
    const env = this.env;
    const slug = event.payload.slug;
    const force = !!event.payload.force;
    if (!slug) throw new Error("colorize requires a slug");
    try {
      await step.do("version snapshot", RETRIES, async () => {
        await snapshotIfChanged(env.BOOKS, slug, "colorize");
        return true;
      });

      await step.do("begin run", RETRIES, async () => {
        await beginRun(env, slug);
        return true;
      });

      const bible: any = await step.do("load bible", RETRIES, async () => {
        const b = await r2GetJson(env.BOOKS, `books/${slug}/bible.json`);
        if (!b) throw new Error(`no bible for ${slug}`);
        return b;
      });

      const chapters: string[] = await step.do("list chapters", RETRIES, async () => {
        const keys = (await r2ListAll(env.BOOKS, `books/${slug}/plans/`))
          .filter((k) => /\/plans\/S\d+\.json$/.test(k))
          .sort((a, b) => chNum(a) - chNum(b));
        if (!keys.length) throw new Error(`no plans for ${slug}`);
        return keys.map((k) => k.match(/\/(S\d+)\.json$/)![1]);
      });

      // Whole-book visual pass BEFORE any paid color roll: defective
      // line art parks the run instead of burning colorize money.
      const vp: any = await step.do("visual pass", RETRIES, async () => {
        const r = await runVisualPass(env, slug);
        return { defects: r.defects.length, checked: r.checked };
      });
      if (vp.defects > 0 && !force) {
        await setStage(env, slug, `visual pass: ${vp.defects} line defects, colorize parked (see visualpass.json)`);
        await emitEvent(env, { slug, kind: "visualpass", event: "colorize_parked", detail: vp });
        return { slug, colorKey: null, colored: 0, skipped: 0, heldCount: 0, visualPassDefects: vp.defects };
      }

      let colored = 0;
      let skipped = 0;
      let heldCount = 0;
      for (const ch of chapters) {
        await setStage(env, slug, `${ch} of ${chapters[chapters.length - 1]}`);
        const head: any = await step.do(`colorize ${ch} head`, RETRIES, async () => {
          const plan = await r2GetJson(env.BOOKS, `books/${slug}/plans/${ch}.json`);
          if (!plan?.pages?.length) throw new Error(`missing plan for ${ch}`);
          return { pages: plan.pages.length, hasFinale: !!plan.finale };
        });
        for (let pi = 0; pi < head.pages; pi++) {
          const did: any = await step.do(`colorize ${ch} p${pi}`, RETRIES, async () => {
            const ckey = `books/${slug}/images-color/${ch}-page-${pi}.jpg`;
            const plan = await r2GetJson(env.BOOKS, `books/${slug}/plans/${ch}.json`);
            const pg = plan.pages[pi];
            const lineKey = pg.imageKey ?? `books/${slug}/images/${ch}-page-${pi}.jpg`;
            if (!force && await colorIsCurrent(env, bible, plan, pg, ckey, lineKey)) return "exists";
            holdColor(pg, 'color generation pending or failed');
            await r2Put(env.BOOKS, `books/${slug}/plans/${ch}.json`, JSON.stringify(plan, null, 1), "application/json");
            const line = await r2GetBytes(env.BOOKS, lineKey);
            if (!line || pg.held || pg.lineIdentity?.revision !== pageSourceRevision(bible, plan, pg) || pg.lineIdentity?.sha256 !== bytesHash(line))
              throw new Error(`${ch}: missing, held or unverifiable line source for color`);
            const res = await genColorizeWithQC(env, slug, line, plan.pages[pi].character, plan.pages[pi].storyText, { chapter: ch, page: pi }, { ...(plan.pages[pi].scene ?? {}), imagePrompt: plan.pages[pi].imagePrompt });
            if (res.status !== "ok") {
              holdColor(pg, res.status === 'gateway' ? 'color gateway unavailable' : 'color QC or spend cap held the page');
              await r2Put(env.BOOKS, `books/${slug}/plans/${ch}.json`, JSON.stringify(plan, null, 1), "application/json");
              return "held";
            }
            await env.BOOKS.put(ckey, res.bytes, { httpMetadata: { contentType: "image/png" } });
            stampColor(bible, plan, pg, line, res.bytes);
            pg.imageColorKey = ckey;
            await r2Put(env.BOOKS, `books/${slug}/plans/${ch}.json`, JSON.stringify(plan, null, 1), "application/json");
            return "colored";
          });
          if (did === "colored") colored++;
          else if (did === "held") heldCount++;
          else skipped++;
        }
        if (head.hasFinale) {
          const did: any = await step.do(`colorize ${ch} finale`, RETRIES, async () => {
            const cfkey = `books/${slug}/images-color/${ch}-finale.jpg`;
            const plan = await r2GetJson(env.BOOKS, `books/${slug}/plans/${ch}.json`);
            const pg = plan.finale;
            const lineKey = pg.imageKey ?? `books/${slug}/images/${ch}-finale.jpg`;
            if (!force && await colorIsCurrent(env, bible, plan, pg, cfkey, lineKey)) return "exists";
            holdColor(pg, 'color generation pending or failed');
            await r2Put(env.BOOKS, `books/${slug}/plans/${ch}.json`, JSON.stringify(plan, null, 1), "application/json");
            const line = await r2GetBytes(env.BOOKS, lineKey);
            if (!line || pg.held || pg.lineIdentity?.revision !== pageSourceRevision(bible, plan, pg) || pg.lineIdentity?.sha256 !== bytesHash(line))
              throw new Error(`${ch}: missing, held or unverifiable line source for color`);
            const res = await genColorizeWithQC(env, slug, line, plan.finale?.character ?? "", plan.finale?.storyText, { chapter: ch, page: -1 }, { ...(plan.finale?.scene ?? {}), imagePrompt: plan.finale?.imagePrompt });
            if (res.status !== "ok") {
              holdColor(pg, res.status === 'gateway' ? 'color gateway unavailable' : 'color QC or spend cap held the page');
              await r2Put(env.BOOKS, `books/${slug}/plans/${ch}.json`, JSON.stringify(plan, null, 1), "application/json");
              return "held";
            }
            await env.BOOKS.put(cfkey, res.bytes, { httpMetadata: { contentType: "image/png" } });
            stampColor(bible, plan, pg, line, res.bytes);
            pg.imageColorKey = cfkey;
            await r2Put(env.BOOKS, `books/${slug}/plans/${ch}.json`, JSON.stringify(plan, null, 1), "application/json");
            return "colored";
          });
          if (did === "colored") colored++;
          else if (did === "held") heldCount++;
          else skipped++;
        }
      }

      const assembled: any = await step.do("assemble color book", RETRIES, async () => {
        const result = await assembleVerifiedPdf(env, slug, 'color');
        return { colorKey: result.key, revision: result.revision, held: [] as string[] };
      });
      const colorKey: string | null = assembled?.colorKey ?? null;
      // Coloring adds provenance to the source plans. Refresh base receipts against
      // that same final inventory, in separate steps to bound memory per PDF.
      await step.do("refresh base coloring identity", RETRIES, async () => {
        return await assembleVerifiedPdf(env, slug, 'coloring', assembled.revision);
      });
      await step.do("refresh base picture identity", RETRIES, async () => {
        return await assembleVerifiedPdf(env, slug, 'picture', assembled.revision);
      });

      await step.do("register color edition", RETRIES, async () => {
        if (!colorKey) return false;
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
          "UPDATE books SET color_book_key=?, stage='done', stage_detail=?, updated_at=? WHERE slug=?"
        )
          .bind(colorKey, `color edition ready (${colored} colored, ${skipped} already or skipped)`, now, slug)
          .run();
        await recordEdition(env, slug, "color", [{ key: colorKey, role: "color_picture_book_pdf" }]);
        return true;
      });
      await step.do("refresh editor chapters", RETRIES, async () => {
        // The admin QC reader and full editor read color pointers from
        // editor_chapters.json; without this refresh a colorized book
        // keeps showing line pages in the full-color view.
        if (!colorKey) return false;
        await rebuildEditorChapters(env as any, slug);
        return true;
      });
      return { slug, colorKey, colored, skipped, heldCount };
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 400);
      console.log(`ColorizeWorkflow failed for ${slug}: ${msg}`);
      try {
        await env.DB.prepare("UPDATE books SET stage='done', stage_detail=?, updated_at=? WHERE slug=?")
          .bind(`colorize failed: ${msg}`, Math.floor(Date.now() / 1000), slug)
          .run();
      } catch { /* best effort */ }
      throw e;
    }
  }
}
