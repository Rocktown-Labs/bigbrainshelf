# Legacy provenance adoption

This is a reviewed data operation on plan identity fields, before Slice 3. It
never generates art, changes image/PDF bytes, clears held states, approves,
publishes, mutates D1, or runs a factory workflow. Production execution belongs
to RGM, book by book, from merged source with generation paused and book writes
frozen. Codex has used offline fixtures only.

## Binding policy approved by RGM/CG

The report names the evidence tier for each artifact. They are not equivalent:

- Byte-exact audit/edition evidence: current SHA-256 and size match preserved
  artifact evidence. An editions export must include the complete chain from
  its null parent; raw R2 manifest hashes and parent links must agree with D1
  rows. Only the latest qualifying pre-audit manifest per edition is used.
  A manifest proves only artifacts it actually lists, not every page in a book.
- Fingerprint plus closed write log: recompute the existing names/sizes
  fingerprint over exactly the factory snapshot predicate and compare it to
  the latest version at/before the audit. The complete exported production_events
  and gen_attempts rows, and every post-audit versions entry, need one reviewed,
  row-hash-bound classification. Counts must match the exported row totals.
  The operator attests log completeness and a write freeze continuing from the
  export boundary through adoption. This is the explicitly approved operational
  continuity assumption; it is not byte-exact historical hashing.
- Named Mira drift fixes: only the reviewed, finite list (at most six) is
  eligible. Each entry must name its accepted gen_attempts row, archived bytes
  that hash-match the live artifact, and a post-attempt QC replay against that
  live key. Related production-event/version refs must be explicitly listed.
  QC/live association still depends on the approved closed-log assumption.

Every artifact also needs a unique matching audit inventory row, and the local
inventory/cast audit bytes must exactly match the R2 audit copies. Chapter,
story/finale and line counts must match. The book_qa export is preserved with
its negative flags intact; adoption does not turn it into a clean result.

Unexplained writes, uncovered/truncated exports, fingerprint mismatches,
changed evidence, duplicate/absent audit rows, conflicting existing identity or
unverifiable artifacts are report-only. Independently byte-exact bindings can
still support their specific artifacts. Existing identities matching current
bytes remain untouched; they are not new adoption claims.

Color needs an additional binding: the color audit row must identify the exact
current line SHA-256. Separate proofs that a line and a color image both exist
are not proof they form a twin. No color identity is stamped without that
pairing. Existing current color identities remain unchanged. Missing color
pointers are reported rather than silently attaching old orphan twins. In
particular, Maisie's line pages can be adopted independently; unverified color
pages and the prior-edition color PDF remain unverified. Tilda (`iwillteach`)
is always report-only and remains parked. No other plan fields are changed.

The version fingerprint is the existing 32-bit names/sizes checksum, not a
content digest. Its file set includes plans, bible, line/color image prefixes,
picture/coloring PDFs, editor data and book info. It excludes covers, the color
PDF and other files outside that predicate. Same-size edits cannot be detected
by that checksum alone. Logging is best-effort in the current source, so an
empty table cannot prove a closed log: the integrator's explicit attestation is
required. The tool does not infer an operational guarantee from code that can
drop bookkeeping errors. A size-changing Penny plan edit fails the strict full
fingerprint rule even when classified text-only; it is reported, not silently
exempted. No durability policy or budget fail-open behavior changes here.

## RGM operator procedure

Prerequisites: Bun, the existing core/factory dependencies, and AWS CLI v2 with
S3 PutObject --if-match support. S3 credentials come from the operator's normal
AWS environment/profile, never files committed here. The endpoint is restricted
to the selected Cloudflare account and bucket; keys are restricted to one book.
The tool cannot write anything except conditionally replacing that book's
existing plans/S{n}.json objects. Original HTTP metadata is retained.

Prepare read-only exports while book writes are frozen. Preserve the exact
local judgment-run inventory/cast files and raw R2 copies; do not add invented
hashes to historical ledgers. Export book_qa for the one book. Export complete
production_events/gen_attempts rows since that book's actual audit cutoff, plus
independent COUNT(*) totals for the same interval. Do not use a LIMIT-truncated
response. Export Mira's editions rows when available. This tool itself makes
no D1 calls. Do not include credentials, customers or unrelated service data.

Create an evidence index (outside Git until reviewed), pinning each source file
by SHA-256. Hashing these source documents establishes their integrity, not an
image's historical hash. File paths are relative to the index:

```json
{
  "schema": "adoption-input/v1",
  "slug": "INTERNAL-BOOK-SLUG",
  "sources": {
    "inventory": {"file": "inventory.json", "sha256": "64-hex-document-hash"},
    "line": {"file": "cast-audit-line.json", "sha256": "64-hex-document-hash"},
    "color": {"file": "cast-audit-color.json", "sha256": "64-hex-document-hash"},
    "bookQa": {"file": "book-qa.json", "sha256": "64-hex-document-hash"},
    "continuity": {"file": "continuity.json", "sha256": "64-hex-document-hash"},
    "editions": {"file": "editions.json", "sha256": "64-hex-document-hash"}
  }
}
```

