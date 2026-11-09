import { KidsBookWorkflow } from "./workflow";
import { BookBuildWorkflow } from "./bookbuild";
import { RegenWorkflow } from "./regen";
import { ColorizeWorkflow } from "./colorize";
import { PageFixWorkflow } from "./pagefix";
import { RepairWorkflow, ReassembleWorkflow } from "./repair";
import { generateImage, qcImage, sheetKeyFor, anchoredPrompt } from "./ai";
import { callModel } from "./models";
import { rebuildEditorChapters, ensureRunCols } from "./bookbuild";
import { ensureBackCoverImages } from "./matter";
import { validateBible, normalizeBible, lintWorldInventory } from "./biblegate";
import { runReadPass } from "./readpass";
import { checkSourceDuplicate, duplicateMessage } from "./sourceguard";
import { snapshotIfChanged } from "./versioning";
import { gatewayConfigured, generateGatewayImage } from "./gateway";
import { BudgetCoordinator, budgetAdmin } from "./budget";
import { enqueueAppeals, handleAppealsBatch } from "./appeals";
import { runVisualPass } from "./visualpass";
import { recordEdition, standardArtifacts } from "./editions";
import { emitBudgetMetric } from "./metrics";

export { KidsBookWorkflow, BookBuildWorkflow, RegenWorkflow, ColorizeWorkflow, RepairWorkflow, ReassembleWorkflow, PageFixWorkflow, BudgetCoordinator };

interface Env {
  AI: any;
  BOOKS: R2Bucket;
  KIDSBOOK_WORKFLOW: Workflow;
  BOOKBUILD_WORKFLOW: Workflow;
  REGEN_WORKFLOW: Workflow;
  COLORIZE_WORKFLOW: Workflow;
  REPAIR_WORKFLOW: Workflow;
  REASSEMBLE_WORKFLOW: Workflow;
  PAGEFIX_WORKFLOW: Workflow;
  DB: D1Database;
  BUDGET?: DurableObjectNamespace;
  METRICS?: any;
  APPEALS?: Queue;
  PLANNER_ORDER?: string;
  GEMINI_API_KEY?: string;
  AI_GATEWAY_KEY?: string;
  AI_GATEWAY_IMAGE_MODEL?: string;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function r2GetJson(BOOKS: R2Bucket, key: string): Promise<any | null> {
  const o = await BOOKS.get(key);
  if (!o) return null;
  return JSON.parse(await o.text());
}

async function r2PutJson(BOOKS: R2Bucket, key: string, data: any): Promise<void> {
  await BOOKS.put(key, JSON.stringify(data, null, 1), {
    httpMetadata: { contentType: "application/json" },
  });
}

function ladderFor(bible: any, chapter: string): any {
  // Bible ladder entries key on 'storyChapter' ("S4"). The old lookup read a
  // 'chapter' field that does not exist, so '' matched the FIRST entry and
  // every chapter was treated as S1.
  return (bible.conceptLadder ?? []).find(
    (c: any) => (c.storyChapter ?? c.chapter ?? "") === chapter
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ---- legacy per-chapter build ----------------------------------
    if (request.method === "POST" && url.pathname === "/build") {
      let body: any;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid JSON" }, { status: 400 });
      }
      if (!body.title || (!body.chapterText && !body.plan)) {
        return Response.json(
          { error: "title and chapterText (or plan) are required" },
          { status: 400 }
        );
      }
      const pageCount = Math.min(Math.max(body.pageCount ?? 4, 2), 10);
      const bookSlug = body.bookSlug ? slugify(String(body.bookSlug)) : slugify(String(body.title));
      const chapterSlug = body.chapterSlug
        ? slugify(String(body.chapterSlug))
        : "chapter";
      const language = String(body.language ?? "en").toLowerCase();
      const instance = await env.KIDSBOOK_WORKFLOW.create({
        params: {
          bookSlug,
          chapterSlug,
          title: String(body.title),
          chapterText: body.chapterText ? String(body.chapterText) : undefined,
          plan: body.plan,
          bible: body.bible,
          pageCount,
          language,
        },
      });
      return Response.json({
        instanceId: instance.id,
        status: "/status?instanceId=" + instance.id,
      });
    }

    if (url.pathname === "/status") {
      const id = url.searchParams.get("instanceId");
      if (!id) return Response.json({ error: "instanceId required" }, { status: 400 });
      const instance = await env.KIDSBOOK_WORKFLOW.get(id);
      return Response.json(await instance.status());
    }

    // ---- full-book build ------------------------------------------
    if (request.method === "POST" && url.pathname === "/book/build") {
      let body: any;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid JSON" }, { status: 400 });
      }
      const slug = slugify(String(body?.slug ?? ""));
      if (!slug) return Response.json({ error: "slug required" }, { status: 400 });
      // Source dedup guard (CG, 2026-10-28): one source book, one
      // adaptation, ever. When the intake already knows the source
      // (explicit body fields or a pre-uploaded book_info.json), refuse
      // a duplicate here, before any row or workflow exists. The
      // BookBuildWorkflow re-checks after its bookinfo step, when the
      // title is always known, so an intake that arrives unidentified
      // is still caught before bible/planning/image spend.
      try {
        const preInfo = await r2GetJson(env.BOOKS, `books/${slug}/book_info.json`);
        const candidates = [body?.sourceTitle, body?.title, preInfo?.sourceTitle, preInfo?.title]
          .filter((x: any) => typeof x === "string" && x.trim());
        for (const c of candidates as string[]) {
          const m = await checkSourceDuplicate(env, c, { excludeSlug: slug });
          if (m.duplicate) {
            const msg = duplicateMessage(c, m);
            console.log(`source guard: REFUSED build for '${slug}': ${msg}`);
            return Response.json(
              { error: msg, duplicateOf: m.matchedSlug, confidence: m.confidence },
              { status: 409 }
            );
          }
        }
      } catch (e: any) {
        console.log(`source guard: intake check failed for '${slug}' (${e?.message ?? e}); the workflow guard still applies`);
      }
      // The old hard refusal to build over books/docker died with the
      // 2026-10-24 reset: v1 was scrapped by the owner and versioning
      // snapshots protect prior artifacts on every build.
      const now = Math.floor(Date.now() / 1000);
      const existing: any = await env.DB.prepare("SELECT id FROM books WHERE slug=?")
        .bind(slug)
        .first();
      if (!existing) {
        await env.DB.prepare(
          "INSERT INTO books (id, slug, title, status, stage, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
        )
          .bind(crypto.randomUUID(), slug, slug, "building", "extract", now, now)
          .run();
      } else {
        await env.DB.prepare(
          "UPDATE books SET status='building', stage='extract', stage_detail='', updated_at=? WHERE slug=?"
        )
          .bind(now, slug)
          .run();
      }
      const instance = await env.BOOKBUILD_WORKFLOW.create({ params: { slug } });
      return Response.json({ instanceId: instance.id });
    }

