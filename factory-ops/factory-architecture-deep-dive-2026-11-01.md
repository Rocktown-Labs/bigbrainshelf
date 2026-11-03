# Big Brain Shelf Factory: Architecture Deep Dive and Redesign Proposal

Date: 2026-11-01
Status: Proposal for CG review. Nothing in this plan is treated as already approved.
Scope: The book factory only. The bookstore and hub are consumers of factory outputs, except for the review surface that should feed labels back into the factory.

## Executive verdict

The factory does not need a rewrite. It needs a production data system underneath the pipeline it already has.

Cloudflare Workflows can run stages. R2 can store files. D1 can show current book state. What the system has lacked is production memory: what was tried, what it cost, which inputs produced an asset, why a gate decided, and whether a change made the next book cheaper or better.

The target pattern is simple:

1. Every paid attempt is an immutable record, not a console log.
2. Every shipped asset traces back to its scene, prompt, references, model, gate scores, and human decisions.
3. Every gate has a labeled dataset, a version, and a promotion rule.
4. Prompts, models, thresholds, and retry policies ship as releases through shadow or canary before full production.
5. Every run has a budget and a forecast before art spend starts.
6. Human review produces labels that improve the gates.
7. Repair may redraw a scene. It may not silently change the story being drawn.

That is the practical version of "what would Meta do" at this scale. It is not a microservice fleet. It is data first, evaluation before promotion, controlled rollout, and no unmeasured spend. Pixar contributes the asset discipline: named assets, versions, reviews, and a known current take. Meta contributes the release discipline: hypotheses, guardrails, canaries, and records.

One correction to the brief: current page art is not Workers AI FLUX. `src/ai.ts` records that FLUX 2 Klein was removed on 2026-10-24. Line and color page art now use the gateway Nano Banana path in `src/gateway.ts`. Workers AI remains in Clef QC and parts of the text bench.

## Evidence and baseline

Sources used: `src/bookbuild.ts`, `src/colorize.ts`, `src/repair.ts`, `src/ai.ts`, `src/gateway.ts`, `src/models.ts`, `src/planv3.ts`, `src/readpass.ts`, `src/purity.ts`, `src/versioning.ts`, `~/workspace/factory-ops/calib-cast-gate/CALIBRATION.md`, and `~/workspace/factory-ops/CAST-AUDIT-REPORT-2026-10-26.md`.

D1 snapshot, queried 2026-11-01 at 21:41 UTC:

- `gen_events`: 830 rows, 9 slugs, $46.20 metered image cost, from 2026-10-26 to the snapshot.
- Paid image rows, meaning rows with non null cost: 758.
- `gen_attempts`: 44 rows, all for one slug, $2.66 total. Every row had bytes and scores.
- `text_events`: 14 rows, $1.81 known cost. It covers some `callModel` traffic, but not Clef, Jev, the cast listing judge, the legacy planner in `ai.ts`, or every gateway helper.
- `repair_runs`: 27 summaries.

`gen_events` starts on 2026-10-26 and several provider paths are unmetered, so D1 cannot reproduce an all in cost per finished book. CG's operating figure is $9 to $11 per book against a $3 target. That gap between the operating number and the system of record is a finding, not a footnote.

### Image economics

| Surface | Paid rows | Accepted or autofixed rows | Metered cost | Attempt 1 accepted | Paid rows per accepted event |
| --- | ---: | ---: | ---: | ---: | ---: |
| Line | 454 | 162 | $27.25 | 128 of 245, or 52.2% | 2.80 |
| Colorize | 295 | 57 | $18.33 | 45 of 130, or 34.6% | 5.18 |
| Cover | 9 | 1 | $0.61 | 0 of 4 | 9.00 |

"Attempt 1" means the first roll inside one generation function call. Repair or regen can call the function again and reset the count, so this is an operational proxy, not a unique page rate. "Accepted event" is also not a unique finished page, because a page can be accepted again in a later process. Text, QC, storage, workflow compute, and unmetered paths are excluded.

The factory pays for retries, not pages. At about $0.06 per roll:

- One 40 page art surface costs $2.40 with perfect first attempt acceptance.
- At 52.2%, a simple geometric estimate is $4.60 for a 40 page line surface.
- At 34.6%, the estimate is $6.94 for a 40 page colorize surface.
- If $3 means one 40 page surface, first attempt acceptance must be about 80% before allowing for text and QC.
- If $3 means line plus color for the same 40 pages, it is unreachable at $0.06 per roll even with perfect acceptance. Those two surfaces start at $4.80 before covers, text, QC, and assembly.

Report three numbers from now on: base line book cost, incremental color edition cost, and complete sellable book cost with the included deliverables named.

Third rolls show the retry problem. Line attempt 3 accepted 10 of 92 paid rows, or 10.9%. Colorize attempt 3 accepted 7 of 80, or 8.8%. A low rate is expected after two failures, but it means the third action should usually change the strategy or adjudicate the gate, not repeat the same request.

