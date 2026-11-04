# Reliability Slice 1: error states, migrations and provenance

Approved scope: PR #6's three admin/migration follow-ups and deployment/run
provenance. Started from `ff1250f`, reconciled with newer main before handoff.
No deployment, paid call, production data write or workflow run was performed.

## Admin and migration changes

The readiness page reads complete inventory once, then counts approvals against
it. Inventory failure renders **Unverified** with null counts; approval-read
failure preserves the known inventory but an unknown approval count. Neither
unlocks Colorize. Approve-all is disabled when inventory is unknown.

Bulk approval returns 409 `INVENTORY_UNVERIFIED` before preparing mutations on
an inventory failure. A save failure returns 503 `APPROVAL_SAVE_UNCONFIRMED`
and asks the operator to reload: a transport error cannot establish whether a
transaction committed. Existing publish gates and override authority remain.

`db/migrations/0001_release_and_run_provenance.sql` gives `publish_releases`
its migration home and adds `worker_runs` with indexes. Applying twice preserves
the existing Phase 1 rows. Hub D1 config points to `db/migrations`.
Publish no longer creates its table inline. RGM must apply the migration to the
shared hub/factory database before rollout; Codex applies it only to in-memory
SQLite. Historical source identity is never backfilled from today's build.

## Offline build and deployment contract

After merging and installing the existing dependencies:

```sh
bun run build
# Factory, from the repository root:
python3 scripts/build_worker.py factory
```

The build driver requires clean committed source, refuses untracked code/config
inputs, and verifies the source commit again after building. Untracked Markdown
reports may remain. Hub builds Astro plus the scheduler wrapper; factory builds
`src/index.ts` with the declared local esbuild dependency. No dependency download,
credentials or upload occurs in the build driver.

The receipt hashes actual upload artifacts: hub server modules/client assets,
or factory worker bundle. Entries include relative path, byte count and SHA-256.
The build digest hashes canonical JSON with schema, logical worker, source SHA
and sorted artifact entries. It excludes itself and deployment metadata to avoid
a self-referential bundle hash. It identifies artifacts, not a hermetic build.

Current receipt: `dist/build-provenance.json` or
`factory/dist/build-provenance.json`. Every build invocation also appends records
under `.deployment-records/builds/<id>.jsonl`. Keep these outside dist: Astro
clears dist. Never prune the records. They are ignored by Git.

Both uploaders are import-safe and require the receipt before any API call.
They verify current source and the exact upload artifact set, and rehash bytes
read for upload. Equal-size edits, dirty/stale source, wrong worker/digest and
extra/missing modules fail preflight. Upload no longer rebuilds the bundle.
The `deploy` package command now uses the existing Python API uploader, as
`deploy:api` already did. Direct cf/Wrangler upload bypasses this attribution
path and is not this slice's supported deployment recipe.

Only RGM deploys merged main after verifying factory workflow inactivity. This
work authorizes no deployment. The uploader creates a deployment UUID, appends
intent under `.deployment-records/deployments/<id>.jsonl`, and sends a plain-text
`BBS_BUILD_PROVENANCE` binding containing schema, logical worker, source SHA,
build digest and deployment ID. Completion or failed/unconfirmed status appends
to the same journal. Hub records worker-upload success before schedule checking.
Provider version ID is retained when returned, otherwise null; none is invented.
Receipts include no credential or asset-upload JWT. Keep/back up the operator's
receipts; they are not public assets or a replacement for a shared ledger.

## Run attribution and unchanged policy

All seven factory workflows checkpoint attribution before other work, using
platform instance ID and creation timestamp. The key includes operation,
run/timestamp and deployment/build identity: replay is idempotent; restarts and
observations on later deployments append. Hub scheduler invocations and
successful publish release IDs are attributed too. Budget run-start logic is
unchanged.

`worker_runs` records operation/book/run, deployment ID, source SHA, artifact
digest and times. Missing/malformed/wrong-worker binding produces explicit
`unknown` with null identity fields. Extra binding fields are not logged.
DB/migration outages log `recorded: false` and do not change acceptance. This is
observability, not CG's pending durability-first policy. No judge, automatic
approval, paid-attempt archive or fail-open budget semantics change here.

## Evidence, amendments and open decisions

The Fenix ledger/summary on main match both SHA-256 values RGM provided. No
ledger is edited; Opus labels remain model labels and CG's verdicts human gold.
No Doop frame is changed. CG still owns budget scope/length scaling, Penny/heron
canon, labeling time/session, pilot/bench spend, thresholds and durability-first
acceptance. Proposed thresholds are not settled policy. Slice 4 will model
$0.07/roll with $0.06 alongside as the optimistic bound, under both budget
readings. No canon or threshold is encoded in this slice.

Next slices, after RGM review: manifest-based assembly/coloring finales and
hash-bound approvals/QA; immutable promotion; offline imports/bench and the
concrete labeling manifest. SceneSpec must derive from existing plans/bibles
without re-planning. Slice 5's merge/fixture-only conditions remain; 6–8 are not
authorized by this work.

## Offline verification

Run every `tests/*.test.ts` file in a separate Bun process and compare exit codes
and failure signatures per file. External fetch is disabled; the Turnstile
test's loopback stub remains allowed. Existing failing files are compared too.
New tests exercise actual readiness frontmatter, no-write inventory failures,
save failures, migration preservation, run replay/deployment attribution,
unknown metadata/DB outages, and both uploaders with fake API transports,
tampered bundles/source and append-only failure journals.