    // ---- colorize (async color edition) ------------------------------
    {
      const m = url.pathname.match(/^\/book\/([^/]+)\/colorize$/);
      if (request.method === "POST" && m) {
        const slug = decodeURIComponent(m[1]);
        let body: any = {};
        try {
          body = await request.json();
        } catch { /* force is optional */ }
        const row: any = await env.DB.prepare("SELECT slug FROM books WHERE slug=?")
          .bind(slug)
          .first();
        if (!row) return Response.json({ error: "book not found" }, { status: 404 });
        const instance = await env.COLORIZE_WORKFLOW.create({
          params: { slug, force: !!body?.force },
        });
        return Response.json({ instanceId: instance.id, slug });
      }
    }

    // ---- delete a book entirely --------------------------------------
    {
      const m = url.pathname.match(/^\/book\/([^/]+)\/delete$/);
      if (request.method === "POST" && m) {
        const slug = decodeURIComponent(m[1]);
        const row: any = await env.DB.prepare("SELECT id, status FROM books WHERE slug=?")
          .bind(slug)
          .first();
        if (!row) return Response.json({ error: "book not found" }, { status: 404 });
        if (row.status === "building" || row.status === "queued")
          return Response.json(
            { error: "book is building; let it finish before deleting" },
            { status: 409 }
          );
        // R2: every object under books/{slug}/
        let cursor: string | undefined;
        let files = 0;
        do {
          const page: any = await env.BOOKS.list({
            prefix: `books/${slug}/`,
            cursor,
            limit: 1000,
          });
          if (page.objects.length) {
            await env.BOOKS.delete(page.objects.map((o: any) => o.key));
            files += page.objects.length;
          }
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        // D1: the book row plus every slug-keyed child table. Orders
        // (purchase history) and the shared character registry stay.
        await env.DB.batch([
          env.DB.prepare("DELETE FROM chapters WHERE book_id=?").bind(row.id),
          env.DB.prepare("DELETE FROM bibles WHERE book_slug=?").bind(slug),
          env.DB.prepare("DELETE FROM change_requests WHERE book_slug=?").bind(slug),
          env.DB.prepare("DELETE FROM page_approvals WHERE book_slug=?").bind(slug),
          env.DB.prepare("DELETE FROM page_layouts WHERE book_slug=?").bind(slug),
          env.DB.prepare("DELETE FROM book_settings WHERE book_slug=?").bind(slug),
          env.DB.prepare("DELETE FROM generation_jobs WHERE book_slug=?").bind(slug),
          env.DB.prepare("DELETE FROM video_jobs WHERE book_slug=?").bind(slug),
          env.DB.prepare("DELETE FROM books WHERE slug=?").bind(slug),
        ]);
        return Response.json({ deleted: slug, files });
      }
    }

    // ---- book build status -----------------------------------------
    {
      const m = url.pathname.match(/^\/book\/([^/]+)\/status$/);
      if (request.method === "GET" && m) {
        const slug = decodeURIComponent(m[1]);
        const row: any = await env.DB.prepare(
          "SELECT status, stage, stage_detail FROM books WHERE slug=?"
        )
          .bind(slug)
          .first();
        if (!row) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json({
          status: row.status,
          stage: row.stage ?? null,
          stage_detail: row.stage_detail ?? null,
        });
      }
    }

    // ---- redo text (one page) ---------------------------------------
    {
      const m = url.pathname.match(/^\/book\/([^/]+)\/redo-text$/);
      if (request.method === "POST" && m) {
        const slug = decodeURIComponent(m[1]);
        if (!slug || slug === "docker")
          return Response.json({ error: "invalid slug" }, { status: 400 });
        let body: any;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid JSON" }, { status: 400 });
        }
        const chapter = String(body.chapter ?? "");
        const pageIdx = Number(body.page);
        if (!/^S\d+$/.test(chapter) || !Number.isInteger(pageIdx) || pageIdx < 0)
          return Response.json({ error: "chapter (S#) and page (0-based index) required" }, { status: 400 });

        const bible = await r2GetJson(env.BOOKS, `books/${slug}/bible.json`);
        const plan = await r2GetJson(env.BOOKS, `books/${slug}/plans/${chapter}.json`);
        if (!bible || !plan)
          return Response.json({ error: "bible or plan not found for this book" }, { status: 404 });
        const pg = plan.pages?.[pageIdx];
        if (!pg) return Response.json({ error: "page not found" }, { status: 400 });

        const ladder = ladderFor(bible, chapter) ?? {};
        const chars = (bible.characters ?? []).map((c: any) => `${c.name} (${c.visual})`).join("; ");
        // story-so-far from previous chapter for continuity
        let storySoFar = "";
        const chNum = parseInt(chapter.slice(1), 10);
        if (chNum > 1) {
          const prev = await r2GetJson(env.BOOKS, `books/${slug}/plans/S${chNum - 1}.json`);
          storySoFar = prev?.newStorySoFar ?? "";
        }
        const prevText = pageIdx > 0 ? plan.pages[pageIdx - 1].storyText : "(first page of chapter)";
        const nextText =
          pageIdx < plan.pages.length - 1 ? plan.pages[pageIdx + 1].storyText : "(last page of chapter)";

        const prompt =
          "You are an expert children's book author rewriting ONE page of a kids' storybook (ages 4-8).\n" +
          `Book: ${bible.bookTitle ?? ""}. Characters: ${chars}. Setting: ${bible.setting ?? ""}.\n` +
          `This is chapter "${plan.storyTitle ?? chapter}" (chapter ${chNum}), page ${pageIdx + 1} of ${plan.pages.length}.\n` +
          `The chapter teaches: ${ladder.idea ?? ""}\n` +
          `This page's concept: ${pg.concept ?? ""}. Character on this page: ${pg.character ?? ""}.\n` +
          `The scene (do NOT change what happens visually): ${pg.imagePrompt ?? ""}\n` +
          (storySoFar ? `Story so far: ${storySoFar}\n` : "") +
          `Previous page's text: ${prevText}\n` +
          `Next page's text: ${nextText}\n\n` +
          "Write 2-4 simple read-aloud sentences for THIS page only. They must teach the page's " +
          "concept, fit naturally between the neighboring pages, and use simple words a 5-year-old " +
          "understands. No em dashes.\n" +
          'Reply with ONLY JSON: {"storyText": "..."}';

        let storyText = "";
        for (let attempt = 0; attempt < 2 && !storyText; attempt++) {
          try {
            const { data } = await callModel(env, prompt, 2048, "writer", { slug, purpose: "redo-text" });
            const t = String(data.storyText ?? "").trim();
            if (t.length >= 20 && t.length < 2000) storyText = t;
          } catch (e: any) {
            console.log(`redo-text attempt ${attempt + 1} failed: ${e?.message ?? e}`);
          }
        }
        if (!storyText)
          return Response.json({ error: "text regeneration failed" }, { status: 502 });

        plan.pages[pageIdx].storyText = storyText;
        await r2PutJson(env.BOOKS, `books/${slug}/plans/${chapter}.json`, plan);
        await rebuildEditorChapters(
          { AI: env.AI, BOOKS: env.BOOKS, DB: env.DB } as any,
          slug
        );
        return Response.json({ text: storyText });
      }
    }