## Diagnosis

| Failure | Evidence | Architectural gap |
| --- | --- | --- |
| Mira colorize run 1 cost $5.39 and held 19 of 40 pages | 2026-11-01 run history. `colorize.ts` now records that cast came from the plan character field, and finales were passed the wrong cast | Scene semantics had no single typed contract. Character field, prose prompt, structured scene, reference loader, and QC derived cast in different ways. No preflight compared expected cast, reference set, and QC cast before paid rolls |
| Legacy plan prompts embed bible visuals and name nobody | `planv3.ts` requires verbatim visuals in legacy prompts and bars names from art prompts. `castForPage` in `bookbuild.ts` now bridges the gap with an 8 word visual run match | Prose written for the artist doubled as a data transport layer. Identity was encoded in text that deliberately omitted names, so every downstream consumer had to guess it back |
| Color anatomy gate rejected clean art at production rates | Clean color pages scored 0.316 to 0.564 against a 0.5 bar; a broken example scored 0.144. Color bar moved to 0.3 in `ai.ts` on 2026-11-01 | A VQA score was treated as a calibrated measurement. The threshold was a code constant with no versioned dataset, score distribution, uncertainty band, or promotion record |
| Line anatomy blocked all repair attempts on Mira S3 page 0 and S6 page 3 | D1 `gen_attempts`: 18 line rejects across the two pages, $1.076. Anatomy scores ran 0.10 to 0.49, with dupe and single scene failures on other rolls | The line path kept a 0.5 bar without a line specific labeled distribution or gray zone. The system could not separate a clear defect from judge uncertainty, so it kept buying rolls and then held the page |
| Repair escalation turned two character scenes into solo scenes | `repair.ts` defaults non clone defects to a lead only simplification. `noSimplifyPages` exists because dropping a speaking co-star is worse than holding the page | Repair optimized for gate passage, not semantic preservation. Cast preservation was a caller supplied exception instead of an invariant derived from the plan |
| Rejected rolls vanished for months | `gen_events` began 2026-10-25. Attempt bytes and scores began 2026-11-01. The archive snapshot has 44 rows for one book | Observability was counters and logs. There was no attempt entity, retention policy, or lineage key, so tuning data had to be recreated through memory or paid probes |
| Books run $9 to $11 against a $3 target | CG operating figure. `spendCapHit` in `bookbuild.ts` sums only `gen_events` image cost since `books.run_started_at` | Cost is a local guard, not a pipeline object. There is no complete ledger, forecast, stage budget, or cost per shippable release. A $10 cap can work exactly as coded and still leave no path to $3 |
| Cast listing judge is useful but unsafe as a hard gate | Calibration on 33 labeled pages: recall 0.92, precision 0.69, false rejects 5 of 21 clean pages. It ships in flag mode | The factory did the right calibration once, but the result lives in a folder, a report, and code comments. It is not yet a standing regression suite that every gate release must pass |
| Repaired pages and assembled PDFs can drift apart | `versioning.ts` snapshots whole books. `colorize.ts` decides color freshness by R2 timestamps. Past verification found repaired line pages missing from older assemblies | Mutable keys and timestamps are being used as lineage. They prove a file exists, not which inputs produced it. Assembly needs a manifest, not a folder state guess |

The text read pass is the counterexample. In `readpass.ts`, four block checks and five warn checks are judged against the whole book, evidence is quoted, and code recomputes the verdict so a lenient model cannot override a failed block check. Its fingerprint prevents paying again for unchanged text. It parked Tilda for about $0.20 before art spend and caught source term leakage and an overpromising metaphor. That is the pattern to generalize.

The factory currently has four competing truths: the plan says what should happen, the prompt says what the artist was told, the R2 key says what file occupies a slot, and the workflow says whether a step returned. None is a complete record of what happened. The redesign adds that record.

## Target architecture

### 1. Immutable attempt and artifact store

Keep Cloudflare Workflows, D1, and R2. Change what they mean.

- D1 is the control plane and index.
- R2 holds immutable bytes and large JSON payloads.
- `books` remains current state, not production history.
- Daily exports of production tables go to R2 in JSON Lines form for retention and analysis. Add Parquet later only if query volume earns it.
- Workers Logs stay useful for debugging, but their retention is measured in days, so they are never the archive.

Core objects:

