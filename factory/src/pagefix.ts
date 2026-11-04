import { recordWorkflowRun } from "../../packages/core/src/run-provenance";
// PageFixWorkflow: redo ONE page of an existing book (line + color)
// with the owner's note as art direction.
//
// This is the factory half of the QC viewer's per-page fix flow (CG,
// 2026-11-02): in the viewer he marks a page bad, types what should
// change, and only that page gets redone and installed back into the
// book. It replaces the legacy /redo-image route for this purpose,
// which predates the cast-resolution fix, had no finale support, no
// recolor, and never saw the note.
//
// Shape rules, all inherited from the pipelines it reuses:
// - The prompt is the page's own planned prompt (scene-built when the
//   plan carries a scene), with the owner's note appended verbatim.
//   Names in a prompt are cast declarations; the owner's note is his
//   direction, so it goes in as written.
// - genImageWithQC owns the rolls (MAX_ROLLS, budget counter, gates,
//   gen_attempts archive). A null return means every roll failed the
//   gates: the live page is left untouched and the plan page is held.
// - The color twin, when the page has one, is regenerated from the
//   NEW line page through the colorize path (genColorizeWithQC).
// - A version snapshot lands before anything is overwritten, and the
//   PDFs + editor chapters are rebuilt at the end.
// - The change_requests row (when the hub passed one) is updated in
//   place: the factory and the hub share one D1.
import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import { anchoredPrompt } from "./ai";
import { linePromptFromScene } from "./gateway";
import {
  BookBuildEnv,
  r2GetJson,
  r2Put,
  genImageWithQC,
  rebuildEditorChapters,
} from "./bookbuild";
import { genColorizeWithQC } from "./colorize";
import { reassembleBasePdfs, reassembleColorPdf } from "./repair";
import { snapshotIfChanged } from "./versioning";
import { normalizeBible } from "./biblegate";
import { emitEvent } from "./events";

export interface PageFixParams {
  slug: string;
  chapter: string; // "S3"
  page: number; // 0-based story page, or -1 for the chapter finale
  note?: string;
  requestId?: string;
}

