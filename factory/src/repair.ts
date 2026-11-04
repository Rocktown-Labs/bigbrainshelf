import { assembleVerifiedPdf, pretranscodeAssembly, assemblyChapters, colorAssemblyReady } from "./assembly";
import { stampLine, bytesHash } from "../../packages/core/src/assembly-identity";
import { recordWorkflowRun } from "../../packages/core/src/run-provenance";
// RepairWorkflow: the factory's self-healing loop (CG, 2026-10-25).
//
// Born from a night of failures that all shared one shape: a pipeline
// stage quietly produced less than the book needed, a later stage
// reported success anyway, and a human found the hole by reading the
// output. Docker's bible had a 3-entry concept ladder for an 18-chapter
// book; the regen "completed with flags" and left v1 pages in place.
// Fern's chapters 3, 7, 9 carried impure pages for a day. Sheets have
// vanished; covers have gone missing; plans have failed to land.
//
// This workflow is the standing answer: AUDIT the whole book against
// its own promises (bible, ladder, cast sheets, plans, page art,
// covers, PDFs), REPAIR each defect class with the same builders the
// pipelines use, then RE-AUDIT. Nothing counts as fixed because a step
// ran; it counts when the audit stops finding it. Defects that survive
// the round cap escalate into the book's stage as repair_failed with
// the list attached. Silence is the one outcome this workflow never
// produces.
//
// Repair order matters: bible first (a short ladder starves every
// planner downstream), then character sheets (art conditions on them),
// then plans, then page art, then covers, then reassembly. Caps keep a
// repair run from becoming a burn: bounded rounds, bounded image
// redraws, one bible extension per round.

import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import {
  BookBuildEnv,
  r2GetJson,
  r2Put,
  r2GetBytes,
  r2ListAll,
  loadSheets,
  genImageWithQC,
  genPictureColorWithQC,
  rebuildEditorChapters,
  beginRun,
  coloringCaption,
  expectedFromCastList,
  heldPages,
} from "./bookbuild";
import { normalizeBible, validateBible } from "./biblegate";
import { planChapterAttempt } from "./planv3";
import { callModel } from "./models";
import { buildBiblePrompt } from "./bibleprompt";
import { anchoredPrompt, sheetKeyFor, judgeCastListing, castListingOk } from "./ai";
import { linePurity, analyzePage, pageVerdict, purifyPage } from "./purity";
import { gatewayConfigured, generateGatewayImage, linePromptFromScene } from "./gateway";
import { composeMatter, ensureBackCoverImages, BACK_COVER_COLOR_KEY, BACK_COVER_LINE_KEY } from "./matter";
import { snapshotIfChanged } from "./versioning";
import { recordEdition, standardArtifacts } from "./editions";

export interface RepairParams {
  slug: string;
  dryRun?: boolean;
  maxRounds?: number;
  maxImageRepairs?: number;
  // Page-level fix path (CG, 2026-10-26): pages an EXTERNAL review has
  // already verified as defective, in fix-list notation ("S9p1",
  // "S6 finale"). The built-in audit only sees purity and existence, so
  // semantic defects (clones, pose sheets, human substitutions, baked
  // text) were invisible to it. Forced pages are redrawn through the
  // same gated generator as audit-flagged ones.
  forcePages?: string[];
  // Pages (same fix-list notation) whose escalation must NOT use the
  // simplification branch: a character who speaks on a page must stay
  // in frame (CG, 2026-10-28), so dropping a speaking co-star to make
  // a page pass is worse than holding it. Their escalation is
  // rewrite-only; if no valid rewrite lands, the page holds for
  // review with the trail instead of simplifying.
  noSimplifyPages?: string[];
}

export interface Defect {
  kind:
    | "bible_missing"
    | "bible_invalid"
    | "ladder_short"
    | "sheet_missing"
    | "plan_missing"
    | "image_missing"
    | "image_impure"
    | "image_flagged"
    | "cover_missing"
    | "pdf_missing";
  chapter?: string;
  page?: number;
  name?: string;
  detail: string;
}

const RETRIES = { retries: { limit: 3, delay: "10 seconds", backoff: "constant" } } as const;
const PLAN_STEP = { retries: { limit: 1, delay: "10 seconds", backoff: "constant" }, timeout: "8 minutes" } as const;

async function setStage(env: BookBuildEnv, slug: string, detail = ""): Promise<void> {
  try {
    await env.DB.prepare("UPDATE books SET stage='repair', stage_detail=?, updated_at=? WHERE slug=?")
      .bind(detail.slice(0, 400), Math.floor(Date.now() / 1000), slug)
      .run();
  } catch (e: any) {
    console.log(`repair setStage failed: ${e?.message ?? e}`);
  }
}

async function setFinalStage(env: BookBuildEnv, slug: string, stage: string, detail = ""): Promise<void> {
  try {
    await env.DB.prepare("UPDATE books SET stage=?, stage_detail=?, updated_at=? WHERE slug=?")
      .bind(stage, detail.slice(0, 400), Math.floor(Date.now() / 1000), slug)
      .run();
  } catch { /* best effort */ }
}

