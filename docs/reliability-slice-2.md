# Slice 2: assembly and approval identity

Base: fetched main `a0dcbc5`. Slice 1's branch is untouched. This slice covers
assembly inventory, coloring finales, color/line provenance, and approval
identity. It does not implement immutable release promotion (Slice 3).

## Assembly contract

`factory/src/assembly.ts` is the sole caller of the PDF builders. Book build,
regen, repair, standalone reassembly and colorize use it. The legacy per-chapter
workflow refuses before generation: it cannot establish the canonical book
inventory. Its old artifacts remain stored; there is no compatibility bypass.

The shared validator derives the chapter inventory from the stored bible and
plans, including exactly one required finale per chapter. Missing, empty,
malformed or extra plans, missing images/finales and held line pages fail
explicitly. It honors each plan's imageKey rather than substituting a canonical
path. Front art and both back-cover images are required; a composed titled cover
is optional. Assembly never generates substitute artwork or skips missing input.

Each page has derived provenance fields:

- lineIdentity: SHA-256 of the actual accepted bytes and a source revision.
- colorIdentity: color byte hash, the exact line byte hash it colored, and the
  same source revision.

The source revision hashes the normalized existing bible, chapter title and
page's source fields. Artifact pointers, provenance itself and held-state fields
are excluded to avoid self-reference. The existing bible normalizer moved to
core unchanged, so generated and normalized bible shapes agree. This requires
no re-plan or new authored visual canon. Whole-book manifests still hash the
actual source bytes and every included artifact.

Successful generation/repair stamps these facts from the bytes it actually
accepted. Existing unprovenanced art is **unverifiable**, never automatically
adopted from upload time or from its location. No historical provenance was
backfilled. A pixel cleanup preserves a source binding only when its original
byte hash matches that binding. Standalone legacy HTTP edits without this
proof cannot pass assembly. Adoption of older art needs separately reviewed
evidence; this slice does not authorize regeneration or invent that evidence.

Color assembly requires complete, current twins, including finales. It has no
line-art fallback. Color-held pages, missing identities, altered bytes, changed
line hashes or changed source revisions block it. Color generation persists a
pending held state before attempting replacement; unavailable gateways,
exceptions, QC rejection and spend caps cannot leave a falsely successful
edition. Old bytes and identity evidence are retained when an attempt fails.
The budget coordinator and judge policy are unchanged.

The builder checks the supplied count and the actual interior pages it creates.
The assembly receipt records the inventory count, total PDF count (including
matter), exact input manifest and PDF hash. Each candidate PDF and receipt gets
a fresh UUID path under books/{slug}/assemblies/, including candidates whose
final revision check fails. No pruning or deduplication is introduced. The
mutable PDF also carries its input revision, receipt key and byte hash in R2
metadata. This is assembly provenance, not immutable release promotion.

Inputs are rehashed when loaded and the complete inventory/revision is checked
again before installation. Base PDF pairs carry the same expected revision
between calls/steps; no register/done path follows a failed call. Colorize
refreshes both base PDFs in separate steps after the color PDF, against the same
final input revision, because coloring updates plan provenance. Each PDF has
its own working set. Original art is never transcoded in storage.

## Approval contract

Migration 0002 creates artifact_approvals with append-only event rows, actor
when available, time, revision, per-target artifact hash and the entire derived
manifest. Database triggers forbid UPDATE/DELETE; revocation appends an event.
The coordinate-only page_approvals table is retained and is no longer authority.
There is no automatic approval or migration of historical approvals.

Single and bulk approvals require an explicit boolean and the revision supplied
by the review context. A stale tab is rejected. Approval counting matches the
exact expected chapter/page/hash set and the latest event for that revision;
duplicates cannot stand in for a finale. A single JSON binding keeps the publish
transaction below D1's parameter ceiling even for large inventories. Its
transactional fence rechecks these exact approvals, including concurrent
revocations. Inventory changes are recaptured before publication as well.

The approval revision includes actual registered PDFs, audio/EPUB when present,
line/color art, source plans, bible, raw/composed front art and back-cover art.
Changing any included bytes invalidates the old revision's approvals. This is
conservative: unrelated page approvals also need review again when that whole
revision changes. Cover/matter marks in the QC viewer share that same revision;
they cannot substitute for required story/finale approvals.

