// RegenWorkflow: durable chapter regeneration for an EXISTING book.
//
// BookBuildWorkflow refuses books that already exist (and docker outright);
// this workflow is the other half of the factory: it re-plans and/or
// re-renders selected chapters of a book that already has a bible in R2,
// then reassembles the PDFs and the editor data. It is what runs when the
// owner requests changes in the admin reader (the factory cron turns queued
// change_requests into regen instances), so the factory improves books on
// its own without a human babysitting a local script.
//
// Idempotent like the build: existing plans/images are reused unless
// force is set, every chapter is its own workflow step (checkpointed,
// retried by the platform), and a chapter whose plan fails the critic is
// recorded and skipped rather than killing the whole run.
import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import { planChapterAttempt } from "./planv3";
import { anchoredPrompt } from "./ai";
import { buildColoringBook, buildPictureBook } from "./pdf";
import { composeMatter, ensureBackCoverImages, BACK_COVER_COLOR_KEY, BACK_COVER_LINE_KEY } from "./matter";
import {
  BookBuildEnv,
  r2GetJson,
  r2Put,
  r2GetBytes,
  r2ListAll,
  genImageWithQC,
  genPictureColorWithQC,
  rebuildEditorChapters,
  beginRun,
  heldPages,
  coloringCaption,
} from "./bookbuild";
import { emitEvent } from "./events";
import { gatewayConfigured, linePromptFromScene } from "./gateway";
import { cropsCoverage } from "./crops";
import { snapshotIfChanged } from "./versioning";
import { toPdfJpeg } from "./transcode";
import { normalizeBible } from "./biblegate";

export interface RegenParams {
  slug: string;
  chapters: string[]; // ["S6", "S10", ...]
  mode?: "both" | "plan" | "images";
  force?: boolean;
  requestIds?: number[];
}