| Object | Job |
| --- | --- |
| `production_runs` | One build, colorize, regen, repair, reassemble, or eval operation, with workflow instance ID, parent run, release ID, budget ID, and status |
| `stage_runs` | One resumable stage or page slot, with input fingerprint, status, output artifacts, and cost subtotal |
| `artifacts` | Immutable record for an image, plan, bible, prompt, report, or PDF, keyed by artifact ID and SHA-256 content hash |
| `artifact_inputs` | Lineage edges: output artifact, input artifact, and role such as bible, plan, scene, line page, sheet, crop, or prompt |
| `generation_attempts_v2` | One provider request, with stage run, request fingerprint, prompt artifact, reference artifacts, provider, model, output artifact, latency, cost, and outcome |
| `gate_results` | One gate decision, with gate version, rule or question hash, judge model, raw scores, band, decision, latency, and cost |
| `human_labels` | One review decision tied to an attempt or artifact, with taxonomy version, defect class, severity, gate error flag, labeler, and rationale |
| `release_bundles` | The exact code version, prompt hashes, model routes, gate policy, and retry policy used by a run |
| `eval_datasets` and `eval_runs` | Versioned labeled corpora and the measured result of a candidate release against them |
| `experiments` | Shadow and canary setup, guardrails, sample rule, result, and promotion decision |
| `budgets` and `cost_ledger` | Stage allocations, reservations, forecasts, and one priced or explicitly unpriced row per external call |
| `release_manifests` | The selected artifact for every slot in a shippable edition, plus QA reports and release IDs |

The current `logGenAttempt` key shows why identity matters. It builds an R2 key from slug, kind, chapter, page, and attempt number. A later repair can reuse that identity and overwrite the image while multiple D1 rows point to it. New keys must use an attempt UUID or content hash.

Prompt payloads and source derived text should live in private R2 objects. D1 should hold IDs and hashes, not large sensitive payloads.

### Analytics plane: know every run

The missing piece is a first class analytics and observability plane. The ledger says what happened. The analytics plane makes it visible while it is happening and comparable after it ends.

**Instrumentation contract.** Every workflow, stage, page slot, provider call, gate, retry, human decision, assembly check, and alert emits the same versioned event envelope through one `emit(...)` helper. Required fields: `event_id`, `trace_id`, `run_id`, `parent_run_id`, `workflow_instance_id`, `stage_run_id`, `span_id`, `parent_span_id`, internal book slug, `artifact_id` or content hash when relevant, `release_id`, actor, timestamp, duration, status, and cost. No subsystem invents its own log shape. If an action matters enough to spend money or change state, it matters enough to emit an event.

**Storage split.** Use each store for what it is good at:

| Layer | Store | Job |
| --- | --- | --- |
| Exact operational record | D1: `production_events`, `span_events`, `gate_results`, `cost_ledger` | Run timeline, QC decisions, spans, budgets, and the facts the admin UI must not approximate |
| Hot analytics | Cloudflare Workers Analytics Engine datasets: `factory_events`, `factory_gate_scores`, `factory_costs` | Fast SQL aggregation over recent runs, gate score distributions, funnel counts, yield curves, latency, fallback rate, and cost burn. Writes use non blocking `writeDataPoint` calls within the documented shape of up to 20 blobs, 20 doubles, and one index. Retention is about three months, so it is a hot window, not the archive |
| Cold archive | R2 JSON Lines exports by day and release | Durable event and span history for eval datasets, audits, and later warehouse import. Daily rollups are written back to D1 and R2 before the hot window expires |
| Debug logs and platform traces | Workers Logs and Workers Traces | Console output, invocation errors, binding and fetch timing, and live investigation. Enable traces at the current low volume, keep raw log retention short, and never treat platform logs as the system of record |

Workers automatic traces cover invocations, fetches, and bindings. The factory still needs semantic spans for its own pipeline: `run -> stage -> page -> provider attempt -> gate set -> decision -> assembly`. Those spans are stored as `span_events` with OpenTelemetry style names and attributes, so a run can be drawn as a waterfall even when one workflow spans many invocations and waits. If volume later earns an external APM, the same trace IDs and span shape can export through OpenTelemetry or Logpush without changing the event contract.

**Live run visibility.** Add a Factory Mission Control view in the hub admin, fed by D1 for exact state and Analytics Engine SQL for aggregates:

- Active runs list: book, process, release, current stage and page, heartbeat age, elapsed time, budget spent, forecast to finish, pages accepted, pages held, and last event.
- Run detail: a trace waterfall from run to stage to page to attempt to gate, with the raw QC scores, judge model, fallback status, prompt hash, reference hashes, output artifact, cost, and human labels on the same page.
- Log tail: a run filtered stream that combines `production_events` with Workers Logs results queried through the Cloudflare observability telemetry API by `run_id` or `trace_id`. A matching CLI tail uses the same filters for terminal work.
- QC analytics: reject Pareto by gate and failure class, score histograms by gate, gate version, model, book, and scene slice, calibration against human labels, and attempt yield by attempt number and retry strategy.
- Cost analytics: forecast versus actual by stage, provider, model, and release; cost per accepted page; cost per shippable book; unpriced call count driven to zero.
- Alerts as events: stale heartbeat, stuck stage, spend ahead of forecast, held rate spike, provider fallback spike, judge errors, queue backlog, and a spike in human overturns after a release. Alerts appear in the run timeline and the daily report, not only in a chat message.

