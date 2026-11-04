import { recordWorkflowRun } from "../../packages/core/src/run-provenance";
import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import { planChapter, generateImage, qcImage, ChapterPlan, StoryBible } from "./ai";
import { buildColoringBook, buildPictureBook } from "./pdf";
import { traceToSvg } from "./trace";

interface Params {
  bookSlug: string;
  chapterSlug: string;
  title: string;
  chapterText?: string;
  plan?: ChapterPlan;
  bible?: StoryBible;
  pageCount?: number;
  language?: string;
}

interface Env {
  DB?: D1Database;
  BBS_BUILD_PROVENANCE?: string;
  AI: any;
  BOOKS: R2Bucket;
  KIDSBOOK_WORKFLOW: Workflow;
}

const RETRIES = { limit: 3, delay: "10 seconds", backoff: "exponential" } as const;

export class KidsBookWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    await recordWorkflowRun(this.env, step, event, "chapter", event.payload.bookSlug);
    const p = event.payload;
    const language = p.language ?? "en";
    const pageCount = p.pageCount ?? 4;
    const base = `books/${p.bookSlug}/${p.chapterSlug}`;
    const outBase = `${base}/${language}`;
    const imgBase = `${base}/images`;

    // 1. Plan the chapter, or use a provided plan (e.g. translated via Gemini).
    let plan: ChapterPlan;
    if (p.plan && p.plan.pages && p.plan.pages.length > 0) {
      plan = p.plan;
    } else {
      if (!p.chapterText) throw new Error("chapterText or plan is required");
      const text = p.chapterText.slice(0, 8000);
      plan = await step.do(
        "plan chapter",
        { retries: RETRIES },
        async () => await planChapter(this.env.AI, p.title, text, pageCount, p.bible)
      );
    }
    const wantPages = plan.pages.length;
    const displayTitle = plan.storyTitle || p.title;

    // 2. Generate + QC each page image. Idempotent: reuse stored images so
    // translated runs never regenerate art.
    for (let i = 0; i < wantPages; i++) {
      const key = `${imgBase}/page-${i}.jpg`;
      await step.do(`generate image ${i}`, { retries: RETRIES }, async () => {
        if (await this.env.BOOKS.head(key)) return key;
        let bytes = await generateImage(this.env, plan.pages[i].imagePrompt);
        if (!(await qcImage(this.env.AI, bytes))) {
          bytes = await generateImage(this.env, plan.pages[i].imagePrompt);
        }
        await this.env.BOOKS.put(key, bytes, {
          httpMetadata: { contentType: "image/jpeg" },
        });
        return key;
      });
    }
    const finaleKey = `${imgBase}/finale.jpg`;
    if (plan.finale && plan.finale.imagePrompt) {
      await step.do("generate finale", { retries: RETRIES }, async () => {
        if (await this.env.BOOKS.head(finaleKey)) return finaleKey;
        let bytes = await generateImage(this.env, plan.finale.imagePrompt);
        if (!(await qcImage(this.env.AI, bytes))) {
          bytes = await generateImage(this.env, plan.finale.imagePrompt);
        }
        await this.env.BOOKS.put(finaleKey, bytes, {
          httpMetadata: { contentType: "image/jpeg" },
        });
        return finaleKey;
      });
    }

    // 3. Store the plan. Translations read this instead of regenerating images.
    await step.do("store plan", { retries: RETRIES }, async () => {
      await this.env.BOOKS.put(`${outBase}/plan.json`, JSON.stringify(plan, null, 1), {
        httpMetadata: { contentType: "application/json" },
      });
      return true;
    });

    // 4. Trace each page to an editable SVG.
    for (let i = 0; i < wantPages; i++) {
      const svgKey = `${outBase}/svg/page-${i}.svg`;
      await step.do(`trace svg ${i}`, { retries: RETRIES }, async () => {
        if (await this.env.BOOKS.head(svgKey)) return svgKey;
        const obj = await this.env.BOOKS.get(`${imgBase}/page-${i}.jpg`);
        if (!obj) throw new Error(`missing image ${i}`);
        const svg = traceToSvg(new Uint8Array(await obj.arrayBuffer()));
        await this.env.BOOKS.put(svgKey, svg, {
          httpMetadata: { contentType: "image/svg+xml" },
        });
        return svgKey;
      });
    }

    // 5. Assemble both PDFs.
    const out = await step.do("assemble pdfs", { retries: RETRIES }, async () => {
      const load = async (k: string) => {
        const obj = await this.env.BOOKS.get(k);
        if (!obj) throw new Error(`missing ${k}`);
        return new Uint8Array(await obj.arrayBuffer());
      };
      const images = [];
      for (let i = 0; i < wantPages; i++) images.push(await load(`${imgBase}/page-${i}.jpg`));
      const hasFinale = plan.finale && plan.finale.imagePrompt;
      const finaleImg = hasFinale ? await load(finaleKey) : null;

      const coloring = await buildColoringBook(
        displayTitle,
        plan.pages.map((pg, i) => ({
          image: images[i],
          caption: `${pg.character}: ${pg.concept}`,
        }))
      );
      const picture = await buildPictureBook(
        displayTitle,
        plan.pages.map((pg, i) => ({ image: images[i], story: pg.storyText })),
        hasFinale ? { image: finaleImg, story: plan.finale.storyText } : null
      );

      const coloringKey = `${outBase}/coloring-book.pdf`;
      const pictureKey = `${outBase}/picture-book.pdf`;
      await this.env.BOOKS.put(coloringKey, coloring, {
        httpMetadata: { contentType: "application/pdf" },
      });
      await this.env.BOOKS.put(pictureKey, picture, {
        httpMetadata: { contentType: "application/pdf" },
      });
      return { coloringKey, pictureKey, pages: wantPages, factoryVersion: 5 };
    });

    return out;
  }
}
