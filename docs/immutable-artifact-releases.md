# Immutable artifact releases (Slice 3)

A successful publish freezes the exact current approval revision. It does not regenerate, repair, restamp plan identities, or change authoring keys. Accepted appeals and approved page fixes use the same current identity stamps as every other page. A new byte hash requires a new approved revision and release; existing releases remain retained.

`src/lib/artifact-releases.ts` owns artifact releases. `src/lib/releases.ts` continues to own announcement emails.

## Promotion and evidence

1. Capture the approval revision, verify assembly receipts and current stamps, require the existing page approvals and both full-book QC sign-offs, and evaluate the existing readiness/explicit override rules.
2. Read the previous release head. Create a unique `books/{slug}/releases/{id}/intent.json` with the complete source manifest, actor and timestamp before copying anything.
3. Stream **every** manifest artifact into a new create-only release key. This includes bible/plans, line/color images, covers, digital masters and registered POD masters. R2 checks the expected SHA-256 during ingestion. Independently read/hash the copied bytes and reconcile size and hash. Preserve filename extensions for downstream PDF/audio code.
4. Persist and verify a create-only manifest mapping original keys to frozen keys, SHA-256, byte length and exact object etag. D1 pins the manifest's SHA-256 and etag. The source manifest is preserved exactly, with its canonical revision hash.
5. Recheck the live source revision. In one D1 batch, fence the observed book fields, page approvals, sign-offs and previous release head; append the publish journal and artifact release record, move the head, and update publication status/prices. A failed fence rolls back the whole batch.

There is no cross-service R2/D1 transaction. Staged objects are safe to orphan: no delivery path uses them until D1 promotion succeeds. A failed attempt retains its intent, all objects successfully written and any manifest. Freeze/promotion failures append their phase/error record when R2 is available; failure to record that error is logged. Nothing is deleted, deduplicated away or overwritten to tidy a retry. Each retry uses a new release ID. Existing deployment/run provenance recording remains in place.

D1 release records and print-item lineage have update/delete rejection triggers. The release head is the deliberate mutable pointer. R2 release objects are application-level create-only, not a claim of account-level WORM storage: out-of-band mutations are detected and delivery fails closed. Serving verifies the manifest hash and validates the selected artifact's conditional etag and size, rather than rehashing a large audiobook on every request.

## Delivery paths

| Surface | Contract |
| --- | --- |
| Buyer download streaming, `/api/download` | Entitlement first, then the promoted release and exact frozen object. Missing/unverified releases or changed objects return an unavailable response before consuming download allowance. Live books-row file keys no longer select the delivered bytes. |
| Order downloads, `/api/order-download` | Existing order-rights check and redirect into the authenticated account remain. It serves no bytes. Eventual file downloads use `/api/download`. |
| Lulu printables registry | Remains the authoring/quote registry. Its interior/cover bytes **and** kind, package, page count, keys and validation status enter the approval revision. Adding/changing a registry master or recipe invalidates that revision's approvals/sign-offs. Capture reads without seeding or creating tables. |
| Lulu print placement | Job creation resolves frozen printables from a promoted release. Each item records append-only release/master lineage. Placement and print-file tokens verify that historical release, its recipe and pinned masters. Registry edits and later head promotions cannot change an existing job. Legacy/unbound jobs cannot be placed by inferring lineage from mutable keys. |
| Personalized print stamping | Intentional mutable derivative at `books/{slug}/print/personalized/{itemId}.pdf`. It is bound to that exact item's frozen stock master, cover, recipe and release. Dedication/serial behavior remains; stamping failure may use only the frozen stock interior. Derivative bytes are deliberately not frozen. |
| Audiobook stamping | The unstamped M4B master is frozen. Per-buyer cached copies live outside the immutable tree at `books/{slug}/derivatives/audio/{releaseId}/{artifact}/{grant}/{sourceVersion}.m4b`. Existing buyer stamping and fallback behavior remains, with fallback restricted to the frozen master. |
| PDF buyer stamping | Same dedication, licensing and serial behavior, operating on the frozen master. A stamp failure serves only those verified master bytes. |
| Admin/QC/editor/reassemble | Remain live authoring surfaces. Reassembly changes the live revision and requires review before the next promotion. It cannot overwrite a prior release. |

**Boundary for RGM review:** customer in-app reader/page routes and MP3 playback currently remain live (`/read/[slug]`, `/api/library/page/[slug]`, `/api/library/audio/[slug]/[track]`). This PR does not claim those playback surfaces are immutable or freeze unlisted MP3 tracks. They need a separately scoped release-aware reader/audio contract; no fallback from a failed immutable download goes through them. Public preview/media surfaces also remain unchanged. POD registration still does not establish visual equivalence between a print master and its source pages; normalization/print proof review remains an operator responsibility. This slice pins those registered bytes, not a new print-art judge.

## RGM rollout

- Apply migration `0005_immutable_artifact_releases.sql` before deploying merged code. No runtime table creation, backfill, deployment or production promotion is performed by this PR.
- Existing `publish_releases` rows are historical evidence, not frozen releases. There is deliberately no live-key compatibility fallback. Until explicitly republished through the reviewed gate, a book has no downloadable release and no newly placeable frozen print master.
- Books with registered printables will have a different approval revision because the POD bytes/recipe are newly covered. Review and sign off the current revision before promotion. Missing registered master bytes block capture rather than disappear from the contract.
- Keep the Lulu lane off during cutover. Inspect any already queued, unbound print jobs before enabling placement; do not manufacture lineage for them. Quotes continue to use the live registry; publish any recipe change before taking orders against it.
- For one reviewed book, promote through the existing publish API/UI, inspect the pinned release manifest, then verify buyer files and applicable print masters. A subsequent authorized authoring edit must leave the delivered release unchanged until a fresh reviewed promotion. RGM owns production execution and checks.
- Interrupted or failed attempts remain evidence. Inspect the journal and delivery head before retrying an ambiguous publish response; an announcement email failure after promotion is not a reason to delete its release.

Budget fail-open, generation pause, judge thresholds, canaries and Slice 4 remain untouched. No new automatic approval or judge gate is introduced.
