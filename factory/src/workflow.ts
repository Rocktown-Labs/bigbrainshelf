import { recordWorkflowRun } from "../../packages/core/src/run-provenance";
import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import type { ChapterPlan, StoryBible } from "./ai";

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

export class KidsBookWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    await recordWorkflowRun(this.env, step, event, "chapter", event.payload.bookSlug);
    throw new Error("Legacy chapter workflow cannot verify the canonical book revision. Use BookBuildWorkflow with stored bible and plans; no generation or assembly performed.");
  }
}