const RETRIES = { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" } } as const;

async function setStage(env: BookBuildEnv, slug: string, detail = ""): Promise<void> {
  try {
    await env.DB.prepare("UPDATE books SET stage='regen', stage_detail=?, updated_at=? WHERE slug=?")
      .bind(detail, Math.floor(Date.now() / 1000), slug)
      .run();
    await emitEvent(env, { slug, kind: "stage", stage: "regen", event: "stage_changed", detail });
  } catch (e: any) {
    console.log(`regen setStage failed: ${e?.message ?? e}`);
  }
}

function chNum(ch: string): number {
  return parseInt(ch.replace(/\D/g, ""), 10) || 0;
}

export class RegenWorkflow extends WorkflowEntrypoint<BookBuildEnv, RegenParams> {
  async run(event: WorkflowEvent<RegenParams>, step: WorkflowStep) {
    const { slug } = event.payload;
    const mode = event.payload.mode ?? "both";
    const force = event.payload.force ?? false;
    const chapters = [...(event.payload.chapters ?? [])].sort((a, b) => chNum(a) - chNum(b));
    if (!slug || !chapters.length) throw new Error("regen needs slug and chapters");
    const env = this.env;
    try {
      const bible: any = await step.do("load bible", RETRIES, async () => {
        const b = await r2GetJson(env.BOOKS, `books/${slug}/bible.json`);
        if (!b?.conceptLadder?.length) throw new Error(`no bible in R2 for ${slug}`);
        // Same canonical shape the build pipeline guarantees: generated
        // bibles carry protagonist/supportingCast + a metaphorBank, and
        // the planner reads characters[] + inline metaphors.
        return normalizeBible(b);
      });

      // Archive the current artifacts before regen overwrites any of
      // them. No-op when nothing changed since the last snapshot.
      await step.do(
        "version snapshot",
        { retries: { limit: 1, delay: "30 seconds", backoff: "constant" }, timeout: "10 minutes" } as const,
        async () => await snapshotIfChanged(env.BOOKS, slug, "regen")
      );

      await step.do("begin run", RETRIES, async () => {
        await beginRun(env, slug);
        return true;
      });

      // ---- ladder pre-flight -----------------------------------------
      // A chapter with no ladder entry cannot be planned, and the old
      // behavior (flag it per chapter, then "complete" over the old
      // pages) shipped a half-rebuilt book as done: Docker S4-S18,
      // 2026-10-25, whose bible ladder stopped at S3. Planning modes
      // now refuse up front and point at the repair workflow, which is
      // the one place bible defects get fixed.
      if (mode !== "images") {
        const ladderChapters = new Set(
          (bible.conceptLadder ?? []).map((e: any) => String(e?.storyChapter ?? e?.chapter ?? ""))
        );
        const unladdered = chapters.filter((ch) => !ladderChapters.has(ch));
        if (unladdered.length) {
          const detail = `needs bible repair: no ladder entry for ${unladdered.join(", ")} (run the repair workflow)`;
          await env.DB.prepare("UPDATE books SET stage='needs_repair', stage_detail=?, updated_at=? WHERE slug=?")
            .bind(detail, Math.floor(Date.now() / 1000), slug)
            .run();
          return { slug, chapters, counts: {}, failures: [detail] };
        }
      }

      // ---- crops gate ------------------------------------------------
      // Same opt-in coverage rule as the build (Phase 2): image modes
      // refuse to draw for a crops-opted-in book until every bible
      // character has a pose tag. Planning alone is not gated.
      if (mode !== "plan") {
        const cov = await step.do("crops gate", RETRIES, async () => cropsCoverage(env, slug, bible));
        if (cov?.hasManifest && cov.untagged.length) {
          const detail = `crops gate: no pose tags yet for ${cov.untagged.join(", ")}; tag every character in Crop Mode before art proceeds`;
          await env.DB.prepare("UPDATE books SET stage='needs_review', stage_detail=?, updated_at=? WHERE slug=?")
            .bind(detail, Math.floor(Date.now() / 1000), slug)
            .run();
          return { slug, chapters, counts: {}, failures: [detail] };
        }
      }

      const failures: string[] = [];
      let usedTitledCover = false;
      const planState = new Map<string, { fresh: boolean; failed: boolean }>();

      // ---- plan -----------------------------------------------------
      // One workflow step per attempt: a full 3-attempt loop in a single
      // step can exceed the 10-minute step timeout while the model chain
      // rides out rate limits (that is what killed the first regen run).
      const PLAN_STEP = { retries: { limit: 1, delay: "10 seconds", backoff: "constant" }, timeout: "8 minutes" } as const;
      if (mode !== "images") {
        for (const ch of chapters) {
          await setStage(env, slug, `plan ${ch}`);
          let notes = "";
          let state: { fresh: boolean; failed: boolean; reason?: string } = { fresh: false, failed: false };
          for (let a = 1; a <= 5; a++) {
            let r: any;
            try {
              r = await step.do(`regen plan ${ch} a${a}`, PLAN_STEP, async () => {
              const key = `books/${slug}/plans/${ch}.json`;
              if (a === 1) {
                const existing = await r2GetJson(env.BOOKS, key);
                if (existing?.pages?.length && !force) return { done: true, fresh: false };
              }
              const prevPlans: any[] = [];
              for (let i = 1; i < chNum(ch); i++) {
                const p = await r2GetJson(env.BOOKS, `books/${slug}/plans/S${i}.json`);
                if (p?.pages?.length) prevPlans.push(p);
              }
              const prev = prevPlans[prevPlans.length - 1];
              const att = await planChapterAttempt(
                env, bible, ch,
                prev?.newStorySoFar ?? "", prev?.hook ?? "", notes, prevPlans, slug
              );
              if (!att.passed) {
                // Keep the rejected draft: without it, critic failures
                // are invisible and the same argument loops for hours.
                await r2Put(env.BOOKS, `books/${slug}/rejected/${ch}-a${a}.json`, JSON.stringify(att.plan, null, 1), "application/json");
                return { done: false, notes: att.notes };
              }
              att.plan.storyChapter = ch;
              att.plan._v3_attempts = a;
              att.plan._model = att.model;
              await r2Put(env.BOOKS, key, JSON.stringify(att.plan, null, 1), "application/json");
              return { done: true, fresh: true };
              });
            } catch (e: any) {
              // A step that dies (timeout, hung model call) costs ONE
              // attempt, never the whole run: 2026-10-22 run 3 lost two
              // hours and the workflow when S14's plan step timed out.
              r = { done: false, notes: `planner step error: ${e?.message ?? e}` };
            }
            if (r.done) {
              state = { fresh: !!r.fresh, failed: false };
              break;
            }
            notes = r.notes ?? "";
            if (a === 5) state = { fresh: false, failed: true, reason: notes.slice(0, 200) };
          }
          planState.set(ch, state);
          if (state.failed) failures.push(`${ch} plan: ${state.reason ?? "critic"}`);
        }
      }

      // ---- images ---------------------------------------------------
      // One step per page image, same timeout reasoning as planning.
      if (mode !== "plan") {
        for (const ch of chapters) {
          const st = planState.get(ch);
          if (st?.failed) continue; // no trustworthy plan to draw from
          await setStage(env, slug, `images ${ch}`);
          const planHead: any = await step.do(`regen img ${ch} head`, RETRIES, async () => {
            const plan = await r2GetJson(env.BOOKS, `books/${slug}/plans/${ch}.json`);
            if (!plan?.pages?.length) throw new Error(`missing plan for ${ch}`);
            return {
              pages: plan.pages.length,
              hasFinale: !!plan.finale?.imagePrompt,
              fresh: !!(force || st?.fresh),
            };
          });
          for (let pi = 0; pi < planHead.pages; pi++) {
            await step.do(`regen img ${ch} p${pi}`, RETRIES, async () => {
              const key = `books/${slug}/plans/${ch}.json`;
              const plan = await r2GetJson(env.BOOKS, key);
              const ikey = `books/${slug}/images/${ch}-page-${pi}.jpg`;
              if (planHead.fresh || !(await env.BOOKS.head(ikey))) {
                const scene = plan.pages[pi].scene;
                const bytes = await genImageWithQC(
                  env, slug,
                  scene?.cast?.length ? linePromptFromScene(scene, bible) : anchoredPrompt(plan.pages[pi].imagePrompt, plan.pages[pi].character, bible),
                  plan.pages[pi].character,
                  { chapter: ch, page: pi },
                  plan.pages[pi].storyText,
                  scene
                );
                if (!bytes) {
                  plan.pages[pi].held = true;
                  plan.pages[pi].heldReason = "regen redraw held; see gen_events";
                  await r2Put(env.BOOKS, key, JSON.stringify(plan, null, 1), "application/json");
                  return;
                }
                await env.BOOKS.put(ikey, bytes, { httpMetadata: { contentType: "image/jpeg" } });
                if (plan.pages[pi].held) {
                  delete plan.pages[pi].held;
                  delete plan.pages[pi].heldReason;
                  plan.pages[pi].imageKey = ikey;
                  await r2Put(env.BOOKS, key, JSON.stringify(plan, null, 1), "application/json");
                  return;
                }
              }
              if (plan.pages[pi].imageKey !== ikey) {
                plan.pages[pi].imageKey = ikey;
                await r2Put(env.BOOKS, key, JSON.stringify(plan, null, 1), "application/json");
              }
            });
            // No color twins in regen either (factory reset,
            // 2026-10-24): line art only; Colorize is its own process.
          }
          if (planHead.hasFinale) {
            await step.do(`regen img ${ch} finale`, RETRIES, async () => {
              const key = `books/${slug}/plans/${ch}.json`;
              const plan = await r2GetJson(env.BOOKS, key);
              const fkey = `books/${slug}/images/${ch}-finale.jpg`;
              if (planHead.fresh || !(await env.BOOKS.head(fkey))) {
                const fscene = plan.finale.scene;
                const bytes = await genImageWithQC(env, slug, fscene?.cast?.length ? linePromptFromScene(fscene, bible) : plan.finale.imagePrompt, undefined, { chapter: ch, page: -1 }, plan.finale.storyText, fscene);
                if (!bytes) {
                  (plan.finale as any).held = true;
                  (plan.finale as any).heldReason = "regen redraw held; see gen_events";
                  await r2Put(env.BOOKS, key, JSON.stringify(plan, null, 1), "application/json");
                  return;
                }
                await env.BOOKS.put(fkey, bytes, { httpMetadata: { contentType: "image/jpeg" } });
                if ((plan.finale as any).held) {
                  delete (plan.finale as any).held;
                  delete (plan.finale as any).heldReason;
                  (plan.finale as any).imageKey = fkey;
                  await r2Put(env.BOOKS, key, JSON.stringify(plan, null, 1), "application/json");
                  return;
                }
              }
              if ((plan.finale as any).imageKey !== fkey) {
                (plan.finale as any).imageKey = fkey;
                await r2Put(env.BOOKS, key, JSON.stringify(plan, null, 1), "application/json");
              }
            });
          }
        }
      }

      // ---- back covers (generate once, reuse forever) ---------------
      await step.do("regen back-cover", RETRIES, async () => {
        await setStage(env, slug, "back cover");
        const imgs = await ensureBackCoverImages(env, slug, bible);
        return { color: !!imgs.color, line: !!imgs.line };
      });

      // ---- assemble (always: text changes alone alter the PDFs) -----
      const counts: any = await step.do("regen assemble", RETRIES, async () => {
        await setStage(env, slug, "assemble");
        const keys = (await r2ListAll(env.BOOKS, `books/${slug}/plans/`))
          .filter((k) => /\/plans\/S\d+\.json$/.test(k))
          .sort((a, b) => chNum(a) - chNum(b));
        // No-ship rule: held pages block reassembly.
        const held = await heldPages(env, slug, keys.length, "line");
        if (held.length) throw new Error(`held pages need review: ${held.join(", ")}`);
        const toc: string[] = [];
        const storyPages: { image: Uint8Array; story: string }[] = [];
        const coloringPages: { image: Uint8Array; caption: string }[] = [];
        for (const key of keys) {
          const ch = key.match(/\/plans\/(S\d+)\.json$/)![1];
          const plan = await r2GetJson(env.BOOKS, key);
          if (!plan?.pages?.length) continue;
          toc.push(plan.storyTitle ?? ch);
          for (let pi = 0; pi < plan.pages.length; pi++) {
            const lineImg = await r2GetBytes(env.BOOKS, `books/${slug}/images/${ch}-page-${pi}.jpg`);
            if (!lineImg) continue;
            const pg = plan.pages[pi];
            coloringPages.push({ image: lineImg, caption: coloringCaption(pg) });
            // Line art only in the base books (factory reset,
            // 2026-10-24); color twins never leak into the storybook.
            storyPages.push({ image: await toPdfJpeg(lineImg), story: pg.storyText ?? "" });
          }
          const fimg = await r2GetBytes(env.BOOKS, `books/${slug}/images/${ch}-finale.jpg`);
          if (fimg && plan.finale?.storyText) {
            storyPages.push({ image: await toPdfJpeg(fimg), story: plan.finale.storyText });
          }
        }
        if (!storyPages.length) throw new Error("no page images to assemble");
        const title = bible.bookTitle ?? slug;
        const backImage = await r2GetBytes(env.BOOKS, BACK_COVER_COLOR_KEY(slug));
        const backLineImage = await r2GetBytes(env.BOOKS, BACK_COVER_LINE_KEY(slug));
        const matter = { ...composeMatter(bible), backImage, backLineImage };
        const rawCover = await r2GetBytes(env.BOOKS, `books/${slug}/cover.jpg`);
        const titledCover = await r2GetBytes(env.BOOKS, `books/${slug}/cover-titled.jpg`);
        usedTitledCover = !!titledCover;
        const coloring = await buildColoringBook(title, coloringPages, toc, matter, rawCover, titledCover);
        await r2Put(env.BOOKS, `books/${slug}/coloring-book.pdf`, coloring, "application/pdf");
        const picture = await buildPictureBook(title, storyPages, null, toc, matter, rawCover, titledCover);
        await r2Put(env.BOOKS, `books/${slug}/picture-book.pdf`, picture, "application/pdf");
        return { storyPages: storyPages.length, coloringPages: coloringPages.length, chapters: toc.length };
      });

      // ---- register --------------------------------------------------
      await step.do("regen register", RETRIES, async () => {
        await rebuildEditorChapters(env, slug);
        const now = Math.floor(Date.now() / 1000);
        const detail = failures.length ? `regen done with flags: ${failures.join(" | ").slice(0, 400)}` : "";
        await env.DB.prepare("UPDATE books SET stage='done', stage_detail=?, updated_at=? WHERE slug=?")
          .bind(detail, now, slug)
          .run();
        // Assembly QA for the hub's delivery-readiness panel: the
        // composer records what it did (2026-10-31). Captions and
        // back cover are clean by construction; the cover flag
        // records whether the finished titled cover was used.
        // Best-effort: QA bookkeeping never fails a build.
        try {
          await env.DB.prepare(
            "INSERT OR REPLACE INTO book_qa (slug, cover_typeset, coloring_captions_truncated, back_cover_truncated, source, measured_at) VALUES (?, ?, 0, 0, 'factory regen assembly', ?)"
          )
            .bind(slug, usedTitledCover ? 0 : 1, now)
            .run();
        } catch { /* book_qa is created by the hub; absence is not a build failure */ }
        const ids = event.payload.requestIds ?? [];
        if (ids.length) {
          const marks = ids.map(() => "?").join(",");
          await env.DB.prepare(
            `UPDATE change_requests SET status='done', result='regenerated by factory workflow', updated_at=? WHERE id IN (${marks})`
          )
            .bind(now, ...ids)
            .run();
        }
      });

      return { slug, chapters, counts, failures };
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 400);
      try {
        await env.DB.prepare("UPDATE books SET stage='regen_failed', stage_detail=?, updated_at=? WHERE slug=?")
          .bind(msg, Math.floor(Date.now() / 1000), slug)
          .run();
      } catch { /* best effort */ }
      throw e;
    }
  }
}
