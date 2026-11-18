# Kidsbook Factory: What Models Do What

## Current: the Worker pipeline (src/, updated 2026-10-28)

The Python pipeline described below is retired. The live factory is the
TypeScript Worker (`src/models.ts` is the chain authority):

- **Writer chain** (bible, chapter drafts, book info, whole-book read
  pass): `opus,gemini,v4flash,gemma`. Opus 5.5 via the Vercel
  AI Gateway first, Gemini 3.8 Flash direct, then the Workers AI bench.
  (2026-11-20: Cloudflare retired deepseek-v4-flash-0731 and
  deepseek-r1-distill-qwen-32b. V4 Flash moved to its named successor
  deepseek-v4.1-flash-1017; the deepseek rung left the default chains,
  but its dispatch entry stays pointed at v4.1-flash so an env ORDER
  still naming "deepseek" resolves to a live model instead of throwing.)
- **Judge chain** (the planv3 chapter critic): `opus,gemini,v4flash,gemma`
  since 2026-10-28. GLM 5.3 is OUT of the default judge chain (it filed
  only a subset of defects in testing); it remains available via the
  `JUDGE_ORDER` env override. Opus also holds a separate acceptance
  seat: one look per chapter that already passed.
- **Whole-book read pass** (`src/readpass.ts`): head of the writer
  chain (Opus) reads the entire planned book before any art spend;
  BLOCK failures park the book at `needs_review`.
- **Images**: Nano Banana (gateway) is the artist; Clef is the image
  QC judge; Jev gates story text cheaply inside the critic. A
  flag-gated GPT rescue editor (`GPT_EDIT_RUNG=on`, gpt-image via the
  gateway's `/v1/images/edits`, `src/gateway.ts`) sits between the
  edit pass and the inline appeal in the line path and is colorize's
  only edit rung: it edits the best reject, never originates, and
  faces the same gates and archive as any other attempt.
- **Cast-listing judge** (`judgeCastListing` + `castListingOk` in
  `src/ai.ts`): Gemini 3.8 Flash (direct, temperature 0) lists what is
  actually drawn on a page (species + counts, humans, single-scene,
  repeated pose); plain code compares the listing to the page's
  expected cast. Calibrated 2026-10-28 on the factory-ops labeled
  corpus (33 pages: 12 verified clone/cast defects, 21 verified-clean
  pages from the cast audit and the Basil/Penny sweeps; harness in
  `factory-ops/calib-cast-gate/`). Two independent runs agreed:
  precision 0.69, recall 0.92 (TP 11, FN 1, FP 5, TN 16); dropping
  the unexpected-animal rule changed nothing in aggregate. The 24%
  false-reject rate on clean pages (background flocks and ducklings
  counted as clones, lister count noise) is far above the bar for a
  rejecting gate, so the judge runs in FLAG mode by default: verdicts
  land in `gen_events` as `cast_flag` for human review and never
  reject a roll. `CAST_GATE` env: `flag` (default) | `hard` | `off`.
- **Pose-crop conditioning** (Phase 2): no model change — the same
  Nano Banana artist, but conditioned on single-pose crops
  (`src/crops.ts`) instead of multi-pose sheets where the owner has
  tagged them. The crop is the anti-clone lever; the listing judge is
  the measurement.
- **Text metering**: every text-model call writes one row to the D1
  `text_events` table (model, purpose, slug, tokens, derived cost).
  Image spend has its sibling table, `gen_events`.

## Retired: the Python pipeline (historical)

## Story planning
- **Gemini 3.8 Flash** (via `custom.gemini`, orchestrator-side in `plan_chapter.py`): writes every chapter plan (story text, image prompts, page breakdown). Winner of the Oct 15 planner benchmark.
- **Qwen** (Workers AI `@cf/qwen/qwen2.5-coder-32b-instruct`): fallback only, used when Gemini is down. Wrote S9 and S18 of the Docker book.

## Story bibles
- **Gemini 3.8 Flash** (via `bible.py` / `super_bible_prompt.md`): generates the story bible for any book (characters, concept ladder, metaphor bank, locations, story arc).

## Images
- **flux-2-klein-4b** (Workers AI `@cf/black-forest-labs/flux-2-klein-4b`): all interior black-and-white line art AND the color covers. Winner of the Oct 15 image benchmark (klein-9b close second at 10x cost).

## Image QC
- **Llava 1.5 7B** (Workers AI `@cf/llava-hf/llava-1.5-7b-hf`): checks every image for text, color, and line-art quality. 3 yes/no questions per image.
- **Clef** (Cloudflare decision model): tried Oct 16, DISABLED same day after workflow errors. Llava is the active QC.

## Translation
- **Gemma 4 26B** (Workers AI `@cf/google/gemma-4-26b-a4b-it`): translates chapter text for non-English editions. Page art is reused, not regenerated.

## Vectorization
- **imagetracerjs** (pure JS, runs inside the worker): traces B&W line art to editable SVG. Every page also saved as SVG in R2.

## PDF assembly
- **pdf-lib** (not a model): assembles the coloring-book.pdf and picture-book.pdf, uploads to R2.
