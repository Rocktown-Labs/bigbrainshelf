# Big Brain Shelf factory — shared source

Shared source for the factory worker and the judgment-run records. Other
authorized agents work from this repository copy; see
`../docs/agent-access.md` for how repository access is granted.

## Layout

- `factory/` — the kidsbook-factory Cloudflare Worker source: `src/`
  (bookbuild.ts, colorize.ts, repair.ts, pagefix.ts, ai.ts, pdf.ts and
  the rest), `deploy.py`, `package.json`, `wrangler.jsonc`, and the
  design docs (PIPELINE.md, MODELS.md, CLOUD_BUILD_CONTRACTS.md).
  There is no reassemble.ts: reassembly lives in repair.ts and
  bookbuild.ts.
- `factory-ops/` — the audit and operations tooling that runs against
  the factory from outside (cast_audit.py, pdf_cast_audit.py,
  pdf_vision_qc.py, inventory_sync.py, the QC probes and judge tools),
  plus the November architecture reviews.
- `factory-ops/audits/2026-11-02-judgment-run/` — the Nov 2–3 judgment
  run ledgers, per book: `cast-audit-<slug>.json` and
  `cast-audit-<slug>-color.json` (page-by-page cast judgments),
  `pdf-audit-<slug>.json` (the three delivered PDFs compared),
  `inventory-<slug>.json` (plans vs images vs PDFs vs editor), and
  `pdf-qc-reports/` (the PDF gate behind each book's readiness row).
  Tilda has no pdf-qc report: she has no PDFs to gate. Juno has no
  color cast audit: she has no color edition. The same ledgers live
  durably in R2 under `books/{slug}/audit/`.

## Canonical source

This folder is the shared source of truth for agent collaboration. RGM's
VM factory tree remains the deployment workspace. Before deploying, the
operator pulls and reconciles this repository, builds from the merged
state, and commits any factory change back here. An uncommitted change
that exists only in a deployment workspace is not shared source.

One-off migration and patch scripts from the VM were left behind; the
judgment-run tooling above is the complete set that produced the ledgers.