Registered PDFs must have matching assembly metadata and a valid receipt bound
to the current input manifest and PDF byte hash. New page approvals therefore
cannot legitimize an older assembled download. Stale/unverifiable PDFs block
approval and publication without an override. Rebuild and review are required.

The review API derives pages directly from those captured plans, including
finales, rather than stale editor_chapters.json. Image URLs include the reviewed
SHA-256; the authenticated media endpoint verifies that hash before serving
bytes, with no-store caching. Changed bytes return 409. The QC UI paints an
approval only after its request succeeds. It retains its viewed revision rather
than silently acquiring authority over a later revision.

## Rollout and deliberate limits

RGM must apply migration 0002 before rolling out the hub. Hub and factory need
the new contract before assembly/approval can succeed. Keep generation paused.
Existing coordinate-only approvals will not count; existing art/PDFs without
proof will park explicitly. Do not bulk backfill proof just to make the gate
pass. A stored PDF that was assembled before these receipts is unverifiable.

Install the new exact @noble/hashes 2.4.0 core dependency along with the declared
factory dependencies. Portable incremental SHA-256 avoids requiring a new Node
compatibility flag in the factory and preserves existing digest values.

Mutable PDF installation and the final check are not one cross-service atomic
transaction. An earlier PDF in a failed pair can already have been written;
the workflow fails and cannot register completion or gain approval for the
mixed set. Candidate receipts remain. Immutable release keys, atomic release
promotion and delivery from a pinned release remain Slice 3. No Slice 3 work
was started here. This does not claim that a hash proves the art deserves
approval; judge quality remains the later approved plan.

No paid calls, production R2/D1 writes, workflow runs, deployment or merge were
performed. Factory workflow fault tests invoke methods locally with in-memory
bindings and forbidden paid transports. Existing ledgers/attempts were not
modified. CG's budget scope, visual canon, labeling session/time, pilot spend,
promotion thresholds and durability-first acceptance decisions remain open.

## Offline verification

Fault tests preceded the implementation. They cover missing plans, images and
finales; held/color-held pages; absent, stale and unproven color twins; changed
inputs while building; source changes between base PDFs; artifact edits after
approval; stale browser requests; duplicate approvals; append-only revocations;
and approval of new art alongside an old PDF. Real pdf-lib outputs are parsed
in tests to verify final page counts. Gateway, exception and cap failures are
exercised through the actual ColorizeWorkflow with offline bindings.

Per-file baseline comparison uses pristine a0dcbc5 and the same installed
runtime/dependencies. External fetch is rejected; loopback test servers are
allowed. Tests run in separate Bun processes to avoid module mock collisions.
The known 41 FAIL lines and the releases/transmedia aborts remain unchanged.
An additional intermittent club-cycles assertion reproduced on pristine main:
in 12 targeted reruns, base failed once and candidate failed three times with
the same assertion. Both also pass in isolated reruns. Those small samples
establish an existing flake, not a measured change in its frequency. No club
code or test was changed, and this slice does not fix that flake.


Final checks on this branch:

| Check | Result |
| --- | --- |
| Existing tests, 76 files, per-file baseline comparison | Same outcomes/signatures in the handoff run; 65 pass, same 11 fail |
| Seven new test files | 44 tests pass |
| Existing publish-revision / reliability-followups | 20 / 5 pass with fixtures upgraded to the new contract |
| Additional club-cycles repeats | Existing intermittent assertion reproduced on base and candidate, as detailed above |
| Hub Astro compilation | Pass |
| Full factory browser-platform bundle, only cloudflare:workers external | Pass |
| Sealed factory build driver from committed source | Pass; original bytes and receipt retained locally |

The installed Bun 1.3.10 cannot parse the repository's existing v2 lockfile.
Core/factory dependencies for these checks were installed locally with npm,
without lifecycle scripts, audit calls or new lockfiles. The only lockfile
change is the new core workspace dependency on the already pinned noble package.
This does not fix the root toolchain baseline or claim a new root packaging
result. No generated bundle, dependency directory or local receipt is committed.