**Proof standard.** A run is not observable because a workflow says complete. It is observable when an operator can answer, from the UI alone: what ran, under which release, on which inputs, what each gate decided and why, what it cost, where it stopped, and which artifact shipped. Any run that cannot answer those questions is an observability defect, filed like a product defect.

### 2. One canonical SceneSpec

New plans already carry structured scenes, and `linePromptFromScene` in `gateway.ts` already states the cast count and withholds names from the artist. Finish that direction. Every page and finale gets a validated SceneSpec:

```json
{
  "bible_artifact_id": "art_01",
  "plan_artifact_id": "art_02",
  "chapter": "S3",
  "page": 0,
  "cast": [
    {"character_id": "mira", "count": 1, "action": "leans over the pool", "speaking": true},
    {"character_id": "ansel", "count": 1, "action": "watches from the bank", "speaking": true}
  ],
  "setting": "flat stones beside a still forest pool",
  "props": [{"name": "plain basket", "count": 1}],
  "background_allowances": [{"species": "duck", "min": 0, "max": 6, "role": "background_only"}],
  "reflections_allowed": true,
  "source": {"type": "plan_v3", "confidence": 1.0}
}
```

The same object drives:

- Prompt rendering.
- Sheet and crop selection.
- QC expected cast and counts.
- Background and reflection allowances.
- Repair invariants.
- Difficulty routing and cost forecast.

`castForPage` should remain only as a legacy adapter. The adapter writes a SceneSpec artifact and records how each cast member was resolved: structured scene, character field, prompt name, or visual match. Low confidence cast blocks generation or routes to review. It must never become the permanent identity system.

Background allowances matter. The cast audit and calibration both found that background ducklings, flocks, reflections, and shadows break naive counting. Expected cast needs exact counts for named characters and explicit allowances for background life.

### 3. Idempotent stage contract

Workflow steps are resumable at the boundary, but a page step can contain three paid rolls. If a step fails after paid work and before its result is recorded, the workflow retry can repeat the loop.

Use this contract for every production stage:

1. Compute an input fingerprint from stage, slot, input artifact hashes, SceneSpec hash, and release bundle ID.
2. Reuse a completed stage run with the same fingerprint.
3. Reserve budget.
4. Insert the attempt as `requested` before the provider call.
5. Store returned bytes as an immutable artifact immediately.
6. Record each gate result separately.
7. Mark the attempt and stage with a terminal outcome.
8. Move the current slot pointer only after acceptance.

Crashes then have inspectable states such as `requested`, `provider_returned`, and `outcome_unknown`. They do not become a missing page and an unexplained balance change.

Color freshness should use lineage, not timestamps. A color artifact is current only when its parent line artifact ID is the current line slot artifact and its release matches the requested release.

### 4. Evaluation infrastructure

Treat gates like models. Each one has an owner, a version, a dataset, and a release record.

Dataset v0 can be built without new generation:

- The 44 archived Mira attempts.
- The 33 page cast corpus: 12 verified defects and 21 verified clean pages.
- Verified defects and clean pages from the 2026-10-26 cast audit.
- The purity corpus described in `purity.ts`.
- Wally and Juno as permanent read pass regressions.
- Verified Basil and Penny sweep pages.
- Held and repaired pages once labels are attached.

Rules:

- Split tuning and locked test data by book where possible.
- Stratify by surface, defect class, cast count, same species pair, water or reflection, background flock, finale, cover, and score band.
- Preserve hard cases. A clean page with background ducklings teaches more than another obvious solo page.
- Version the label taxonomy. Clone, wrong species, anatomy, pose sheet, drift, gate false reject, and wrong SceneSpec must keep stable meanings.

Productize `probe_qc.py`, `probe_color.py`, and `calib-cast-gate/run_calib.py` into one offline gate lab. It should load a dataset version, replay stored bytes through a gate release, cache judge results by image and gate hash, and report:

- Confusion matrix by gate and slice.
- Critical defect recall.
- False reject rate and its dollar cost.
- Score distributions and calibration by score band.
- Candidate versus production delta.
- Eval cost.

Threshold governance: a gate release records question or rule hash, judge and fallback models, accept and reject bands, dataset version, locked test result, expected false reject cost, expected escape rate, owner, approval, and rollback release.

Anatomy needs three bands, not one cliff: clear reject, adjudicate, and accept when other gates pass. The color evidence supports the current 0.3 color bar. It does not prove the line bar. Build the line distribution and derive the line bands from it.

A candidate gate reaches production only when the eval report shows no material loss in critical defect recall, lower expected cost per accepted page or a documented quality gain worth the cost, and no unexplained regression on protected slices such as same species pairs, reflections, and background flocks.

### 5. Shadow, canary, and release bundles