Color/continuity/editions are optional; without a sufficient alternative tier,
absence produces a report-only artifact. The three mandatory files are
inventory, line and bookQa. Original strings and pinned origin paths are
retained in every run. `bookQa` must contain slug (or book_slug), source and
measured_at, plus the actual original measurement fields.

The continuity export is new evidence about the closed write history. It
preserves full raw rows and adds explicit reviewed classifications, rather than
rewriting an old audit:

```json
{
  "schema": "adoption-continuity/v1",
  "slug": "INTERNAL-BOOK-SLUG",
  "auditAt": 0,
  "coverageFrom": 0,
  "coverageThrough": 0,
  "counts": {"production_events": 0, "gen_attempts": 0},
  "attestation": {"by": "RGM", "complete": true, "writeFreeze": true, "freezeFrom": 0},
  "production_events": [],
  "gen_attempts": [],
  "classifications": [],
  "exceptions": []
}
```

Replace the zero times with actual Unix seconds. coverageFrom must cover the
audit cutoff; coverageThrough is the export boundary; freezeFrom must equal
that boundary. The operator attests that the write freeze remains in force.
For each raw row use `{ref: "table:id", rowHash, kind, keys}`. The hash is the
existing canonical revisionHash(row); kinds are non-image or image-write.
Accepted/autofixed attempts cannot be classified as non-image observations.
All post-audit versions entries also need a classification, ref versions:N.
Unknown image writes block the continuity tier for the book.

A Mira exception is `{kind: "mira-drift-fix", key, ref: "gen_attempts:N",
qcKey, relatedRefs: [...]}`. It binds to the archived image_key from that exact
accepted attempt. The QC replay must contain one matching results row and a
measured_at (or row ts) after the attempt and within the export interval. If
that replay records an artifact SHA, it must match too. No generic exception
for arbitrary writes is provided. Non-image Penny edits do not waive the
fingerprint requirement. Tilda's plan revisions do not make her adoptable.

An editions export is `{schema: "adoption-editions/v1", slug, auditAt, rows}`.
Rows are unmodified D1 editions rows (id, slug, edition, manifest_key, hash,
parent_hash, created_at). R2 manifests are fetched and verified; the tool never
creates or repairs an editions chain.

Dry-run is the default and makes **zero remote writes**:

```sh
bun factory-ops/adopt.ts --slug INTERNAL-BOOK-SLUG --account ACCOUNT_ID --evidence /path/index.json
```

Inspect the complete report.json, per-page reasons/tiers, proposed plan patches,
current manifest, named PDF deltas and all evidence. canApply means some plan
identity changes are independently eligible, not that the book is approved or
that its proof is complete. Save the reviewed report. Apply requires that exact
report fingerprint, clean reviewed source and a fresh recapture of live bytes
and evidence:

```sh
bun factory-ops/adopt.ts --slug INTERNAL-BOOK-SLUG --account ACCOUNT_ID --evidence /path/index.json --apply --review /path/to/dry-run/report.json
```

Every invocation creates a new dated book/UUID folder under factory-ops/audits
(or an explicit --ledger-root). Reports, raw source documents, fetched objects,
read/list receipts, exact original plan bytes and applied patches are retained.
The JSONL ledger is fsynced before any write. Plan puts use atomic If-Match,
then are read back and hashed. The conditional-write behavior follows the
[Cloudflare R2 contract](https://developers.cloudflare.com/r2/api/s3/extensions/). Any ambiguity is recorded as failed/unconfirmed;
no rollback overwrites newer data and no incomplete run reports completion.
Multi-plan adoption is not a distributed transaction. A partial failure needs
RGM review and a new dry-run, using the preserved original plans; the tool does
not automatically waive a now-changed fingerprint to resume.

Only RGM runs this procedure against production after merge. Commit reviewed
per-book ledgers through the normal integrator workflow. Never prune/deduplicate
any run, original, rejected case or fetched object.

## Reassembly proof after adoption

Adoption never writes a PDF, PDF metadata or an assembly receipt. Existing PDFs
therefore are not silently legitimized. A separate post-adoption reassembly and
human review are required before new approvals. This PR tests those steps
entirely offline; it does not execute them in production or start Slice 3.

Expected counts come from the adopted inventory plus the **current PDF builder's
actual glossary layout** and front/back matter. The legacy PDF counts are parsed
and checked against the audited counts. Every delta needs a named known class:

- Coloring omits exactly one finale per chapter: omitted-coloring-finales.
- Wells/docker story has exactly 17 extra pages: legacy-chapter-divider-pages:17.
- Mira has exactly one extra page: mira-legacy-extra-page:1. This can combine
  with omitted coloring finales.
- Maisie's color edition with incomplete verified current twins is blocked as
  prior-edition-color-twins, even when the old PDF happens to have the expected
  count. No count match can establish a valid color edition.

There is no approximate-count tolerance. Unexplained deltas, unreadable/missing
PDFs and changed audit counts are reported. An unexplained delta blocks the
book's adoption proof, while independently supported page adoption may proceed
under RGM's amended instruction. Missing color identity blocks color reassembly;
line identity can still pass. Books with equal complete legacy/current counts
prove equality directly. No plan text is rewritten to make the count fit.