    // ---- redo image (one page) ---------------------------------------
    {
      const m = url.pathname.match(/^\/book\/([^/]+)\/redo-image$/);
      if (request.method === "POST" && m) {
        const slug = decodeURIComponent(m[1]);
        if (!slug || slug === "docker")
          return Response.json({ error: "invalid slug" }, { status: 400 });
        let body: any;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid JSON" }, { status: 400 });
        }
        const chapter = String(body.chapter ?? "");
        const pageIdx = Number(body.page);
        if (!/^S\d+$/.test(chapter) || !Number.isInteger(pageIdx) || pageIdx < 0)
          return Response.json({ error: "chapter (S#) and page (0-based index) required" }, { status: 400 });

        const plan = await r2GetJson(env.BOOKS, `books/${slug}/plans/${chapter}.json`);
        if (!plan) return Response.json({ error: "plan not found for this book" }, { status: 404 });
        const pg = plan.pages?.[pageIdx];
        if (!pg?.imagePrompt)
          return Response.json({ error: "page or imagePrompt not found" }, { status: 400 });

        let sheet: Uint8Array | null = null;
        if (pg.character) {
          const sobj = await env.BOOKS.get(sheetKeyFor(slug, pg.character));
          if (sobj) sheet = new Uint8Array(await sobj.arrayBuffer());
        }
        const bible = await r2GetJson(env.BOOKS, `books/${slug}/bible.json`);
        const prompt = anchoredPrompt(pg.imagePrompt, pg.character, bible);
        let bytes = await generateImage(env, prompt, sheet);
        if (!(await qcImage(env.AI, bytes, sheet))) {
          console.log("redo-image: QC rejected, one retry");
          bytes = await generateImage(env, prompt, sheet);
          if (!(await qcImage(env.AI, bytes, sheet))) {
            console.log("redo-image: retry also failed QC; shipping it for human review in the editor");
          }
        }
        // NEW timestamped key: never overwrite (editor caches by URL).
        const ts = Date.now();
        const key = `books/${slug}/images/${chapter}-page-${pageIdx}-r${ts}.jpg`;
        await env.BOOKS.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });

        plan.pages[pageIdx].imageKey = key;
        await r2PutJson(env.BOOKS, `books/${slug}/plans/${chapter}.json`, plan);
        await rebuildEditorChapters(
          { AI: env.AI, BOOKS: env.BOOKS, DB: env.DB } as any,
          slug
        );
        const imageUrl = `https://pub-5e76d8a2d35343dbaa517e251b84e9c5.r2.dev/${key}`;
        return Response.json({ image: imageUrl });
      }
    }

    // ---- chapter regeneration (durable workflow) ---------------------
    {
      const m = url.pathname.match(/^\/book\/([^/]+)\/regen$/);
      if (request.method === "POST" && m) {
        const slug = decodeURIComponent(m[1]);
        if (!slug) return Response.json({ error: "invalid slug" }, { status: 400 });
        let body: any;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid JSON" }, { status: 400 });
        }
        const chapters: string[] = (body.chapters ?? []).map((c: any) => {
          const s = String(c).trim().toUpperCase();
          return /^S\d+$/.test(s) ? s : /^\d+$/.test(s) ? `S${s}` : "";
        }).filter(Boolean);
        if (!chapters.length)
          return Response.json({ error: "chapters required, e.g. {chapters: ['S6','S9']}" }, { status: 400 });
        const mode = ["both", "plan", "images"].includes(body.mode) ? body.mode : "both";
        const instance = await env.REGEN_WORKFLOW.create({
          params: {
            slug,
            chapters,
            mode,
            force: !!body.force,
            requestIds: Array.isArray(body.requestIds) ? body.requestIds : undefined,
          },
        });
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
          "UPDATE books SET stage='regen', stage_detail=?, updated_at=? WHERE slug=?"
        ).bind(`queued chapters ${chapters.join(",")}`, now, slug).run();
        return Response.json({ instanceId: instance.id, slug, chapters, mode });
      }
    }

    // ---- per-page fix (QC viewer: one page, note as art direction) ---
    {
      const m = url.pathname.match(/^\/book\/([^/]+)\/page-fix$/);
      if (request.method === "POST" && m) {
        const slug = decodeURIComponent(m[1]);
        if (!slug) return Response.json({ error: "invalid slug" }, { status: 400 });
        let body: any;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid JSON" }, { status: 400 });
        }
        const rawCh = String(body.chapter ?? "").trim().toUpperCase();
        const chapter = /^S\d+$/.test(rawCh) ? rawCh : /^\d+$/.test(rawCh) ? `S${rawCh}` : "";
        const page = typeof body.page === "number" ? body.page : parseInt(body.page, 10);
        if (!chapter || !Number.isFinite(page) || page < -1)
          return Response.json({ error: "chapter (S<n>) and page (0-based, or the finale index) required" }, { status: 400 });
        const instance = await env.PAGEFIX_WORKFLOW.create({
          params: {
            slug,
            chapter,
            page,
            note: typeof body.note === "string" ? body.note.slice(0, 1000) : undefined,
            requestId: typeof body.requestId === "string" ? body.requestId : undefined,
          },
        });
        return Response.json({ instanceId: instance.id, slug, chapter, page });
      }
    }

    // ---- self-healing repair (audit -> repair -> re-audit) ------------
    {
      const m = url.pathname.match(/^\/book\/([^/]+)\/repair$/);
      if (request.method === "POST" && m) {
        const slug = decodeURIComponent(m[1]);
        if (!slug) return Response.json({ error: "invalid slug" }, { status: 400 });
        let body: any = {};
        try {
          body = await request.json();
        } catch { /* empty body is fine: a full repair run */ }
        const instance = await env.REPAIR_WORKFLOW.create({
          params: {
            slug,
            dryRun: !!body.dryRun,
            maxRounds: typeof body.maxRounds === "number" ? body.maxRounds : undefined,
            maxImageRepairs: typeof body.maxImageRepairs === "number" ? body.maxImageRepairs : undefined,
            forcePages: Array.isArray(body.forcePages)
              ? body.forcePages.filter((x: any) => typeof x === "string").slice(0, 60)
              : undefined,
            noSimplifyPages: Array.isArray(body.noSimplifyPages)
              ? body.noSimplifyPages.filter((x: any) => typeof x === "string").slice(0, 60)
              : undefined,
          },
        });
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
          "UPDATE books SET stage='repair', stage_detail=?, updated_at=? WHERE slug=?"
        ).bind(body.dryRun ? "audit queued" : "repair queued", now, slug).run();
        return Response.json({ instanceId: instance.id, slug, dryRun: !!body.dryRun });
      }
    }

    // ---- reassemble PDFs from existing pages (never generates) -----
    // Runs as a workflow: assembly exceeds the fetch CPU limit. The
    // pre-checks mirror reassemble's own guards so a book that would
    // trigger generation (missing back cover art) is refused here,
    // synchronously, instead of inside the workflow.
    {
      const m = url.pathname.match(/^\/book\/([^/]+)\/reassemble$/);
      if (request.method === "POST" && m) {
        const slug = decodeURIComponent(m[1]);
        const bible = await r2GetJson(env.BOOKS, `books/${slug}/bible.json`);
        if (!bible?.conceptLadder?.length)
          return Response.json({ error: "no bible for slug" }, { status: 404 });
        const backColor = await env.BOOKS.head(`books/${slug}/back-cover-color.jpg`);
        const backLine = await env.BOOKS.head(`books/${slug}/back-cover-line.jpg`);
        if (!backColor || !backLine)
          return Response.json(
            { error: "back cover art missing; reassembly would trigger generation, refusing", slug },
            { status: 400 }
          );
        const instance = await env.REASSEMBLE_WORKFLOW.create({ params: { slug } });
        return Response.json({ instanceId: instance.id, slug });
      }
    }

    // ---- back covers only (generates art, never touches the PDFs) ----
    {
      const m = url.pathname.match(/^\/book\/([^/]+)\/back-covers$/);
      if (request.method === "POST" && m) {
        const slug = decodeURIComponent(m[1]);
        const bible = await r2GetJson(env.BOOKS, `books/${slug}/bible.json`);
        if (!bible?.conceptLadder?.length)
          return Response.json({ error: "no bible for slug" }, { status: 404 });
        // Full env, not a stripped subset: ensureBackCoverImages
        // GENERATES art, and the gateway reads AI_GATEWAY_KEY (plus
        // budget bindings) off env. The old {AI, BOOKS, DB} subset made
        // every generation return empty instantly, so this route could
        // never produce a back cover (found 2026-11-08 on Tilda, the
        // first build to reach assembly without pre-existing covers).
        const imgs = await ensureBackCoverImages(env as any, slug, bible);
        const base = "https://pub-5e76d8a2d35343dbaa517e251b84e9c5.r2.dev";
        return Response.json({
          slug,
          color: imgs.color ? `${base}/books/${slug}/back-cover-color.jpg` : null,
          line: imgs.line ? `${base}/books/${slug}/back-cover-line.jpg` : null,
        });
      }
    }

    // ---- gateway status (is the color image station configured?) -----
    if (url.pathname === "/gateway/status") {
      return Response.json({ configured: gatewayConfigured(env) });
    }

    // ---- source dedup check (standalone, no build) -------------------
    // POST /book/source-check {title, excludeSlug?} -> whether that
    // source is already adapted, and as which book. Read-only: the
    // same guard the build intake and the build workflow enforce.
    if (request.method === "POST" && url.pathname === "/book/source-check") {
      let body: any;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid JSON" }, { status: 400 });
      }
      const title = String(body?.title ?? body?.sourceTitle ?? "").trim();
      if (!title) return Response.json({ error: "title required" }, { status: 400 });
      const excludeSlug = body?.excludeSlug ? String(body.excludeSlug) : undefined;
      const m = await checkSourceDuplicate(env, title, { excludeSlug });
      return Response.json({
        title,
        duplicate: m.duplicate,
        confidence: m.confidence ?? null,
        matchedSlug: m.matchedSlug ?? null,
        matchedTitle: m.matchedTitle ?? null,
        matchedBookTitle: m.matchedBookTitle ?? null,
        candidateKey: m.candidateKey ?? null,
        message: m.duplicate ? duplicateMessage(title, m) : null,
      });
    }

    // ---- bible gate (standalone check, no build) ----------------------
    {
      const m = url.pathname.match(/^\/book\/([^/]+)\/gate$/);
      if (request.method === "POST" && m) {
        const slug = decodeURIComponent(m[1]);
        let bible = await r2GetJson(env.BOOKS, `books/${slug}/bible.json`);
        if (!bible?.conceptLadder?.length) {
          try {
            const row: any = await env.DB.prepare(
              "SELECT data FROM bibles WHERE book_slug = ? ORDER BY created_at DESC LIMIT 1"
            ).bind(slug).first();
            if (row?.data) bible = JSON.parse(String(row.data));
          } catch { /* no attached bible either */ }
        }
        if (!bible) return Response.json({ error: "no bible for slug" }, { status: 404 });
        const rows: any = await env.DB.prepare(
          "SELECT name FROM characters WHERE book_slug != ?"
        ).bind(slug).all();
        const taken = new Set<string>(
          ((rows?.results ?? []) as any[]).map((r) => String(r.name).toLowerCase())
        );
        const reasons = validateBible(bible, taken);
        const world = lintWorldInventory(bible);
        return Response.json({ slug, ok: reasons.length === 0, reasons, world });
      }
    }

    // ---- whole-book read pass (standalone, no build) -------------------
    // Runs the read pass over the book's STORED plans (no planning, no
    // art, no spend beyond one writer-chain call, metered in
    // text_events) and stores the report at books/{slug}/readpass.json.
    // The same pass gates the build pipeline between planning and art.
    {
      const m = url.pathname.match(/^\/book\/([^/]+)\/readpass$/);
      if (request.method === "POST" && m) {
        const slug = decodeURIComponent(m[1]);
        let bible = await r2GetJson(env.BOOKS, `books/${slug}/bible.json`);
        if (!bible?.conceptLadder?.length) {
          try {
            const row: any = await env.DB.prepare(
              "SELECT data FROM bibles WHERE book_slug = ? ORDER BY created_at DESC LIMIT 1"
            ).bind(slug).first();
            if (row?.data) bible = JSON.parse(String(row.data));
          } catch { /* no attached bible either */ }
        }
        if (!bible) return Response.json({ error: "no bible for slug" }, { status: 404 });
        bible = normalizeBible(bible);
        const plans: any[] = [];
        for (const e of bible.conceptLadder ?? []) {
          const ch = String(e.storyChapter ?? e.chapter ?? "");
          if (!ch) continue;
          const plan = await r2GetJson(env.BOOKS, `books/${slug}/plans/${ch}.json`);
          if (plan?.pages?.length) plans.push(plan);
        }
        if (!plans.length) {
          return Response.json({ error: "no stored plans for slug" }, { status: 404 });
        }
        try {
          const report = await runReadPass(env as any, slug, bible, plans);
          return Response.json({ slug, ...report });
        } catch (e: any) {
          return Response.json(
            { error: `read pass failed: ${e?.message ?? String(e)}` },
            { status: 502 }
          );
        }
      }
    }

    // ---- version snapshot (standalone, no build) ----------------------
    {
      const m = url.pathname.match(/^\/book\/([^/]+)\/snapshot$/);
      if (request.method === "POST" && m) {
        const slug = decodeURIComponent(m[1]);
        const entry = await snapshotIfChanged(env.BOOKS, slug, "manual");
        return Response.json({ slug, snapshot: entry });
      }
    }

    // ---- character studio: generate a sheet (pending approval) -------
    // The sheet is drawn by the gateway from the bible's visual text,
    // verbatim (a paraphrase once invented glasses for Orin). It lands
    // as a PENDING sheet; nothing downstream reads it until approve
    // copies it to the canonical key and upserts the registry row.
    {
      const m = url.pathname.match(/^\/book\/([^/]+)\/character-sheet$/);
      if (request.method === "POST" && m) {
        const slug = decodeURIComponent(m[1]);
        let body: any;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid JSON" }, { status: 400 });
        }
        const name = String(body?.name ?? "").trim();
        const visual = String(body?.visual ?? "").trim();
        if (!name || !visual) return Response.json({ error: "name and visual required" }, { status: 400 });
        if (!gatewayConfigured(env)) return Response.json({ error: "gateway not configured" }, { status: 503 });
        // kind: "line" makes a black-and-white single-pose sheet for
        // line generation. The color multi-pose sheets were the source
        // of the catalog's color leaks and pose clones (2026-10-27):
        // line art now conditions on line sheets; color sheets stay
        // for colorize.
        //
        // kind: "views" (2026-11-06, CG): a rich multi-view study
        // (turnaround, poses, expressions, prop and world elements)
        // kept as the character's modeling and promotion reference.
        // It conditions NOTHING in page generation, so it can carry
        // every view a future 3D model or promo needs without
        // re-opening the pose-clone problem the single-pose line
        // sheet solved.
        const kind = body?.kind === "line" ? "line" : body?.kind === "views" ? "views" : "color";
        const nameKey = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        // The views sheet wants the character's world, not just their
        // look: pull trait + setting from the book's bible when the
        // caller did not supply them.
        let worldBits = String(body?.world ?? "").trim();
        if (kind !== "line" && !worldBits) {
          try {
            const bible: any = await r2GetJson(env.BOOKS, `books/${slug}/bible.json`);
            const member = (bible?.characters ?? []).find(
              (c: any) => String(c?.name ?? "").toLowerCase() === name.toLowerCase()
            );
            const bits = [
              member?.trait ? `Personality: ${member.trait}` : "",
              bible?.setting ? `Their world: ${bible.setting}` : "",
              Array.isArray(bible?.locations) ? `Places: ${bible.locations.slice(0, 4).join(", ")}` : "",
            ].filter(Boolean);
            worldBits = bits.join(". ");
          } catch { /* bible optional for the views sheet */ }
        }
        const prompt =
          kind === "line"
            ? "Single character reference for a children's coloring book. ONE character, ONE pose, " +
              "standing in a neutral three-quarter view, centered on a pure white background. " +
              "Clean black outlines only, no color, no shading, no gray fills. Only one figure in " +
              "the image, no other views, no turnaround, no pose sheet. No text, no labels, no " +
              `words anywhere in the image. ${visual}`
            : kind === "views"
              ? "Character model sheet for a children's picture book, clean black outlines on a pure " +
                "white background, no color, no shading, no gray fills, no text, no labels, no words " +
                "anywhere in the image. Lay the sheet out in tidy rows of separate studies of the SAME " +
                "single character, identical in every study: TOP ROW, a turnaround: front view, side " +
                "view, back view, full body, standing. MIDDLE ROW, three full-body poses: walking, " +
                "working at the thing they love, and sitting down resting. BOTTOM ROW, four head " +
                "studies showing expressions: happy, determined, worried, surprised; beside them, " +
                "their signature object drawn alone, and two small elements from their home. " +
                `The character: ${visual}${worldBits ? ` ${worldBits}` : ""}`
              : "Character reference sheet for a children's picture book, plain light background, " +
                "clean storybook illustration, soft warm colors. Lay the sheet out in tidy rows of " +
                "separate studies of the SAME single character, identical in every study: a turnaround " +
                "row (front view, side view, back view, full body), a poses row (walking, working at " +
                "the thing they love, sitting), a row of head studies (happy, determined, worried, " +
                "surprised), and along the bottom their signature object and two small elements from " +
                "their home. No text, no labels, no words anywhere in the image. " +
                `The character: ${visual}${worldBits ? ` ${worldBits}` : ""}`;
        let bytes: Uint8Array;
        try {
          bytes = await generateGatewayImage(env, prompt, []);
        } catch (e: any) {
          return Response.json({ error: `gateway generation failed: ${e?.message ?? e}` }, { status: 502 });
        }
        const pendingPrefix = kind === "line" ? "characters/pending-line" : kind === "views" ? "characters/pending-views" : "characters/pending";
        const pendingKey = `${pendingPrefix}/${slug}-${nameKey}.png`;
        await env.BOOKS.put(pendingKey, bytes, { httpMetadata: { contentType: "image/png" } });
        await env.BOOKS.put(
          `${pendingPrefix}/${slug}-${nameKey}.json`,
          JSON.stringify({ slug, name, visual, kind, at: Math.floor(Date.now() / 1000) }, null, 1),
          { httpMetadata: { contentType: "application/json" } }
        );
        const base = "https://pub-5e76d8a2d35343dbaa517e251b84e9c5.r2.dev";
        return Response.json({ slug, name, kind, pendingKey, url: `${base}/${pendingKey}` });
      }
    }

    // ---- character studio: approve a pending sheet --------------------
    {
      const m = url.pathname.match(/^\/book\/([^/]+)\/character-sheet\/approve$/);
      if (request.method === "POST" && m) {
        const slug = decodeURIComponent(m[1]);
        let body: any;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid JSON" }, { status: 400 });
        }
        const name = String(body?.name ?? "").trim();
        if (!name) return Response.json({ error: "name required" }, { status: 400 });
        const kind = body?.kind === "line" ? "line" : body?.kind === "views" ? "views" : "color";
        const nameKey = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        const pendingPrefix = kind === "line" ? "characters/pending-line" : kind === "views" ? "characters/pending-views" : "characters/pending";
        const pendingKey = `${pendingPrefix}/${slug}-${nameKey}.png`;
        const obj = await env.BOOKS.get(pendingKey);
        if (!obj) return Response.json({ error: "no pending sheet for that character" }, { status: 404 });
        const bytes = new Uint8Array(await obj.arrayBuffer());
        const jpgKey = kind === "line" ? `characters/line/${nameKey}.png` : kind === "views" ? `characters/views/${nameKey}.png` : `characters/${nameKey}.png`;
        await env.BOOKS.put(jpgKey, bytes, { httpMetadata: { contentType: "image/png" } });
        if (kind === "views") {
          // The views sheet is a modeling/promotion reference only: it
          // is not a conditioning sheet, so there is no registry row
          // to upsert. Approval is just the canonical copy.
          return Response.json({ slug, name, kind, key: jpgKey });
        }
        // Registry metadata: prefer the book's bible cast entry (it
        // carries species/personality/maps-to), fall back to the
        // sidecar the generate step wrote.
        let meta: any = {};
        try {
          const sidecar = await env.BOOKS.get(`${pendingPrefix}/${slug}-${nameKey}.json`);
          if (sidecar) meta = JSON.parse(await sidecar.text());
        } catch { /* sidecar optional */ }
        let castMember: any = null;
        try {
          let bible = await r2GetJson(env.BOOKS, `books/${slug}/bible.json`);
          if (!bible?.conceptLadder?.length) {
            const row: any = await env.DB.prepare(
              "SELECT data FROM bibles WHERE book_slug = ? ORDER BY created_at DESC LIMIT 1"
            ).bind(slug).first();
            if (row?.data) bible = JSON.parse(String(row.data));
          }
          if (bible) {
            const nb = normalizeBible(bible);
            castMember = (nb.characters ?? []).find(
              (c: any) => String(c?.name ?? "").toLowerCase() === name.toLowerCase()
            );
          }
        } catch { /* metadata enrichment is best-effort */ }
        const visual = String(castMember?.visual ?? meta.visual ?? "");
        const personality = castMember?.personality;
        const personalityJson = JSON.stringify(
          Array.isArray(personality) ? personality : [String(personality ?? "").split(",").map((s: string) => s.trim()).filter(Boolean)].flat()
        );
        const now = Date.now();
        if (kind === "line") {
          try {
            await env.DB.prepare("ALTER TABLE characters ADD COLUMN line_jpg_key TEXT").run();
          } catch { /* column exists */ }
          await env.DB.prepare(
            `INSERT INTO characters (id, name, species, source, personality, visual, real_maps_to, jpg_key, svg_key, created_at, book_slug, line_jpg_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET visual=excluded.visual, line_jpg_key=excluded.line_jpg_key,
               species=excluded.species, real_maps_to=excluded.real_maps_to`
          )
            .bind(
              `char-${nameKey}`,
              castMember?.name ?? name,
              String(castMember?.species ?? ""),
              String(castMember?.source ?? "studio"),
              personalityJson,
              visual,
              String(castMember?.realMapsTo ?? ""),
              now,
              slug,
              jpgKey
            )
            .run();
        } else {
          await env.DB.prepare(
            `INSERT INTO characters (id, name, species, source, personality, visual, real_maps_to, jpg_key, svg_key, created_at, book_slug)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)
             ON CONFLICT(id) DO UPDATE SET visual=excluded.visual, jpg_key=excluded.jpg_key,
               species=excluded.species, real_maps_to=excluded.real_maps_to`
          )
            .bind(
              `char-${nameKey}`,
              castMember?.name ?? name,
              String(castMember?.species ?? ""),
              String(castMember?.source ?? "studio"),
              personalityJson,
              visual,
              String(castMember?.realMapsTo ?? ""),
              jpgKey,
              now,
              slug
            )
            .run();
        }
        const base = "https://pub-5e76d8a2d35343dbaa517e251b84e9c5.r2.dev";
        return Response.json({ slug, name: castMember?.name ?? name, kind, jpgKey, url: `${base}/${jpgKey}` });
      }
    }

    // ---- pilot approval (chapter-1 sample gate) -----------------------
    // BookBuildWorkflow parks a fresh build at stage
    // awaiting_pilot_approval after chapter 1's art lands; this route
    // (or the hub admin button proxying it) releases the rest of the
    // book once the owner has seen the sample.
    {
      const m = url.pathname.match(/^\/book\/([^/]+)\/pilot-approve$/);
      if (request.method === "POST" && m) {
        const slug = decodeURIComponent(m[1]);
        try {
          await ensureRunCols(env);
        } catch { /* columns are best-effort */ }
        const res = await env.DB.prepare("UPDATE books SET pilot_approved=1, updated_at=? WHERE slug=?")
          .bind(Math.floor(Date.now() / 1000), slug)
          .run();
        if (!res.meta?.changes) return Response.json({ error: "no such book" }, { status: 404 });
        return Response.json({ slug, pilotApproved: true });
      }
    }

    // ---- data plane: appeals enqueue, visual pass, edition manifests
    {
      const m = url.pathname.match(/^\/book\/([^/]+)\/appeals\/enqueue$/);
      if (request.method === "POST" && m) {
        const slug = decodeURIComponent(m[1]);
        let body: any = {};
        try { body = await request.json(); } catch { /* defaults */ }
        try {
          const r = await enqueueAppeals(env as any, slug, typeof body?.limit === "number" ? body.limit : 25);
          return Response.json({ slug, ...r });
        } catch (e: any) {
          return Response.json({ slug, error: String(e?.message ?? e), stack: String(e?.stack ?? "").slice(0, 600) }, { status: 500 });
        }
      }
    }
    {
      const m = url.pathname.match(/^\/book\/([^/]+)\/visual-pass$/);
      if (request.method === "POST" && m) {
        const slug = decodeURIComponent(m[1]);
        const r = await runVisualPass(env as any, slug);
        return Response.json({ slug, ...r });
      }
    }
    {
      const m = url.pathname.match(/^\/book\/([^/]+)\/edition-manifest$/);
      if (request.method === "POST" && m) {
        const slug = decodeURIComponent(m[1]);
        let body: any = {};
        try { body = await request.json(); } catch { /* defaults */ }
        const edition = body?.edition === "color" ? "color" : "line";
        const r = await recordEdition(env as any, slug, edition, standardArtifacts(slug, edition));
        return Response.json({ slug, edition, ...r }, { status: r ? 200 : 400 });
      }
    }

    // ---- cross-run book budget (Durable Object) ----------------------
    // POST /book/{slug}/budget {action: status|set_budget|reset|test_cycle, value?}
    {
      const m = url.pathname.match(/^\/book\/([^/]+)\/budget$/);
      if (request.method === "POST" && m) {
        const slug = decodeURIComponent(m[1]);
        let body: any = {};
        try { body = await request.json(); } catch { /* status needs no body */ }
        const action = String(body?.action ?? "status");
        const result: any = await budgetAdmin(env as any, slug, action, body?.value ?? null);
        if (result && !result.error) {
          emitBudgetMetric(env as any, slug, action, typeof body?.value === "number" ? body.value : 0, result.spentUsd ?? 0);
        }
        return Response.json({ slug, ...result }, { status: result?.error ? 400 : 200 });
      }
    }

    // ---- R2 file serving (existing) ----------------------------------
    if (url.pathname.startsWith("/book/")) {
      const key = decodeURIComponent(url.pathname.slice("/book/".length));
      if (!key.startsWith("books/")) return new Response("not found", { status: 404 });
      const obj = await env.BOOKS.get(key);
      if (!obj) return new Response("not found", { status: 404 });
      const name = key.split("/").pop() ?? "book.pdf";
      const ct = name.endsWith(".svg")
        ? "image/svg+xml"
        : name.endsWith(".json")
          ? "application/json"
          : name.endsWith(".jpg") || name.endsWith(".jpeg")
            ? "image/jpeg"
            : "application/pdf";
      return new Response(obj.body, {
        headers: {
          "Content-Type": ct,
          "Content-Disposition": `attachment; filename="${name}"`,
        },
      });
    }

    return Response.json({
      ok: true,
      usage:
        "POST /build {title, chapterText?, plan?, bible?, bookSlug?, chapterSlug?, pageCount?, language?} | " +
        "POST /book/build {slug} | GET /book/{slug}/status | " +
        "POST /book/{slug}/regen {chapters, mode?, force?} | " +
        "POST /book/{slug}/redo-text {chapter, page} | POST /book/{slug}/redo-image {chapter, page} | " +
        "POST /book/{slug}/colorize {force?} | POST /book/{slug}/delete | POST /book/{slug}/budget {action, value?}",
    });
  },

  // ---- appeals queue consumer ---------------------------------------
  async queue(batch: any, env: Env): Promise<void> {
    await handleAppealsBatch(batch, env as any);
  },

  // ---- queue runner: every 5 min, one job at a time ------------------
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const building: any = await env.DB.prepare(
      "SELECT slug FROM books WHERE status='building' LIMIT 1"
    ).first();
    if (building) return;
    const next: any = await env.DB.prepare(
      "SELECT slug FROM books WHERE status='queued' ORDER BY created_at ASC LIMIT 1"
    ).first();
    if (next) {
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        "UPDATE books SET status='building', stage='extract', stage_detail='', updated_at=? WHERE slug=?"
      )
        .bind(now, next.slug)
        .run();
      await env.BOOKBUILD_WORKFLOW.create({ params: { slug: String(next.slug) } });
      console.log(`queue runner: started build for ${next.slug}`);
      return;
    }

    // ---- change-request runner: queued reader change requests become
    // durable chapter regens, one chapter per tick, so the factory keeps
    // improving books on its own (this is also how docker gets redone:
    // the per-page redo routes refuse it, chapter regen does not).
    try {
      const activeRegen: any = await env.DB.prepare(
        "SELECT slug FROM books WHERE stage='regen' AND updated_at > ? LIMIT 1"
      )
        .bind(Math.floor(Date.now() / 1000) - 3 * 3600)
        .first();
      if (activeRegen) return;
      const group: any = await env.DB.prepare(
        `SELECT book_slug, chapter_num, GROUP_CONCAT(id) AS ids, GROUP_CONCAT(kind) AS kinds
         FROM change_requests WHERE status='queued' AND chapter_num >= 1
         GROUP BY book_slug, chapter_num ORDER BY MIN(created_at) ASC LIMIT 1`
      ).first();
      if (!group) return;
      const ids = String(group.ids).split(",").map((x: string) => parseInt(x, 10)).filter(Number.isFinite);
      const kinds = String(group.kinds).split(",");
      const mode = kinds.every((k: string) => k === "art")
        ? "images"
        : kinds.every((k: string) => k === "text")
          ? "plan"
          : "both";
      const now = Math.floor(Date.now() / 1000);
      const marks = ids.map(() => "?").join(",");
      await env.DB.prepare(
        `UPDATE change_requests SET status='in_progress', updated_at=? WHERE id IN (${marks})`
      )
        .bind(now, ...ids)
        .run();
      const chapter = `S${group.chapter_num}`;
      await env.REGEN_WORKFLOW.create({
        params: { slug: String(group.book_slug), chapters: [chapter], mode, force: true, requestIds: ids },
      });
      await env.DB.prepare(
        "UPDATE books SET stage='regen', stage_detail=?, updated_at=? WHERE slug=?"
      )
        .bind(`change request: ${chapter}`, now, String(group.book_slug))
        .run();
      console.log(`change runner: started regen for ${group.book_slug} ${chapter} (mode ${mode}, ${ids.length} requests)`);
    } catch (e: any) {
      console.log(`change runner failed: ${e?.message ?? e}`);
    }
  },
} satisfies ExportedHandler<Env>;