A release bundle pins prompt templates, model routes, gate policy, reference policy, and retry policy. Every run records the bundle ID.

- **Shadow gates:** Evaluate live or stored attempts without deciding. Compare would be accepts, rejects, score drift, and cost.
- **Shadow text judges:** Replay stored plans and read pass inputs. Record verdict changes.
- **Generator canary:** Start with the pilot chapter. Move to a deterministic, difficulty stratified slice of pages, then one full book. Duplicate generator shadow is paid media, so use it only for a tiny sample or not at all.
- **Book consistency:** Keep one release pinned inside a book unless the manifest records a deliberate change.

Guardrails: first attempt acceptance, rolls per accepted page, held rate, human verified escapes, cost per accepted page, forecast error, provider errors, and latency.

An experiment needs a hypothesis in dollars and defects. "New prompt" is not a hypothesis. "Single pose crops on two character pages will reduce clone holds and rolls per accepted page without increasing human escapes" is.

### 6. Human review as a labeling queue

The hub already has the pieces: the Attempts viewer, Story Review notes in `review_notes`, approvals in `page_approvals`, change requests in `change_requests`, and Repair force lists. They do not yet learn from each other because they key on different things.

Build one queue with views for:

- Held pages.
- Gray zone scores.
- Advisory gate flags.
- Canary samples.
- Random accepted page audits.
- Repair before and after verification.

Each item shows the image, the parent line image for color work, the SceneSpec in plain language, gate scores, deciding reason, and spend already on the slot. Labels must be structured and tied to an attempt or artifact ID:

- Ship it.
- Text defect.
- Clone or count defect.
- Wrong or missing cast.
- Anatomy defect.
- Pose sheet or not a scene.
- Character drift.
- Color fidelity defect.
- Gate was wrong.
- SceneSpec was wrong.
- Editorial decision needed.

A note can explain a label. It cannot replace it. When a human overrides a gate, record whether the gate was wrong, the defect was acceptable, or the SceneSpec was wrong. Each answer fixes a different part of the system.

### 7. Budgets, routing, retry, and cache

**Budgets.** Replace `spendCapHit` as the main control with a budget object and unified ledger. Keep a hard cap as a safety limit during migration. Every external call gets a ledger row: actual, estimated, or unpriced. Before art, forecast text, rolls by page difficulty, judging, and repair allowance. If the forecast exceeds the budget, park and show the math. Repair gets an allowance inside the book budget. Starting another workflow must not reset the spend window.

**Model routing.** Route by task and difficulty, not role alone. Difficulty signals: cast count, same species pair, speaking role, reflection or water, background crowd, prominent feet or wings, finale or cover, prior failure, and sparse solo colorize risk.

- Tier 0: code checks and cached results.
- Tier 1: standard image and Clef path for ordinary pages.
- Tier 2: single pose crops, stronger references, cast listing, or a second judge when difficulty or score band earns it.
- Tier 3: premium model or human review for covers, finales, repeated failures, and high cost mistakes.

`models.ts` already has writer and judge chains, but fallback can silently lower quality. For high stakes work such as the read pass, define a minimum tier. If it is unavailable, park or mark the run degraded. Do not present a fallback verdict as equivalent.

**Failure aware retry:**

| Failure | Next action |
| --- | --- |
| Transient provider error | Retry under the same reservation and attempt rules |
| Purity speck in autofix band | Transform and remeasure. Buy no roll |
| SceneSpec or prompt ambiguity | Fix the spec or prompt, then generate |
| Clone or count | Change composition or reference policy, usually to a single pose crop |
| Cast mismatch | Verify SceneSpec and reference identity before another roll |
| Anatomy gray band | Adjudicate before another roll |
| Anatomy clear defect | Redraw with a targeted constraint |
| Same failure twice | Stop and queue, unless escalation changes the strategy |

**Cache and dedup.** Cache by content and release fingerprint: read pass reports, critic results, gate results, reference resolution, and assembly. Deduplicate completed stage fingerprints, repeated provider requests inside a stage, identical output bytes, and repair work whose parent artifact and defect have not changed. A cache hit must name the release that produced it.

### 8. Release manifest

A book ships from a manifest, not from whatever files occupy canonical R2 keys during assembly.

The manifest names the bible, plans, selected line and color artifacts for every slot, each color artifact's parent line artifact, cover and back cover, PDFs, read pass report, release QA report, and stage release bundles.

Final QA verifies:

- Every planned slot has one selected artifact.
- No selected slot is held.
- Every color artifact descends from the current line artifact.
- PDF page sequence matches manifest artifact hashes.
- Cover, captions, back cover, and matter use current inputs.
- Gray zone overrides and audit samples are in the review queue.

Canonical R2 keys can remain as projections for the hub and editor during migration. They stop being the identity.

## Phased migration plan

Phase 0 is a prerequisite. The remaining phases are ordered by expected dollars saved per effort.

