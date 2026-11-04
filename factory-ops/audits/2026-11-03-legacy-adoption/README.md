# Legacy adoption evidence, Nov 3, 2026

No production adoption has been executed by Codex. Subfolders prefixed
`offline-fixture-` contain actual executions against synthetic in-memory data,
not catalog evidence or human gold. They exercise identity adoption and preserve
the original plans, input manifest, evidence sources, decisions and stamped
hashes. The image payloads in this minimal fixture are literal test strings;
real PDF count/approval proofs run in tests/adoption-proof.test.ts.

RGM's production dry-run/apply tool creates a fresh book-and-UUID subfolder on
every invocation. Keep every folder, raw object read, report and ledger. Never
replace a fixture or production run with a later result. New measurements get
new folders. Commit completed production reports through the integrator's normal
review workflow, after checking that they contain no credentials or customer data.