function chOf(key: string): number {
  const m = key.match(/S(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

// Fix-list notation -> defects. "S9p1" is chapter 9, page index 1 (the
// plan's pages array index, matching the image key); "S6 finale" is the
// chapter finale (page -1). Unparseable entries are dropped loudly in
// the run log rather than guessed at.
function parseForcePages(forcePages?: string[]): Defect[] {
  const out: Defect[] = [];
  const seen = new Set<string>();
  for (const raw of forcePages ?? []) {
    const m = String(raw).trim().match(/^S(\d+)(?:p(\d+)| finale)$/i);
    if (!m) {
      console.log(`repair forcePages: ignoring unparseable entry '${raw}'`);
      continue;
    }
    const chapter = `S${parseInt(m[1], 10)}`;
    const page = m[2] !== undefined ? parseInt(m[2], 10) : -1;
    const k = `${chapter}:${page}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ kind: "image_flagged", chapter, page, detail: `externally verified defect (fix list): ${String(raw).trim()}` });
  }
  return out;
}

// The book's promised chapter count: the highest chapter any plan
// reached, or the ladder itself. The source analysis (book_info) is
// deliberately NOT evidence: a bible may legitimately compress many
// source chapters into fewer story chapters (Penny maps a long source
// into 8). What a bible may not do is stop short of chapters the book
// itself already tells, which is exactly the Docker failure (plans
// S4-S18 existed with no ladder behind them).
export async function expectedChapters(env: BookBuildEnv, slug: string, ladderLen: number): Promise<number> {
  const keys = await r2ListAll(env.BOOKS, `books/${slug}/plans/`);
  const maxPlan = keys
    .filter((k) => /\/plans\/S\d+\.json$/.test(k))
    .reduce((a, k) => Math.max(a, chOf(k)), 0);
  return Math.max(maxPlan, ladderLen);
}

async function takenNames(env: BookBuildEnv, slug: string): Promise<Set<string>> {
  try {
    const rows: any = await env.DB.prepare("SELECT name FROM characters WHERE book_slug != ?").bind(slug).all();
    return new Set(((rows?.results ?? []) as any[]).map((r) => String(r.name).toLowerCase()));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------- audit
// Pure reads plus the programmatic purity gate. No model calls, no
// spend: an audit can run any time, including dry-run reports.
export async function auditBook(env: BookBuildEnv, slug: string): Promise<{ defects: Defect[]; bible: any | null }> {
  const defects: Defect[] = [];
  let bible: any = await r2GetJson(env.BOOKS, `books/${slug}/bible.json`);
  if (!bible?.conceptLadder?.length) {
    // Mirror the build: an attached bookstore bible is a valid bible.
    try {
      const row: any = await env.DB.prepare(
        "SELECT data FROM bibles WHERE book_slug = ? ORDER BY created_at DESC LIMIT 1"
      ).bind(slug).first();
      if (row?.data) {
        const attached = JSON.parse(String(row.data));
        if (attached?.conceptLadder?.length) bible = attached;
      }
    } catch { /* fall through: bible_missing stands */ }
  }
  if (!bible?.conceptLadder?.length) {
    defects.push({ kind: "bible_missing", detail: "no bible in R2 and none attached in the bookstore" });
    return { defects, bible: null };
  }
  bible = normalizeBible(bible);
  const ladder: any[] = bible.conceptLadder ?? [];

  // Bible structural validity (the existing gate) + the count promise.
  const reasons = validateBible(bible, await takenNames(env, slug));
  const ladderReasons = reasons.filter((r) => /conceptLadder|storyChapter|mechanism|metaphor|failureCase|location/i.test(r));
  const otherReasons = reasons.filter((r) => !ladderReasons.includes(r));
  for (const r of otherReasons) defects.push({ kind: "bible_invalid", detail: r });
  const expected = await expectedChapters(env, slug, ladder.length);
  if (ladder.length < expected) {
    defects.push({
      kind: "ladder_short",
      detail: `ladder has ${ladder.length} chapters but the book promises ${expected}`,
    });
  } else if (ladderReasons.length) {
    defects.push({ kind: "bible_invalid", detail: ladderReasons.join("; ").slice(0, 300) });
  }

  // Character sheets: registry row or legacy library key must resolve
  // to real bytes, the same resolution loadSheet performs at draw time.
  for (const c of bible.characters ?? []) {
    const name = String(c?.name ?? "").trim();
    if (!name) continue;
    const sheets = await loadSheets(env, slug, name);
    if (!sheets.length) {
      defects.push({ kind: "sheet_missing", name, detail: `no sheet resolves for '${name}'` });
    }
  }

  // Plans + page art per ladder chapter.
  for (let i = 1; i <= ladder.length; i++) {
    const ch = `S${i}`;
    const plan = await r2GetJson(env.BOOKS, `books/${slug}/plans/${ch}.json`);
    if (!plan?.pages?.length) {
      defects.push({ kind: "plan_missing", chapter: ch, detail: `no plan for ${ch}` });
      continue;
    }
    for (let pi = 0; pi < plan.pages.length; pi++) {
      const key = `books/${slug}/images/${ch}-page-${pi}.jpg`;
      if ((plan.pages[pi] as any).held) {
        defects.push({ kind: "image_flagged", chapter: ch, page: pi, detail: "page held for review (gates failed or spend cap)" });
        continue;
      }
      const bytes = await r2GetBytes(env.BOOKS, key);
      if (!bytes) {
        defects.push({ kind: "image_missing", chapter: ch, page: pi, detail: `${key} absent` });
      } else {
        // v2 pixel verdicts (2026-10-27): the v1 saturation metric
        // passed every leaking page in the catalog; the audit now
        // judges with the same gates generation uses.
        const v = pageVerdict(analyzePage(bytes));
        if (v.verdict !== "clean") {
          defects.push({
            kind: "image_impure",
            chapter: ch,
            page: pi,
            detail: `${key} ${v.verdict}: ${v.reasons.join("; ")}`,
          });
        }
      }
    }
    if (plan.finale?.imagePrompt) {
      const key = `books/${slug}/images/${ch}-finale.jpg`;
      if ((plan.finale as any).held) {
        defects.push({ kind: "image_flagged", chapter: ch, page: -1, detail: "finale held for review (gates failed or spend cap)" });
      } else {
        const bytes = await r2GetBytes(env.BOOKS, key);
        if (!bytes) {
          defects.push({ kind: "image_missing", chapter: ch, page: -1, detail: `${key} absent` });
        } else {
          const v = pageVerdict(analyzePage(bytes));
          if (v.verdict !== "clean") {
            defects.push({ kind: "image_impure", chapter: ch, page: -1, detail: `${key} ${v.verdict}: ${v.reasons.join("; ")}` });
          }
        }
      }
    }
  }

  // Covers + assembled PDFs.
  if (!(await env.BOOKS.head(`books/${slug}/cover.jpg`))) {
    defects.push({ kind: "cover_missing", detail: "no cover art at books/" + slug + "/cover.jpg" });
  }
  const row: any = await env.DB.prepare(
    "SELECT picture_book_key, coloring_book_key FROM books WHERE slug=?"
  ).bind(slug).first().catch(() => null);
  for (const [label, key] of [["picture", row?.picture_book_key], ["coloring", row?.coloring_book_key]] as const) {
    const k = key || `books/${slug}/${label === "picture" ? "picture-book" : "coloring-book"}.pdf`;
    if (!(await env.BOOKS.head(k))) {
      defects.push({ kind: "pdf_missing", detail: `${label} PDF absent at ${k}` });
    }
  }

  return { defects, bible };
}

// ---------------------------------------------------------------- bible repair
// Extend a short ladder. Material per missing chapter, best first:
// the source chapter's own summary (book_info), then the chapter's
// existing plan (realConcept/storyTitle/takeaway: the v1 transcription
// path that fixed Docker by hand on 2026-10-25), then the source
// chapter title alone. The model writes entries in the exact shape of
// the ones already there; anything malformed is refused, so a short
// or sloppy extension stays a defect instead of becoming the bible.
async function extendLadder(env: BookBuildEnv, slug: string, bible: any): Promise<any> {
  const ladder: any[] = bible.conceptLadder ?? [];
  const expected = await expectedChapters(env, slug, ladder.length);
  const missing: string[] = [];
  for (let i = ladder.length + 1; i <= expected; i++) missing.push(`S${i}`);
  if (!missing.length) return bible;

  const info = await r2GetJson(env.BOOKS, `books/${slug}/book_info.json`);
  const material: string[] = [];
  for (const ch of missing) {
    const n = chOf(ch);
    const src = info?.chapters?.[n - 1];
    const plan = await r2GetJson(env.BOOKS, `books/${slug}/plans/${ch}.json`);
    const bits: string[] = [`${ch}:`];
    if (src?.title) bits.push(`source chapter title: ${src.title}`);
    if (src?.summary) bits.push(`source summary: ${src.summary}`);
    if (plan?.storyTitle) bits.push(`existing story chapter title: ${plan.storyTitle}`);
    if (plan?.realConcept) bits.push(`concept the existing story teaches: ${plan.realConcept}`);
    if (plan?.takeaway) bits.push(`takeaway: ${plan.takeaway}`);
    material.push(bits.join("\n"));
  }

  const prompt = [
    `You are completing the story bible for a children's picture book.`,
    `Book: ${bible.bookTitle ?? slug}. Big idea: ${bible.bigIdea ?? ""}. Setting: ${bible.setting ?? ""}.`,
    `Cast: ${(bible.characters ?? []).map((c: any) => `${c.name} (${c.species})`).join(", ")}.`,
    ``,
    `The concept ladder already has these entries (match this exact shape and voice):`,
    JSON.stringify(ladder.slice(-3), null, 1),
    ``,
    `Write ladder entries for the missing chapters ONLY: ${missing.join(", ")}.`,
    `Base each entry on its source material below. Keep the curriculum order: each chapter builds on the ones before. One metaphor per chapter, never repeating a metaphor already used. Every entry needs: storyChapter, title, idea (one sentence), mechanism (2-3 sentences, factually accurate), buildsOn, core (true), metaphor, fidelity ("accurate" or "simplified"), simplificationHides ("" unless fidelity is simplified), location (a place inside the setting), failureCase (a concrete story problem, at least 20 characters, never a copy of the mechanism).`,
    `No em dashes anywhere.`,
    ``,
    `Source material:`,
    material.join("\n\n"),
    ``,
    `Return JSON: {"entries": [ ... ]} with exactly ${missing.length} entries in order.`,
  ].join("\n");

  const { data } = await callModel(env, prompt, 16384, "writer", { slug, purpose: "repair-extend-ladder" });
  const entries: any[] = Array.isArray(data?.entries) ? data.entries : [];
  const byChapter = new Map(entries.map((e: any) => [String(e?.storyChapter ?? ""), e]));
  const usedMetaphors = new Set(ladder.map((e: any) => String(e?.metaphor ?? "").trim().toLowerCase()).filter(Boolean));
  const merged = [...ladder];
  for (const ch of missing) {
    const e = byChapter.get(ch);
    if (!e) continue;
    const metaphor = String(e.metaphor ?? "").trim();
    const ok =
      String(e.title ?? "").trim() &&
      String(e.idea ?? "").trim() &&
      String(e.mechanism ?? "").trim().length >= 30 &&
      metaphor &&
      !usedMetaphors.has(metaphor.toLowerCase()) &&
      String(e.failureCase ?? "").trim().length >= 20 &&
      String(e.failureCase ?? "").trim().toLowerCase() !== String(e.mechanism ?? "").trim().toLowerCase() &&
      String(e.location ?? "").trim();
    if (!ok) {
      console.log(`ladder extension: entry for ${ch} failed structural checks, leaving the defect open`);
      continue;
    }
    usedMetaphors.add(metaphor.toLowerCase());
    // No sourceRef: the bible carries no source trail (2026-10-31).
    const { sourceRef: _dropped, ...rest } = e as any;
    merged.push({ ...rest, storyChapter: ch });
  }
  merged.sort((a, b) => chOf(String(a.storyChapter)) - chOf(String(b.storyChapter)));
  const out = { ...bible, conceptLadder: merged };
  await persistBible(env, slug, out);
  return out;
}

async function persistBible(env: BookBuildEnv, slug: string, bible: any): Promise<void> {
  await r2Put(env.BOOKS, `books/${slug}/bible.json`, JSON.stringify(bible, null, 1), "application/json");
  try {
    const row: any = await env.DB.prepare("SELECT data FROM bibles WHERE book_slug=?").bind(slug).first();
    if (row?.data) {
      const d = JSON.parse(String(row.data));
      d.conceptLadder = bible.conceptLadder;
      if (Array.isArray(bible.characters)) d.characters = bible.characters;
      await env.DB.prepare("UPDATE bibles SET data=? WHERE book_slug=?").bind(JSON.stringify(d), slug).run();
    }
  } catch { /* D1 mirror is best-effort; R2 is the factory's source */ }
}

// Full bible when none exists: attached bookstore bible first, then
// the standard generator over book_info (same path as the build).
async function ensureBible(env: BookBuildEnv, slug: string): Promise<any | null> {
  try {
    const row: any = await env.DB.prepare(
      "SELECT data FROM bibles WHERE book_slug = ? ORDER BY created_at DESC LIMIT 1"
    ).bind(slug).first();
    if (row?.data) {
      const attached = JSON.parse(String(row.data));
      if (attached?.conceptLadder?.length) {
        attached._bible_source = "bookstore";
        await r2Put(env.BOOKS, `books/${slug}/bible.json`, JSON.stringify(attached, null, 1), "application/json");
        return normalizeBible(attached);
      }
    }
  } catch { /* generate below */ }
  const info = await r2GetJson(env.BOOKS, `books/${slug}/book_info.json`);
  if (!info?.chapters?.length) return null;
  const { data, model } = await callModel(env, buildBiblePrompt(info, []), 16384, "writer", { slug, purpose: "bible-regen" });
  if (!data?.conceptLadder?.length) return null;
  data._bible_model = model;
  const normalized = normalizeBible(data);
  await persistBible(env, slug, normalized);
  return normalized;
}

// ---------------------------------------------------------------- sheet repair
// Mirrors the character studio: draw from the bible visual verbatim,
// land as pending. When the character already has a registry row (the
// sheet was lost, not never-approved), restore the canonical key too
// and say so in the run report: restoration, not a new casting choice.
async function repairSheet(env: BookBuildEnv, slug: string, bible: any, name: string, actions: string[]): Promise<void> {
  if (!gatewayConfigured(env)) throw new Error("gateway not configured");
  const c = (bible.characters ?? []).find((x: any) => String(x?.name ?? "").toLowerCase() === name.toLowerCase());
  const visual = String(c?.visual ?? "").trim();
  if (!visual) throw new Error(`no visual on file for '${name}'`);
  const prompt =
    "Character reference sheet for a children's picture book, plain light background, " +
    "clean storybook illustration, soft warm colors. No text, no labels, no words anywhere " +
    `in the image. ${visual}`;
  const bytes = await generateGatewayImage(env, prompt, []);
  const nameKey = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const pendingKey = `characters/pending/${slug}-${nameKey}.png`;
  await env.BOOKS.put(pendingKey, bytes, { httpMetadata: { contentType: "image/png" } });
  await env.BOOKS.put(
    `characters/pending/${slug}-${nameKey}.json`,
    JSON.stringify({ slug, name, visual, at: Math.floor(Date.now() / 1000), via: "repair" }, null, 1),
    { httpMetadata: { contentType: "application/json" } }
  );
  const row: any = await env.DB.prepare(
    "SELECT jpg_key FROM characters WHERE book_slug=? AND lower(name)=lower(?)"
  ).bind(slug, name).first().catch(() => null);
  if (row?.jpg_key) {
    await env.BOOKS.put(String(row.jpg_key), bytes, { httpMetadata: { contentType: "image/png" } });
    actions.push(`sheet for ${name}: restored at ${row.jpg_key} (also pending review in the studio)`);
  } else {
    actions.push(`sheet for ${name}: generated to pending, awaiting approval in the character studio`);
  }
}

// ---------------------------------------------------------------- plan repair
async function repairPlan(env: BookBuildEnv, slug: string, bible: any, chapter: string): Promise<void> {
  const prevPlans: any[] = [];
  for (let i = 1; i < chOf(chapter); i++) {
    const p = await r2GetJson(env.BOOKS, `books/${slug}/plans/S${i}.json`);
    if (p?.pages?.length) prevPlans.push(p);
  }
  const prev = prevPlans[prevPlans.length - 1];
  let notes = "";
  for (let a = 1; a <= 3; a++) {
    const att = await planChapterAttempt(env, bible, chapter, prev?.newStorySoFar ?? "", prev?.hook ?? "", notes, prevPlans, slug);
    if (!att.passed) {
      await r2Put(env.BOOKS, `books/${slug}/rejected/${chapter}-repair-a${a}.json`, JSON.stringify(att.plan, null, 1), "application/json");
      notes = att.notes ?? "";
      continue;
    }
    att.plan.storyChapter = chapter;
    att.plan._v3_attempts = a;
    att.plan._model = att.model;
    await r2Put(env.BOOKS, `books/${slug}/plans/${chapter}.json`, JSON.stringify(att.plan, null, 1), "application/json");
    return;
  }
  throw new Error(`planning ${chapter} failed after 3 attempts: ${String(notes).slice(0, 200)}`);
}

// ---------------------------------------------------------------- image repair
// Returns "redrawn" or "purified" when the page is fixed, false when
// the redraw was held for review (the plan page keeps its held flag,
// so the final audit escalates it instead of calling it repaired).
async function repairImage(env: BookBuildEnv, slug: string, bible: any, d: Defect): Promise<"redrawn" | "purified" | false> {
  const plan = await r2GetJson(env.BOOKS, `books/${slug}/plans/${d.chapter}.json`);
  if (!plan?.pages?.length) throw new Error(`no plan to draw from for ${d.chapter}`);
  const planKey = `books/${slug}/plans/${d.chapter}.json`;
  if (d.page === -1) {
    const fscene = plan.finale?.scene;
    const fprompt = fscene?.cast?.length ? linePromptFromScene(fscene, bible) : plan.finale.imagePrompt;
    const bytes = await genImageWithQC(env, slug, fprompt, undefined, { chapter: d.chapter!, page: -1 }, plan.finale?.storyText, fscene);
    if (!bytes) {
      (plan.finale as any).held = true;
      (plan.finale as any).heldReason = "repair redraw held; see gen_events";
      await r2Put(env.BOOKS, planKey, JSON.stringify(plan, null, 1), "application/json");
      return false;
    }
    await env.BOOKS.put(`books/${slug}/images/${d.chapter}-finale.jpg`, bytes, { httpMetadata: { contentType: "image/jpeg" } });
    stampLine(bible, plan, plan.finale, bytes);
    plan.finale.imageKey = `books/${slug}/images/${d.chapter}-finale.jpg`;
    await r2Put(env.BOOKS, planKey, JSON.stringify(plan, null, 1), "application/json");
    if ((plan.finale as any).held) {
      delete (plan.finale as any).held;
      delete (plan.finale as any).heldReason;
      await r2Put(env.BOOKS, planKey, JSON.stringify(plan, null, 1), "application/json");
    }
    return "redrawn";
  }
  const pg = plan.pages[d.page!];
  const key = `books/${slug}/images/${d.chapter}-page-${d.page}.jpg`;
  // Free fix first for audit-found impurity in the autofix band: strip
  // the specks in place instead of paying for a redraw. NEVER for
  // externally flagged pages: their defect is semantic (a clone, a
  // human), and purifying the pixels would leave it in place.
  if (d.kind === "image_impure") {
    const existing = await r2GetBytes(env.BOOKS, key);
    if (existing && pageVerdict(analyzePage(existing)).verdict === "autofix") {
      const fixed = purifyPage(existing);
      if (fixed && pageVerdict(analyzePage(fixed)).verdict === "clean") {
        await env.BOOKS.put(key, fixed, { httpMetadata: { contentType: "image/jpeg" } });
        // A pixel cleanup cannot establish missing historical provenance.
        if (pg.lineIdentity?.sha256 === bytesHash(existing)) {
          pg.lineIdentity.sha256 = bytesHash(fixed);
          await r2Put(env.BOOKS, planKey, JSON.stringify(plan, null, 1), "application/json");
        }
        return "purified";
      }
    }
  }
  const scene = pg.scene;
  const promptText = scene?.cast?.length ? linePromptFromScene(scene, bible) : anchoredPrompt(pg.imagePrompt, pg.character, bible);
  const bytes = await genImageWithQC(
    env, slug,
    promptText,
    pg.character,
    { chapter: d.chapter!, page: d.page! },
    pg.storyText,
    scene
  );
  if (!bytes) {
    pg.held = true;
    pg.heldReason = "repair redraw held; see gen_events";
    await r2Put(env.BOOKS, planKey, JSON.stringify(plan, null, 1), "application/json");
    return false;
  }
  await env.BOOKS.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  stampLine(bible, plan, pg, bytes);
  pg.imageKey = key;
  await r2Put(env.BOOKS, planKey, JSON.stringify(plan, null, 1), "application/json");
  if (pg.held) {
    delete pg.held;
    delete pg.heldReason;
    await r2Put(env.BOOKS, planKey, JSON.stringify(plan, null, 1), "application/json");
  }
  return "redrawn";
}

// ---------------------------------------------------------------- escalation
// Phase 2 (2026-10-28): a page that fails 2 repair rounds stops
// re-rolling the same scene. It escalates ONCE, by defect class,
// judged from the cast listing of the page's CURRENT art:
//  - clone of the LEAD (the listing counts the lead's species above
//    the cast's count, or the same figure drawing repeats): the
//    writer chain rewrites the page's scene — same cast, same story
//    beat, new actions and composition — and the page redraws from
//    the rewritten scene, which is persisted to the plan.
//  - anything else (extra or disputed cast, wrong species, no
//    listing opinion): the scene is simplified to the lead alone —
//    co-stars and props stripped — and the page redraws from that.
// Every step is recorded in the run's actions (the repair_runs row).
// A page that still fails after escalation stays held_for_review with
// the full trail, exactly as before.
async function escalateRepairImage(
  env: BookBuildEnv,
  slug: string,
  bible: any,
  d: Defect,
  noSimplify = false
): Promise<{ status: "redrawn" | false; log: string[] }> {
  // The trail is RETURNED, not pushed into the shared actions array:
  // pushes made inside step callbacks are lost when the workflow
  // replays, which is why repair_runs.actions shipped empty. Callers
  // append the returned log in run() scope, where it survives replay.
  const log: string[] = [];
  const planKey = `books/${slug}/plans/${d.chapter}.json`;
  const plan = await r2GetJson(env.BOOKS, planKey);
  if (!plan?.pages?.length) throw new Error(`no plan to escalate from for ${d.chapter}`);
  const isFinale = d.page === -1;
  const pg: any = isFinale ? plan.finale : plan.pages[d.page!];
  if (!pg) throw new Error(`no plan page for ${d.chapter} p${d.page}`);
  const label = `${d.chapter} page ${d.page}`;
  const imageKey = `books/${slug}/images/${d.chapter}-${isFinale ? "finale" : `page-${d.page}`}.jpg`;

  // Cast + lead from the plan's own structure.
  const scene: any = pg.scene ?? null;
  let names: string[] = [];
  if (scene?.cast?.length) {
    names = scene.cast.map((c: any) => String(c?.name ?? "").trim()).filter(Boolean);
  }
  if (!names.length && pg.character) {
    names = String(pg.character).split(",").map((s: string) => s.replace(/[\[\]']/g, "").trim()).filter(Boolean);
  }
  if (!names.length) {
    names = (bible.characters ?? []).map((c: any) => String(c?.name ?? "").trim()).filter(Boolean);
  }
  const lead = names[0] ?? String(bible.characters?.[0]?.name ?? "");
  const bibleChar = (n: string) =>
    (bible.characters ?? []).find((c: any) => String(c?.name ?? "").toLowerCase() === n.toLowerCase());
  const expected = expectedFromCastList(
    names.map((n) => ({ species: String(bibleChar(n)?.species ?? "") })).filter((x) => x.species)
  );

  // Defect class from the current art's cast listing.
  let listingReason: string | null = null;
  let leadClone = false;
  const current = await r2GetBytes(env.BOOKS, imageKey);
  if (current && expected.length) {
    const listing = await judgeCastListing(env, current);
    if (listing) {
      listingReason = castListingOk(expected, listing);
      const leadSpecies = String(bibleChar(lead)?.species ?? "").toLowerCase().trim();
      if (leadSpecies) {
        const want = expected.find((e) => e.species === leadSpecies)?.count ?? 1;
        const got = listing.animals.find(
          (a) => a.species.includes(leadSpecies) || leadSpecies.includes(a.species)
        );
        leadClone = (got?.count ?? 0) > want || listing.same_pose_repeated;
      }
    }
  }
  log.push(
    `escalation: ${label} classed as ${leadClone ? "lead clone" : "cast/scene defect"}` +
      (listingReason ? ` (listing: ${listingReason})` : " (no listing opinion)") +
      (noSimplify && !leadClone ? " (noSimplify: rewrite-only escalation)" : "")
  );

  const origSetting = String(scene?.setting ?? "");
  let newScene: any = null;
  if (leadClone || noSimplify) {
    // Writer rewrite: same cast, same beat, new composition.
    try {
      const castDesc = (bible.characters ?? [])
        .map((c: any) => `${c.name} (a ${c.species}: ${c.visual ?? ""})`)
        .join("; ");
      const prompt = [
        `You are rewriting ONE page's scene for a children's picture book redraw.`,
        `Book: ${bible.bookTitle ?? slug}. Setting: ${bible.setting ?? ""}. Cast of the book: ${castDesc}.`,
        `The page's story text (the beat must stay the same): ${String(pg.storyText ?? "")}`,
        `The page's concept: ${String(pg.concept ?? "")}.`,
        `Current scene (${leadClone ? "it keeps producing a duplicated lead character" : "its composition keeps failing the quality gates"}): ${JSON.stringify(scene ?? { cast: names.map((n) => ({ name: n })) })}`,
        ``,
        `Write a NEW scene for this page: the SAME cast (${names.join(", ")}), the same story beat,`,
        `but a clearly different action and composition for every character, especially ${lead},`,
        `who must be doing something visually distinct from the current scene. One single moment,`,
        `one place inside the book's setting, plain unmarked props only (at most 3), no text anywhere.`,
        `Return ONLY JSON: {"cast": [{"name": "...", "doing": "one physical action"}], "setting": "generic place description, no proper names", "props": ["..."]}`,
      ].join("\n");
      const { data } = await callModel(env, prompt, 4096, "writer", { slug, purpose: "repair-escalation" });
      const rawCast: any[] = Array.isArray(data?.cast) ? data.cast : [];
      const mapped = rawCast
        .map((c: any) => {
          const bc = bibleChar(String(c?.name ?? ""));
          return bc ? { name: String(bc.name), doing: String(c?.doing ?? "is in the scene").trim() } : null;
        })
        .filter(Boolean) as { name: string; doing: string }[];
      const sameCast =
        mapped.length === names.length &&
        mapped.every((c) => names.some((n) => n.toLowerCase() === c.name.toLowerCase())) &&
        mapped.some((c) => c.name.toLowerCase() === lead.toLowerCase());
      if (sameCast) {
        newScene = {
          cast: mapped,
          setting: String(data?.setting ?? "").trim() || origSetting,
          props: Array.isArray(data?.props) ? data.props.map((p: any) => String(p)).slice(0, 3) : [],
          ...(scene?.colorScript ? { colorScript: scene.colorScript } : {}),
        };
        log.push(`escalation: ${label} scene rewritten by the writer chain (same cast, new composition)`);
      } else {
        log.push(`escalation: ${label} writer rewrite failed validation (cast changed); ${noSimplify ? "simplification disallowed for this page" : "falling back to simplification"}`);
      }
    } catch (e: any) {
      log.push(`escalation: ${label} writer rewrite errored (${String(e?.message ?? e).slice(0, 120)}); ${noSimplify ? "simplification disallowed for this page" : "falling back to simplification"}`);
    }
  }
  if (!newScene && noSimplify) {
    // A speaking character must stay in frame (CG, 2026-10-28): for a
    // noSimplify page, dropping the co-star is worse than no fix at
    // all. Hold the page for review with the trail instead.
    pg.held = true;
    pg.heldReason = "repair escalation held: rewrite failed and simplification is disallowed for this page";
    await r2Put(env.BOOKS, planKey, JSON.stringify(plan, null, 1), "application/json");
    log.push(`escalation: ${label} held rather than simplified (noSimplify: a speaking character must stay in frame)`);
    return { status: false, log };
  }
  if (!newScene) {
    // Simplification: the lead alone, no co-stars, no props.
    const leadDoing = String(
      (scene?.cast ?? []).find((c: any) => String(c?.name ?? "").toLowerCase() === lead.toLowerCase())?.doing ??
        "is in the scene"
    );
    newScene = {
      cast: [{ name: lead, doing: leadDoing }],
      setting: origSetting,
      props: [],
      ...(scene?.colorScript?.[lead] ? { colorScript: { [lead]: scene.colorScript[lead] } } : {}),
    };
    log.push(`escalation: ${label} scene simplified to ${lead} alone (co-stars and props stripped)`);
  }

  const promptText = linePromptFromScene(newScene, bible);
  const bytes = await genImageWithQC(
    env, slug, promptText, isFinale ? undefined : pg.character,
    { chapter: d.chapter!, page: d.page! }, pg.storyText, newScene
  );
  if (!bytes) {
    pg.held = true;
    pg.heldReason = "repair escalation held; see gen_events";
    await r2Put(env.BOOKS, planKey, JSON.stringify(plan, null, 1), "application/json");
    log.push(`escalation: ${label} still held after escalation`);
    return { status: false, log };
  }
  await env.BOOKS.put(imageKey, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  pg.scene = newScene;
  if (pg.held) {
    delete pg.held;
    delete pg.heldReason;
  }
  await r2Put(env.BOOKS, planKey, JSON.stringify(plan, null, 1), "application/json");
  log.push(`escalation: ${label} redrawn from the escalated scene`);
  return { status: "redrawn", log };
}

// ---------------------------------------------------------------- cover + assemble
async function repairCover(env: BookBuildEnv, slug: string, bible: any): Promise<void> {
  if (!gatewayConfigured(env)) throw new Error("gateway not configured");
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
  const bytes = await genPictureColorWithQC(env, slug, prompt, cast || undefined, undefined, "1:1");
  if (!bytes) throw new Error("cover generation returned nothing");
  await env.BOOKS.put(`books/${slug}/cover.jpg`, bytes, { httpMetadata: { contentType: "image/png" } });
}

// Same assembly the regen performs: line art only in the base PDFs.
async function reassemble(env: BookBuildEnv, slug: string, bible: any): Promise<void> {
  const coloring = await assembleVerifiedPdf(env, slug, 'coloring');
  await assembleVerifiedPdf(env, slug, 'picture', coloring.revision);
  await rebuildEditorChapters(env, slug);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "UPDATE books SET picture_book_key=?, coloring_book_key=?, cover_key=COALESCE(cover_key, ?), updated_at=? WHERE slug=?"
  ).bind(`books/${slug}/picture-book.pdf`, `books/${slug}/coloring-book.pdf`, `books/${slug}/cover.jpg`, now, slug).run();
  void BACK_COVER_COLOR_KEY; void BACK_COVER_LINE_KEY;
  await recordEdition(env, slug, "line", standardArtifacts(slug, "line"));
}

// ---------------------------------------------------------- reassemble-only
// POST /book/{slug}/reassemble (owner, 2026-10-29): rebuild the
// downloadable PDFs from verified existing inputs. No generation branch;
// missing covers or page artifacts fail explicitly in the shared validator.
export async function reassembleBasePdfs(env: BookBuildEnv, slug: string): Promise<void> {
  const revision = await reassembleColoringPdf(env, slug);
  await reassemblePicturePdf(env, slug, revision);
}

// The two base PDFs assemble separately (the ReassembleWorkflow runs
// them as separate steps): each step holds only its own book's page
// bytes. Docker's combined set (60+ pages at full res, twice over
// with the PDF transcodes) blew the worker memory limit when both
// books were assembled in one step. The shared assembler loads verified
// matter bytes and has no generation branch.
export async function reassembleColoringPdf(env: BookBuildEnv, slug: string): Promise<string> {
  await snapshotIfChanged(env.BOOKS, slug, "reassemble");
  return (await assembleVerifiedPdf(env, slug, 'coloring')).revision;
}

export async function reassemblePicturePdf(env: BookBuildEnv, slug: string, revision?: string): Promise<void> {
  await assembleVerifiedPdf(env, slug, 'picture', revision);
  await rebuildEditorChapters(env, slug);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "UPDATE books SET picture_book_key=?, coloring_book_key=?, cover_key=COALESCE(cover_key, ?), updated_at=? WHERE slug=?"
  ).bind(`books/${slug}/picture-book.pdf`, `books/${slug}/coloring-book.pdf`, `books/${slug}/cover.jpg`, now, slug).run();
  await recordEdition(env, slug, "line", standardArtifacts(slug, "line"));
}

export async function reassembleColorPdf(
  env: BookBuildEnv,
  slug: string
): Promise<{ color: boolean; colorNote?: string }> {
  const assembled = await assembleVerifiedPdf(env, slug, 'color');
  await env.DB.prepare("UPDATE books SET color_book_key=?, updated_at=? WHERE slug=?")
    .bind(assembled.key, Math.floor(Date.now() / 1000), slug).run();
  await recordEdition(env, slug, "color", standardArtifacts(slug, "color"));
  return { color: true };
}

export interface ReassembleParams {
  slug: string;
}

// Assembly runs as a workflow, not in the fetch handler: building two
// 40+ page PDFs from full-res page art exceeds the fetch CPU limit
// (the first synchronous attempt died with error 1102 after writing
// only the coloring book). Each PDF family is its own step, the same
// shape RepairWorkflow's assemble step already runs within budget.
export class ReassembleWorkflow extends WorkflowEntrypoint<BookBuildEnv, ReassembleParams> {
  async run(event: WorkflowEvent<ReassembleParams>, step: WorkflowStep) {
    await recordWorkflowRun(this.env, step, event, "reassemble", event.payload.slug);
    const slug = event.payload.slug;
    if (!slug) throw new Error("reassemble requires a slug");
    // Warm the transcode cache a chapter per step before each assemble
    // step: a whole book of PNG transcodes in one step exceeds the CPU
    // limit (Fenix color assembly, 2026-11-04). Line art usually passes
    // through untranscoded, but PNG line pages exist (Blaze) and cost
    // the same when they do.
    const lineChapters: number[] = await step.do("list line chapters", RETRIES, async () => {
      return await assemblyChapters(this.env, slug, "picture");
    });
    for (const ch of lineChapters) {
      await step.do(`pretranscode line S${ch}`, RETRIES, async () => {
        await pretranscodeAssembly(this.env, slug, "picture", ch);
        return true;
      });
    }
    const baseRevision = await step.do("reassemble coloring pdf", RETRIES, async () => {
      return await reassembleColoringPdf(this.env, slug);
    });
    await step.do("reassemble picture pdf", RETRIES, async () => {
      await reassemblePicturePdf(this.env, slug, baseRevision);
      return true;
    });
    // A book without a complete color edition has nothing to assemble
    // here: report it in the result instead of erroring the whole run
    // after the base PDFs already landed.
    const hasColor: boolean = await step.do("probe color edition", RETRIES, async () => {
      return await colorAssemblyReady(this.env, slug);
    });
    if (!hasColor) {
      return { slug, picture: true, coloring: true, color: false, colorNote: "no complete color edition to assemble" };
    }
    const colorChapters: number[] = await step.do("list color chapters", RETRIES, async () => {
      return await assemblyChapters(this.env, slug, "color");
    });
    for (const ch of colorChapters) {
      await step.do(`pretranscode color S${ch}`, RETRIES, async () => {
        await pretranscodeAssembly(this.env, slug, "color", ch);
        return true;
      });
    }
    const color = await step.do("reassemble color pdf", RETRIES, async () => {
      return await reassembleColorPdf(this.env, slug);
    });
    return { slug, picture: true, coloring: true, ...color };
  }
}

// ---------------------------------------------------------------- the workflow
export class RepairWorkflow extends WorkflowEntrypoint<BookBuildEnv, RepairParams> {
  async run(event: WorkflowEvent<RepairParams>, step: WorkflowStep) {
    await recordWorkflowRun(this.env, step, event, "repair", event.payload.slug);
    const env = this.env;
    const slug = event.payload.slug;
    if (!slug) throw new Error("repair requires a slug");
    const dryRun = !!event.payload.dryRun;
    const maxRounds = Math.max(1, Math.min(3, event.payload.maxRounds ?? 2));
    const maxImageRepairs = Math.max(0, Math.min(60, event.payload.maxImageRepairs ?? 30));
    const actions: string[] = [];
    const forced = parseForcePages(event.payload.forcePages);
    const noSimplifyKeys = new Set(
      parseForcePages(event.payload.noSimplifyPages).map((d) => `${d.chapter}:${d.page}`)
    );
    const repairedForced = new Set<string>();
    try {
      await step.do("repair snapshot", RETRIES, async () => {
        await snapshotIfChanged(env.BOOKS, slug, "repair");
        return true;
      });
      await step.do("repair begin run", RETRIES, async () => {
        await beginRun(env, slug);
        return true;
      });
      await step.do("repair runs table", RETRIES, async () => {
        await env.DB.prepare(
          "CREATE TABLE IF NOT EXISTS repair_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT, dry_run INTEGER, rounds INTEGER, defects TEXT, actions TEXT, outcome TEXT, created_at INTEGER)"
        ).run();
        return true;
      });

      let lastDefects: Defect[] = [];
      let lastBible: any = null;
      // Escalation bookkeeping (Phase 2): per-page failed-round counts
      // across the whole run. A page at 2 failed rounds escalates once
      // (in-loop when a later round reaches it, otherwise in the
      // post-loop pass below) instead of re-rolling the same scene.
      const imageFailRounds = new Map<string, number>();
      const imageDefectsByKey = new Map<string, Defect>();
      const escalatedKeys = new Set<string>();
      for (let round = 1; round <= maxRounds; round++) {
        const audit: { defects: Defect[]; bible: any | null } = await step.do(`audit round ${round}`, RETRIES, async () => {
          await setStage(env, slug, `auditing (round ${round})`);
          return auditBook(env, slug);
        });
        // Externally flagged pages join the round until each one has
        // actually been redrawn; the built-in audit cannot see them,
        // so without this merge a forced run on an otherwise-clean
        // book would break out of the loop having done nothing.
        const pendingForced = forced.filter((d) => !repairedForced.has(`${d.chapter}:${d.page}`));
        // Dedupe image defects by page: a held page appears in the
        // audit AND the pending forced list in the same round, and
        // repairing (or failing) it twice in one round would corrupt
        // the escalation fail counts.
        const seenImg = new Set<string>();
        const roundDefects = [...audit.defects, ...pendingForced].filter((d) => {
          if (d.page === undefined || !d.chapter) return true;
          if (d.kind !== "image_missing" && d.kind !== "image_impure" && d.kind !== "image_flagged") return true;
          const k = `${d.chapter}:${d.page}`;
          if (seenImg.has(k)) return false;
          seenImg.add(k);
          return true;
        });
        lastDefects = roundDefects;
        if (!roundDefects.length || dryRun) break;

        let bible = audit.bible;
        if (bible) lastBible = bible;
        const by = (k: Defect["kind"]) => roundDefects.filter((d) => d.kind === k);

        // 1. bible: missing, invalid, or short.
        if (by("bible_missing").length) {
          bible = await step.do(`repair bible round ${round}`, RETRIES, async () => {
            await setStage(env, slug, "repairing bible (generating)");
            const b = await ensureBible(env, slug);
            if (b) actions.push("bible: generated/attached a full bible");
            return b;
          });
        }
        if (bible && (by("ladder_short").length || by("bible_invalid").length)) {
          bible = await step.do(`repair ladder round ${round}`, RETRIES, async () => {
            await setStage(env, slug, "repairing bible (extending the ladder)");
            const before = (bible.conceptLadder ?? []).length;
            const b = await extendLadder(env, slug, bible);
            const after = (b.conceptLadder ?? []).length;
            if (after > before) actions.push(`bible: ladder extended ${before} -> ${after} chapters`);
            return b;
          });
        }
        if (!bible) break; // nothing downstream is possible without one
        lastBible = bible;

        // 2. sheets.
        for (const d of by("sheet_missing")) {
          await step.do(`repair sheet ${d.name} round ${round}`, RETRIES, async () => {
            await setStage(env, slug, `repairing sheet for ${d.name}`);
            await repairSheet(env, slug, bible, d.name!, actions);
            return true;
          });
        }

        // 3. plans.
        for (const d of by("plan_missing")) {
          await step.do(`repair plan ${d.chapter} round ${round}`, PLAN_STEP, async () => {
            await setStage(env, slug, `planning ${d.chapter}`);
            await repairPlan(env, slug, bible, d.chapter!);
            actions.push(`plan: ${d.chapter} written`);
            return true;
          });
        }

        // 4. page art (bounded). A page with 2 failed rounds behind it
        // escalates (once) instead of re-rolling the same scene.
        const imageDefects = [...by("image_missing"), ...by("image_impure"), ...by("image_flagged")].slice(0, maxImageRepairs);
        for (const d of imageDefects) {
          const key = `${d.chapter}:${d.page}`;
          const fails = imageFailRounds.get(key) ?? 0;
          const escalate = fails >= 2 && !escalatedKeys.has(key);
          const out = await step.do(`repair image ${d.chapter} p${d.page} round ${round}${escalate ? " escalated" : ""}`, RETRIES, async () => {
            await setStage(env, slug, `${escalate ? "escalating" : "redrawing"} ${d.chapter} page ${d.page}`);
            if (escalate) {
              const esc = await escalateRepairImage(env, slug, bible, d, noSimplifyKeys.has(key));
              return { r: esc.status, log: esc.log };
            }
            return { r: await repairImage(env, slug, bible, d), log: [] as string[] };
          });
          const how = out?.r;
          for (const l of out?.log ?? []) actions.push(l);
          if (how) actions.push(`image: ${d.chapter} page ${d.page} ${how} (${d.kind}${escalate ? ", escalated" : ""})`);
          if (escalate) escalatedKeys.add(key);
          imageDefectsByKey.set(key, d);
          if (how) {
            if (d.kind === "image_flagged") repairedForced.add(key);
          } else {
            imageFailRounds.set(key, fails + 1);
          }
        }

        // 5. cover.
        if (by("cover_missing").length) {
          await step.do(`repair cover round ${round}`, RETRIES, async () => {
            await setStage(env, slug, "generating cover art");
            await repairCover(env, slug, bible);
            actions.push("cover: art generated");
            return true;
          });
        }

        // 6. reassembly when content changed or PDFs are missing.
        const contentChanged = actions.length > 0;
        if (contentChanged || by("pdf_missing").length) {
          await step.do(`repair assemble round ${round}`, RETRIES, async () => {
            await setStage(env, slug, "reassembling PDFs");
            await reassemble(env, slug, bible);
            actions.push("pdfs: reassembled from current pages");
            return true;
          });
        }
      }

      // Post-loop escalation pass: pages that failed 2 rounds and
      // never escalated (the usual shape at maxRounds=2) get their one
      // escalation before the final audit decides the outcome.
      let escalationFixed = false;
      if (!dryRun && lastBible) {
        for (const [key, d] of imageDefectsByKey) {
          if ((imageFailRounds.get(key) ?? 0) < 2 || escalatedKeys.has(key)) continue;
          escalatedKeys.add(key);
          const out = await step.do(`escalate image ${d.chapter} p${d.page}`, RETRIES, async () => {
            await setStage(env, slug, `escalating ${d.chapter} page ${d.page}`);
            const esc = await escalateRepairImage(env, slug, lastBible, d, noSimplifyKeys.has(key));
            return { r: esc.status, log: esc.log };
          });
          const how = out?.r;
          for (const l of out?.log ?? []) actions.push(l);
          if (how) actions.push(`image: ${d.chapter} page ${d.page} ${how} (${d.kind}, escalated)`);
          if (how) {
            escalationFixed = true;
            if (d.kind === "image_flagged") repairedForced.add(key);
          }
        }
        if (escalationFixed) {
          await step.do("repair assemble post-escalation", RETRIES, async () => {
            await setStage(env, slug, "reassembling PDFs after escalation");
            await reassemble(env, slug, lastBible);
            actions.push("pdfs: reassembled after escalation");
            return true;
          });
        }
      }

      // Final audit decides the outcome. Fixes are only real when the
      // audit stops finding them.
      const finalAudit: { defects: Defect[] } = await step.do("audit final", RETRIES, async () =>
        auditBook(env, slug)
      );
      const remaining = finalAudit.defects;
      const summary = remaining.length
        ? remaining.map((d) => `${d.kind}${d.chapter ? " " + d.chapter : ""}${d.page !== undefined ? " p" + d.page : ""}${d.name ? " " + d.name : ""}: ${d.detail}`).join(" | ").slice(0, 380)
        : "";
      await step.do("repair report", RETRIES, async () => {
        await env.DB.prepare(
          "INSERT INTO repair_runs (slug, dry_run, rounds, defects, actions, outcome, created_at) VALUES (?,?,?,?,?,?,?)"
        ).bind(
          slug,
          dryRun ? 1 : 0,
          maxRounds,
          JSON.stringify(lastDefects),
          JSON.stringify(actions),
          dryRun ? "dry_run" : remaining.length ? "escalated" : "clean",
          Math.floor(Date.now() / 1000)
        ).run();
        if (dryRun) {
          await setFinalStage(env, slug, "repair_audited", lastDefects.length ? `${lastDefects.length} defect(s): ${lastDefects.map((d) => d.kind).join(", ")}` : "audit clean");
        } else if (remaining.length) {
          await setFinalStage(env, slug, "repair_failed", `unresolved: ${summary}`);
        } else {
          await setFinalStage(env, slug, "done", actions.length ? `repaired: ${actions.slice(0, 3).join("; ").slice(0, 300)}` : "");
        }
        return true;
      });
      return { slug, dryRun, actions, remaining };
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 400);
      await setFinalStage(env, slug, "repair_failed", msg);
      throw e;
    }
  }
}
