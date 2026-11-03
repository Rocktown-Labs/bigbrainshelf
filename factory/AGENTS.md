# Factory agent rules

Read the repository root `AGENTS.md`, this folder's `README.md`,
`PIPELINE.md`, `MODELS.md`, and `CLOUD_BUILD_CONTRACTS.md` before editing
factory code.

- `factory/src/` is the shared source for the kidsbook-factory Worker.
  Reassembly is implemented in `repair.ts` and `bookbuild.ts`; there is
  no `reassemble.ts`.
- Work on an agent branch and open a pull request. Do not deploy from an
  unmerged branch.
- Before any deployment, the operator must use the merged repository
  state, confirm no factory workflow is already running, build the bundle
  from `src/index.ts`, verify a marker from the change is present in the
  bundle, and only then run `deploy.py`.
- Deployment credentials are external to this repository and are granted
  separately. A repository grant is not deployment authorization.
- Preserve the attempt archive. Every generated or paid attempt, verdict,
  score, and reason must remain recorded; do not add a code path that
  discards those records.
- As of 2026-11-03, book generation is paused while the catalog is being
  normalized and fixed. Do not start generation unless CG explicitly
  lifts that pause in the task.