### Phase 0: Identity and ledger patch

**Work:** Extend `logGenAttempt` and `logGenEvents` in `bookbuild.ts`, or add v2 replacements, with run ID, workflow instance ID, stage, attempt UUID, release ID, prompt hash, model, judge model, gate version, and parent hashes. Return the answering Clef model and fallback status from `ai.ts`. Return the image model from `gateway.ts`. Add run and release context to `text_events` in `models.ts`, and ledger coverage for Jev, cast listing, and any live legacy planner path. Record parent line hash in `colorize.ts`. Make attempt R2 keys unique. Add the shared `emit(...)` event helper, `production_events` and `span_events`, Analytics Engine bindings for `factory_events`, `factory_gate_scores`, and `factory_costs`, and the first Mission Control run list and run detail queries. Enable Workers Traces for the factory worker and stamp `run_id` and `trace_id` into structured logs so the telemetry API can tail one run.

**Effect:** $0 direct. It makes every later saving claim testable and every live run inspectable.

**Proof:** At least 95% of new attempts fully identified in week one, then 100%. Unique keys for 100% of archived images. Every external call type is priced, estimated, or explicitly unpriced. A shipped page can be traced without worker logs. Every new run appears in Mission Control with a heartbeat, a span timeline, QC results, and a cost subtotal while it is still running.

### Phase 1: Gate lab and anatomy adjudication

**Work:** Build dataset v0 from attempts, cast calibration, cast audit, purity examples, and verified sweeps. Build one eval runner under `factory-ops/` from the probe and calibration scripts. Put question text and thresholds in `ai.ts` and `purity.ts` behind named gate policy versions, starting with exact current behavior. Build the line anatomy distribution. Add a gray zone path to the loops in `bookbuild.ts` and `colorize.ts`.

**Effect:** Highest direct saving. Scenario math from the D1 baseline: line first attempt acceptance from 52.2% to 65% lowers a 40 page line surface from about $4.60 to $3.69 in image rolls, saving about $0.91. Colorize from 34.6% to 45% lowers a 40 page surface from about $6.94 to $5.33, saving about $1.61. These are planning scenarios, not promises.

**Proof:** Locked test recall and false reject rate by gate and slice, first attempt acceptance, gray zone overturn rate, adjudication cost, and human escapes per 100 shipped pages.

### Phase 2: Failure aware retry and real budgets

**Work:** Replace the uniform three roll pattern in `bookbuild.ts`, `colorize.ts`, `regen.ts`, and `repair.ts` with a retry planner keyed by failure class. Checkpoint each attempt so a workflow step retry resumes after the last persisted attempt. Add budget reservation, unified ledger reads, stage allocations, and preflight forecasts to the build, colorize, regen, and repair workflows. Permit a third roll only after a strategy change or adjudication, apart from transient provider retries.

**Effect:** Attack the low yield tail. Attempt 3 cost $5.54 in line events and $4.93 in colorize events in the metered window, with under 11% acceptance on both. A planning target is $0.50 to $1.50 per book after Phase 1, judged by rolls per accepted page rather than assumed.

**Proof:** Rolls per accepted page and per shippable book, attempt 2 and 3 yield by failure class and strategy, forecast versus actual by stage, and repair cost per resolved defect.

### Phase 3: SceneSpec and legacy adapter

**Work:** Add the schema and validator in `planv3.ts` or a new `scenespec.ts`. Make prompt rendering, `loadPageRefs`, QC expectations, and colorize references consume it. Backfill legacy plans into SceneSpec artifacts with source and confidence. Make `repair.ts` diff any proposed scene against the current SceneSpec and require approval for cast, speaking role, beat, or concept changes.

**Effect:** Prevents the Mira incident class. One avoided run of that size saves $5.39 in direct rolls plus review and rerun time. Multi character pages should also gain first attempt acceptance because artist, references, and QC finally share one cast.

**Proof:** 100% of new pages have a valid SceneSpec. Multi character first attempt acceptance is reported separately. Wrong cast and clone escapes fall. Automated cast changing simplifications without approval reach zero.

### Phase 4: Review queue and label loop

**Work:** Extend the hub Attempts page with structured labels tied to attempt IDs. Link Story Review and `review_notes` to attempt and artifact IDs when a note concerns a roll. Add held, gray zone, flag, canary, and random audit queues. Export labels into versioned eval datasets. Feed verified defects into repair with artifact ID and defect class.

**Effect:** Indirect and compounding. CG's review time becomes training and calibration data, reducing repeat full book sweeps and future false rejects.

**Proof:** Percent of held and gray zone items labeled, median decision time, gate overturn rate by gate, repeat defect rate, and random audit escape rate.

### Phase 5: Release bundles, canary, routing, and cache

