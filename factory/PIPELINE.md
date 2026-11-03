# Kidsbook Factory: End-to-End Pipeline

## Current: the Worker pipeline (src/bookbuild.ts, updated 2026-10-28)

The Python script below is retired. The live pipeline is the
BookBuildWorkflow in the Worker. Stages: snapshot, run/cap guard,
extract, split, bookinfo, bible, bible gate, plan (per chapter, planv3
critic), **read pass**, images, cover, assemble, register.

Two 2026-10-28 additions (Phase 1 of the factory rethink):

- **World inventory (bible stage).** Generated bibles now carry an
  `openingJob` and a `worldInventory` (`exists` / `doesNotExist` /
  `forbiddenSourceTerms`, plus per-book `bannedOpeners` and `starNote`).
  The bible gate lints the inventory in code (`src/biblegate.ts`): a
  present-but-broken inventory fails the gate; a missing one (every
  legacy bible) is a reported gap, never a crash. The planner injects
  the inventory as hard WORLD RULES, the critic checks world
  consistency, and a deterministic lint scans story text, image
  prompts, and scenes for forbidden terms.
- **Read pass (stage 5b, after plan, before images).** The head of the
  writer chain reads the whole book at once (bible + ladder + all
  chapter texts) and files 4 BLOCK checks (hook pickup, world rules,
  source fidelity, metaphor honesty) and 5 WARN checks (story sense,
  opening-job payoff, idea arrival, variety, kid test and fun). The
  report is stored at `books/{slug}/readpass.json`; a `revise` verdict
  parks the book at `needs_review` with no art spend. It can also be
  run standalone: `POST /book/{slug}/readpass`.

Phase 2 additions (the art stack, 2026-10-28, `src/crops.ts`):

- **Pose crops.** Single-pose character references cut from the
  approved sheets in the hub's Crop Mode (`/admin/books/{slug}/crops`).
  Data: manifest `books/{slug}/crops.json` — entries `{tag, character,
  action, source: "sheet", bbox {x,y,w,h} (fractions of the source
  sheet), createdAt, key, sheetKey}` — plus one PNG per crop at
  `books/{slug}/crops/{tag}.png`. Tag grammar:
  `{character}-p{n}-{action}` (lowercase; props ride the action token,
  e.g. `skipper-p2-megaphone`). At draw time each named character whose
  pose tag resolves (deterministic keyword map over the character's
  scene action: flying/swimming/running/carrying/megaphone/…, with a
  single-crop then neutral-standing fallback) conditions on its crop
  INSTEAD of the full sheet; unresolved characters keep their sheet.
  Crop use and misses are logged to `gen_events` (`crop_used` /
  `crop_miss`, attempt 0). No manifest = the exact legacy sheet path.
- **Crops gate (stage 5c in the build; pre-flight in regen image
  modes).** A book WITH a `crops.json` has opted in: every bible
  character needs >= 1 tag before art proceeds, else the run parks at
  `needs_review` naming the untagged characters. Books without a
  manifest are never gated.
- **Cast-listing gate.** After Clef accepts a roll, the cast-listing
  judge (Gemini vision listing + `castListingOk` comparison against
  the page's expected species counts) files a verdict. Calibrated on
  the labeled corpus (see MODELS.md): it ships in FLAG mode
  (`gen_events` outcome `cast_flag`, page still ships its Clef
  verdict). `CAST_GATE=hard` makes a listing failure reject like a QC
  failure (`cast_reject`); `CAST_GATE=off` disables it. A judge outage
  is no opinion in every mode.
- **Repair escalation.** A page that fails 2 repair rounds escalates
  ONCE before holding: the cast listing of its current art classes the
  defect — a lead clone gets a writer-chain scene rewrite (same cast,
  same beat, new composition, persisted to the plan); anything else
  gets the scene simplified to the lead alone (co-stars and props
  stripped). Every step is recorded in the repair run's actions
  (`repair_runs`). Still failing after escalation, the page holds as
  before.

## Retired: the Python pipeline (historical)

One script runs the whole book: `run_book_end_to_end.py <slug>`

## Stages

| # | Stage | What it does | Model / tool | Skips when |
|---|-------|--------------|--------------|------------|
| 1 | extract | R2 `uploads/{slug}/` -> `books/{slug}/source.txt` (.txt/.md direct, .pdf via pdfplumber) | pdfplumber | source.txt exists |
| 2 | split | source.txt -> `chapters_split/S{n}.md` (markdown headings, else even chunks) | rule-based | split files exist |
| 3 | bookinfo | chapters -> `book_info.json` (title, subject, extractive summaries) | rule-based + D1 | book_info.json exists |
| 4 | bible | `bible_universal.py` -> `bible.json` (characters, concept ladder, metaphor bank) | Gemini 3.8 Flash | bible.json exists |
| 5 | plan | `plan_chapter_v3.py` per chapter, hook-chained -> `chapters_story/S{n}.json` | Gemini 3.8 Flash | plan exists |
| 6 | images | 4-5 images/chapter + Llava QC -> `images/`, uploaded to R2 | flux-2-klein-4b, Llava 1.5 | image exists locally |
| 7 | assemble | picture-book.pdf + coloring-book.pdf -> R2 `books/{slug}/` | PIL | PDF exists |
| 8 | register | D1 books row upsert, status `in_progress`, PDF keys | D1 API | always runs (upsert) |

## Planner v3 guarantees

- Chapter title verbatim from the bible (no inventing)
- No raw source-text dump in the prompt (the ladder entry is the spec)
- "Giant heavy old way" opener banned for S4+
- Each chapter opens by resolving the previous chapter's hook
- Critic pass: a second model call verifies the plan teaches THIS chapter's idea; regenerates up to 3x
- Trigram overlap check against all previous chapters; regenerates above 0.35

## Gemini policy

Stages 4 and 5 use Gemini 3.8 Flash via the `custom.gemini` credential. If Gemini
returns 429/503, the script STOPS with a clear message. It never falls back to
Qwen. Re-run later; completed stages are skipped.

## Idempotency

Every stage checks for existing outputs before doing work. Safe to re-run any
time. Use `--from STAGE` to start mid-pipeline or `--only STAGE` for one stage.

## What the script never touches

- `books/docker/` (the finished Docker book is frozen)
- The hub worker or its deploys
- The factory worker's Cloudflare routing (CG's task)
