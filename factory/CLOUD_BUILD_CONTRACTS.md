# Cloud-Native Bookstore Loop: Build Contracts

CG's vision: select N PDFs in the hub → walk away → books build autonomously on
Cloudflare → come back to QA in the editor (redo text / redo image per page) →
publish as he goes. Everything below runs on Cloudflare. No VM-side daemons.

## D1 (kidsbook-hub, e1da6223-d7ab-496f-97e8-4c97111e8b8d)

```sql
ALTER TABLE books ADD COLUMN stage TEXT;          -- one of the 8 pipeline stages
ALTER TABLE books ADD COLUMN stage_detail TEXT;   -- e.g. "S7/18", "page 42/78"
-- status lifecycle: draft -> queued -> building -> ready_for_qa -> complete
-- (keep in_progress working: treat as building for old rows)
```

## R2 (kidsbook-factory bucket)

- `uploads/{slug}/{file}` — source PDFs (already used by hub upload)
- `books/{slug}/bible.json` — story bible
- `books/{slug}/plans/S{n}.json` — chapter plans (S1.json … S18.json)
- `books/{slug}/images/{page}.jpg` — page art
- `books/{slug}/editor_chapters.json` — NEW. Editor-ready, shape:
  ```json
  [{"num": 1, "title": "chapter title", "pages": [
     {"text": "story text", "image": "https://pub-....r2.dev/books/{slug}/images/S1-page-0.jpg",
      "imagePrompt": "original prompt", "character": "Pip", "concept": "one-liner"}
  ]}]
  ```
  (matches the editor's current docker_chapters.json shape, plus redo context)
- `books/{slug}/picture-book.pdf`, `coloring-book.pdf` — outputs

## Factory worker (kidsbook-factory)

New bindings: D1 `DB` (same db id as hub), keep AI + BOOKS + KIDSBOOK_WORKFLOW.
New workflow binding: `BOOKBUILD_WORKFLOW` → `BookBuildWorkflow`.

### BookBuildWorkflow (new class in workflow.ts)
- `params: {slug}`
- Steps (each updates `books.stage` / `stage_detail` in D1):
  1. `extract` — download PDFs from `uploads/{slug}/`, extract text with unpdf
     (bundle it; pdfplumber is Python and stays out of the worker)
  2. `split` — split source text into chapters (port from run_book_end_to_end.py)
  3. `bookinfo` — title/author metadata (port)
  4. `bible` — port bible_universal.py prompt; model chain below
  5. `plan` — for each chapter: port plan_chapter_v3.py (prompt builder, critic,
     trigram overlap, banned openers, hook chaining); save `plans/S{n}.json`
  6. `images` — per page: flux-2-klein-4b + Clef QC (already in ai.ts)
  7. `assemble` — picture-book.pdf + coloring-book.pdf (already in worker)
  8. `register` — write `editor_chapters.json`, set status=`ready_for_qa`
- Model chain for bible/plan/critic (port of plan_chapter_v3.py call_model):
  order from env `PLANNER_ORDER`, default `gemini,deepseek,gemma`
  - `gemini`: POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent
    with `GEMINI_API_KEY` worker secret, thinkingBudget 0. SECRET NOT SET YET —
    chain must skip gracefully when absent (do not fail the workflow).
  - `deepseek`: AI.run("@cf/deepseek-ai/deepseek-r1-distill-qwen-32b"),
    strip `<think>` blocks, require JSON (see plan_chapter_v3.py).
    KNOWN: sometimes returns markdown instead of JSON; treat as attempt failure.
  - `gemma`: AI.run("@cf/google/gemma-4-26b-a4b-it"), OpenAI-choices response
    shape (`result.choices[0].message.content`), generous max_tokens (reasoning
    eats budget). KNOWN: needs big token budget.
  - Record winning model per chapter in plan `_model`.
- Existing `KidsBookWorkflow` (per-chapter) stays untouched.

### New HTTP routes (index.ts)
- `POST /book/build` `{slug}` → create BookBuildWorkflow instance, `{instanceId}`
- `GET /book/{slug}/status` → `{status, stage, stage_detail}` from D1
- `POST /book/{slug}/redo-text` `{chapter, page}` →
  load bible + `plans/{chapter}.json` from R2; regenerate ONLY that page's
  `text` with full context (bible chars/setting, ladder entry, story-so-far,
  neighboring pages); rewrite plan + `editor_chapters.json`; return `{text}`.
  Caller (hub) clears the page approval.
- `POST /book/{slug}/redo-image` `{chapter, page}` →
  load page's `imagePrompt` from plan; fresh flux render (new seed) + Clef QC;
  upload to NEW key `books/{slug}/images/{page}-r{timestamp}.jpg` (never
  overwrite; editor caches by URL); update `editor_chapters.json`; return `{image}`.
  Caller clears the page approval.

### Queue runner (cron trigger, every 5 min, in factory worker)
```ts
async scheduled(event, env) {
  const building = await env.DB.prepare("SELECT slug FROM books WHERE status='building' LIMIT 1").first();
  if (building) return;
  const next = await env.DB.prepare("SELECT slug FROM books WHERE status='queued' ORDER BY created_at LIMIT 1").first();
  if (!next) return;
  await env.DB.prepare("UPDATE books SET status='building', stage='extract' WHERE slug=?").bind(next.slug).run();
  await env.BOOKBUILD_WORKFLOW.create({params: {slug: next.slug}});
}
```
Register via API: `PUT /accounts/{id}/workers/scripts/kidsbook-factory/schedules`.

## Hub (kidsbook-hub)

- `/admin/books/new`: multi-file upload → for each PDF create book row
  (`status='queued'`, slug from filename), upload to `uploads/{slug}/`.
  Add "select all" later; Drive import is out of scope.
- Books list: show `status` + `stage`/`stage_detail` (poll `/book/{slug}/status`
  or read D1 directly — D1 is bound, prefer direct).
- `GET /api/editor/chapters?slug=`: replace hardcoded docker_chapters.json —
  fetch `books/{slug}/editor_chapters.json` from R2 BOOKS binding. Keep docker
  fallback when slug=docker.
- `POST /api/editor/redo-text`, `POST /api/editor/redo-image`: proxy to factory
  (`POST {factory_url}/book/{slug}/redo-text`), then DELETE the page's approval
  row so it shows unapproved. Factory URL from settings table.
- Editor UI (edit.astro): per-page "Redo text" and "Redo image" buttons.
  On success update the page in place + uncheck approval. Disable while running.

## Deploy order
1. D1 ALTERs (API).
2. Factory worker (esbuild src/index.ts --bundle --external:cloudflare:workers,
   then deploy.py; add D1 binding + cron schedule via API).
3. Hub (astro build, then deploy.py).
4. End-to-end test on a 2-chapter test book.

## Do NOT touch
- `books/docker/` in R2 or locally; the Docker book is the reference.
- run_book_end_to_end.py / plan_chapter_v3.py: keep as the local reference
  implementation. The worker is a port, not a replacement, until proven.
- Stripe / public storefront pages (separate track).