**Work:** Add the release registry and pin release IDs on runs. Add gate shadow replay and generator canaries in `bookbuild.ts` and `colorize.ts`. Add SceneSpec difficulty routing across `models.ts`, `gateway.ts`, and `ai.ts`. Add fingerprint caches for read pass, critic, gate, reference, and assembly results. Record fallback as a route event.

**Effect:** Unknown until measured, by design. A cheaper model, new prompt, or new reference policy earns production only by lowering cost per accepted page at equal or better human verified quality.

**Proof:** Experiment spend, sample size, control versus candidate cost per accepted page, held rate, human escapes, cache hits, paid calls avoided, and fallback rate.

### Phase 6: Shared page service and manifests

**Work:** Extract the duplicated generation and gate behavior from `bookbuild.ts`, `colorize.ts`, `regen.ts`, and `repair.ts` into one page production service with line, picture color, and colorize adapters. Make Repair a defect planner over that service. Assemble in `pdf.ts` and `matter.ts` from release manifests. Keep `versioning.ts` snapshots for recovery, not as the only history.

**Effect:** Lowest direct dollar return and highest refactor cost, so it goes last. The return is fewer workflow specific defects, no stale assembly class, and one place to improve page production.

**Proof:** 100% of shipped books have complete manifests, zero stale assemblies, and no gate behavior that exists in one workflow but not another.

## Keep, stop, and do not build yet

### Keep

- The whole book read pass, its block and warn split, quoted evidence, code recomputed verdict, and fingerprint reuse.
- The pilot gate. It is the human canary.
- The no ship rule. Failed pages hold.
- Deterministic bible, forbidden term, aspect, and purity gates, including purity autofix.
- Structured scenes in `planv3.ts`.
- Pose crops and the crops coverage gate.
- Cast listing in flag mode until a new corpus earns hard mode.
- Repair audit and re-audit.
- Book snapshots for recovery.
- The attempt archive and Attempts viewer.
- One book at a time while budgets and gates are rebuilt.

### Stop

- Stop parsing prose prompts to recover cast or identity.
- Stop changing thresholds without a labeled replay and written result.
- Stop treating a Clef score as a calibrated probability.
- Stop buying a third identical roll by default.
- Stop letting repair remove a character to make a page pass.
- Stop resetting effective spend by starting another workflow.
- Stop using file existence or R2 timestamps as proof of currency.
- Stop letting model fallback change quality silently.
- Stop storing decisions only in logs, chat, or code comments.
- Stop calling workflow completion success. Report manifest completeness, cost per accepted page, and human verified escapes.
- Stop hand patching generated outputs when the defect belongs to a prompt, template, gate, or pipeline mechanism. Editorial fixes to a book's own plan or text remain allowed.
- Stop discarding paid outputs, prompts, scores, or reasons.

### Do not build yet

- No custom image model or fine tune until the eval set proves artist capability, not spec or gate failure, is the dominant remaining problem.
- No platform rewrite. Current volume does not need Kubernetes, Kafka, or a microservice fleet.
- No automated threshold promotion. Software can propose. A person promotes.
- No vector search for attempts. IDs, hashes, labels, and score queries answer the current questions.
- No hub rewrite. Connect review data to factory IDs and let the hub consume manifests when they exist.

## Operating dashboard

Mission Control is the live view. The weekly report is the trend view. Report weekly by book, surface, and release, always with denominator and time window:

- Active runs, heartbeat age, stuck stages, and alert count.
- Lineage completeness and priced cost coverage.
- Forecast versus actual cost.
- First attempt acceptance.
- Paid rolls and cost per accepted page.
- Held rate and median adjudication time.
- Gate false reject rate.
- Gate score distribution drift by release, model, and scene slice.
- Provider latency, error rate, and fallback rate.
- Human verified escapes per 100 pages.
- Repeat failure rate.
- Repair cost per resolved defect.
- Cache hits and paid calls avoided.
- Canary versus control delta.

## Decisions for CG

1. **What does $3 buy?** Recommendation: separate base line, color increment, and complete sellable book budgets. A single $3 target covering both 40 page art surfaces is not reachable at the current roll price.
2. **Who adjudicates gray zone pages?** Recommendation: CG labels the seed set and audits samples. Once the taxonomy is stable, the queue can decide ordinary gray zone cases. Critical defects and cast changes stay with CG.
3. **May automated repair change cast?** Recommendation: no. Cast, speaking role, beat, or concept changes require explicit human approval tied to a SceneSpec diff.
4. **How long are attempts kept?** Recommendation: keep all bytes and records for now and report storage cost monthly. Revisit only when measured cost is material.
5. **May releases canary under standing authority?** Recommendation: yes, inside a fixed experiment budget and guardrails. Full promotion still needs a recorded decision.
6. **What if the preferred text model is unavailable?** Recommendation: park or mark degraded for high stakes gates. Do not silently treat a lower tier verdict as equivalent.
7. **How much review time per book is acceptable?** CG should set a minute target. If the queue needs more, the scenes or gates are not ready to scale.
8. **Is color part of the base book or an increment?** Recommendation: keep the separate production process and budget that already exist, even when the customer offer bundles the result.
9. **Where do traces and analytics live long term?** Recommendation: Analytics Engine for the hot 90 day window, D1 for exact run and QC facts, and R2 JSON Lines for the durable archive. Defer an external APM or warehouse until query volume or multi service tracing earns it; the event and span contract stays portable either way.