const RETRIES = { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" } } as const;

async function finishRequest(env: BookBuildEnv, requestId: string | undefined, status: string, result: string): Promise<void> {
  if (!requestId) return;
  try {
    await env.DB.prepare(
      "UPDATE change_requests SET status = ?, result = ?, updated_at = ? WHERE id = ?"
    ).bind(status, result.slice(0, 2000), Date.now(), requestId).run();
  } catch (e: any) {
    console.log(`pagefix: change_requests update failed: ${e?.message ?? e}`);
  }
}

export class PageFixWorkflow extends WorkflowEntrypoint<BookBuildEnv, PageFixParams> {
  async run(event: WorkflowEvent<PageFixParams>, step: WorkflowStep) {
    await recordWorkflowRun(this.env, step, event, "pagefix", event.payload.slug);
    const { slug, chapter, note, requestId } = event.payload;
    let page = event.payload.page;
    const env = this.env;
    if (!slug || !/^S\d+$/.test(chapter || "") || typeof page !== "number") {
      throw new Error("pagefix needs slug, chapter (S<n>) and page");
    }
    try {
      const bible: any = await step.do("load bible", RETRIES, async () => {
        const b = await r2GetJson(env.BOOKS, `books/${slug}/bible.json`);
        if (!b?.conceptLadder?.length) throw new Error(`no bible in R2 for ${slug}`);
        return normalizeBible(b);
      });

      await step.do(
        "version snapshot",
        { retries: { limit: 1, delay: "30 seconds", backoff: "constant" }, timeout: "10 minutes" } as const,
        async () => await snapshotIfChanged(env.BOOKS, slug, "pagefix")
      );

      // Resolve the target: the viewer's page index counts the finale
      // as the chapter's last page (index == pages.length); the plan
      // stores the finale separately (factory page -1).
      const target: any = await step.do("resolve target", RETRIES, async () => {
        const plan = await r2GetJson(env.BOOKS, `books/${slug}/plans/${chapter}.json`);
        if (!plan?.pages?.length) throw new Error(`missing plan for ${chapter}`);
        if (page === plan.pages.length && plan.finale?.imagePrompt) page = -1;
        if (page === -1) {
          if (!plan.finale?.imagePrompt) throw new Error(`${chapter} has no finale to fix`);
          return { isFinale: true, hasColor: !!(plan.finale as any).imageColorKey };
        }
        if (page < 0 || page >= plan.pages.length) throw new Error(`page ${page} out of range for ${chapter}`);
        return { isFinale: false, hasColor: !!plan.pages[page].imageColorKey };
      });
      const isFinale = !!target.isFinale;

      const lineBytes: any = await step.do("redo line page", { ...RETRIES, timeout: "20 minutes" } as const, async () => {
        const plan = await r2GetJson(env.BOOKS, `books/${slug}/plans/${chapter}.json`);
        const pg = isFinale ? plan.finale : plan.pages[page];
        const scene = pg.scene;
        let promptText = scene?.cast?.length
          ? linePromptFromScene(scene, bible)
          : isFinale
            ? String(pg.imagePrompt || "")
            : anchoredPrompt(pg.imagePrompt, pg.character, bible);
        if (note && note.trim()) {
          promptText += `\n\nDirector's note from the book's owner: ${note.trim()}`;
        }
        const bytes = await genImageWithQC(
          env, slug, promptText,
          isFinale ? undefined : pg.character,
          { chapter, page: isFinale ? -1 : page },
          pg.storyText, scene
        );
        if (!bytes) {
          // Every roll failed the gates: the live page stays exactly
          // as it was (it is previously approved art), so the plan is
          // NOT held. The failure record lives in gen_attempts and in
          // the change_requests row this workflow writes back.
          return null;
        }
        const key = `books/${slug}/images/${chapter}-${isFinale ? "finale" : `page-${page}`}.jpg`;
        await env.BOOKS.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
        if (isFinale) {
          delete (plan.finale as any).held;
          delete (plan.finale as any).heldReason;
          (plan.finale as any).imageKey = key;
        } else {
          delete plan.pages[page].held;
          delete plan.pages[page].heldReason;
          plan.pages[page].imageKey = key;
        }
        await r2Put(env.BOOKS, `books/${slug}/plans/${chapter}.json`, JSON.stringify(plan, null, 1), "application/json");
        return bytes;
      });

      if (!lineBytes) {
        await finishRequest(env, requestId, "failed", "line rolls failed the gates; the live page was kept as-is");
        await emitEvent(env, { slug, kind: "pagefix", stage: "page_fix", event: "page_fix_held", detail: `${chapter} page ${page}: line held` });
        return { slug, chapter, page, outcome: "line-held" };
      }

      let colorOutcome = "no-color-twin";
      if (target.hasColor) {
        colorOutcome = await step.do("redo color page", { ...RETRIES, timeout: "20 minutes" } as const, async () => {
          const plan = await r2GetJson(env.BOOKS, `books/${slug}/plans/${chapter}.json`);
          const pg = isFinale ? plan.finale : plan.pages[page];
          const res = await genColorizeWithQC(
            env, slug, lineBytes, pg.character ?? "", pg.storyText,
            { chapter, page: isFinale ? -1 : page },
            { ...(pg.scene ?? {}), imagePrompt: pg.imagePrompt }
          );
          if (res.status !== "ok") {
            if (res.status === "held") {
              (pg as any).colorHeld = true;
              await r2Put(env.BOOKS, `books/${slug}/plans/${chapter}.json`, JSON.stringify(plan, null, 1), "application/json");
            }
            return res.status === "held" ? "color-held" : "color-unavailable";
          }
          const ckey = `books/${slug}/images-color/${chapter}-${isFinale ? "finale" : `page-${page}`}.jpg`;
          await env.BOOKS.put(ckey, res.bytes, { httpMetadata: { contentType: "image/png" } });
          delete (pg as any).colorHeld;
          (pg as any).imageColorKey = ckey;
          await r2Put(env.BOOKS, `books/${slug}/plans/${chapter}.json`, JSON.stringify(plan, null, 1), "application/json");
          return "colored";
        });
      }

      await step.do("reassemble", { ...RETRIES, timeout: "20 minutes" } as const, async () => {
        await rebuildEditorChapters(env, slug);
        await reassembleBasePdfs(env, slug);
        if (target.hasColor) await reassembleColorPdf(env, slug);
        return true;
      });

      const summary = colorOutcome === "colored"
        ? "page redone (line + color) and installed"
        : colorOutcome === "no-color-twin"
          ? "page redone (line) and installed"
          : `line page redone and installed; color ${colorOutcome.replace("color-", "")}`;
      await finishRequest(env, requestId, "done", summary);
      await emitEvent(env, { slug, kind: "pagefix", stage: "page_fix", event: "page_fix_done", detail: `${chapter} page ${page}: ${summary}` });
      return { slug, chapter, page, outcome: summary };
    } catch (e: any) {
      await finishRequest(env, requestId, "failed", `page fix error: ${e?.message ?? e}`);
      throw e;
    }
  }
}