## Recommended next move

Approve Phase 0 and Phase 1 as one small build. Add the missing identity fields, build dataset v0 from art and judgments already paid for, replay anatomy and cast gates offline, and bring back one gate release report with distributions, false reject cost, and a proposed line anatomy gray band.

Do not fire another full book run to test the architecture. Test it offline first.

## Appendix: claim map

| Claim | Source |
| --- | --- |
| Current artist is gateway Nano Banana, not FLUX | `src/ai.ts` comments; `src/gateway.ts` |
| Mira colorize cast mechanism | 2026-11-01 run record; comments in `src/colorize.ts` and `src/bookbuild.ts` |
| Color anatomy clean range and broken example | 2026-11-01 probe census; bar comment in `src/ai.ts` |
| 18 line rejects on Mira S3 page 0 and S6 page 3, $1.076 | D1 `gen_attempts`, slug `mastery`, kind `line` |
| Cast listing recall, precision, and false rejects | `~/workspace/factory-ops/calib-cast-gate/CALIBRATION.md` |
| Read pass design and fingerprint reuse | `src/readpass.ts` |
| Run cap scope | `spendCapHit` in `src/bookbuild.ts` |
| Attempt schema and R2 key pattern | `logGenAttempt` in `src/bookbuild.ts`; D1 schema |
| Repair rewrite and simplification branches | `escalateRepairImage` in `src/repair.ts` |
| D1 totals and attempt rates | `gen_events` and `gen_attempts`, snapshot 2026-11-01 21:41 UTC |
| Analytics Engine shape and retention | Cloudflare Analytics Engine limits docs: up to 20 blobs, 20 doubles, one index per data point; data stored for three months |
| Workers logs, traces, and export surface | Cloudflare Workers observability docs: Workers Logs, real time logs, Tail Workers, Logpush, automatic trace instrumentation, and OpenTelemetry export |
| Factory worker logs are queryable now | Cloudflare observability telemetry API verified live 2026-11-01 against the `kidsbook-factory` service |

## Addendum (2026-11-01 evening): use the whole Cloudflare storage menu

The owner directed that the redesign use as much of the Cloudflare platform as fits, rather than forcing every job through D1 and R2. Mapping, against the official storage guide's own use cases:

| Factory job | Product | Why |
| --- | --- | --- |
| Exact run, QC, label, and ledger facts | D1 | Relational, ad hoc SQL, already the control plane |
| Artifacts, attempt bytes, PDFs, event archives | R2 | The guide names machine learning training datasets and analytics datasets as R2 use cases; zero egress |
| Gate policy versions, prompt versions, feature flags, release config | Workers KV | Configuration data with high read rates and rare writes; eventual consistency is fine for config |
| Per book budget reservation and run coordination | Durable Objects | Strongly consistent, transactional storage with global ordering: the spend cap stops being per workflow and becomes one locked counter per book, and a run's live status can stream from its object |
| Appeals judging, event fan out, batched writes | Queues | Guaranteed delivery task processing; second opinion jobs and analytics writes stop riding inside generation calls |
| Hot metrics and QC score distributions | Analytics Engine | Time series with SQL, as specced in the analytics plane |
| Production event stream to multiple consumers | K2 | Later, when alerting, archiving, and feature building each need the same retained event log; Queues first, K2 when volume earns it |
| Telemetry ingestion into queryable R2 datasets | Basin Pipelines | Later, for streaming production events into R2 in queryable form |
| Defect knowledge base retrieval | Vectorize | Later: embeddings over labeled attempts so a judge or a prompt revision can retrieve "pages like this one" before deciding; not a v1 dependency |
| External Postgres, if one ever exists (for example on AWS) | Hyperdrive | Only as the bridge to an outside database; nothing in v1 needs it |

Judge seat update, same evening: the owner chose **GPT-6 Luna through the Vercel AI Gateway's Decisions API** as the QC judge direction, replacing Clef after validation. Decisions is the same typed shape as Clef (predicate probabilities, choice, score) from a frontier model, with per question reference images and prompt caching. The second opinion tool (`factory-ops/second_opinion.py`) already speaks it: `--judge luna` is the default backend, logging to `qc_second_opinions`. A route probe on 2026-11-01 returned 402 (billing) rather than 404, so the gateway route exists and only the balance blocks the first real call. Clef keeps its seat until Luna beats it on the archived, human labeled set; the swap is then a judge version change inside the gate governance process, not a rewrite.
