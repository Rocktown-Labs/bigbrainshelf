import type { BookRevision } from "../../packages/core/src/book-revision";

// QC sign-offs (CG, 2026-11-03): "QC the full story, then the full
// color." Two per-book human attestations sit on top of the per-page
// hash-bound approvals. Each sign-off binds to the exact book
// revision the reviewer loaded; a revision change orphans it, the
// same rule as artifact_approvals. States are explicit, never a
// silent pass:
//   done        a sign-off row exists for this revision
//   outstanding the surface exists but nobody has signed this revision
//   unavailable the surface does not exist yet (no complete color
//               edition), so there is nothing to sign off
//   voided      (color only) a sign-off exists, but on an older
//               revision: the book changed after it was recorded
//               (the usual cause is a later colorize), so it no
//               longer counts and must be recorded again
//   unknown     the state could not be checked (callers produce this
//               when the read itself fails)
//
// Sign-off ORDER (CG, 2026-11-11): review the lines, then colorize
// runs, then review the color. The color sign-off is available only
// for a color edition that is complete AND current: every page
// carries a color twin, and each twin was uploaded at or after its
// line page (the factory's colorIsCurrent rule). A twin older than
// its line page is a stale coloring of a redrawn page: the edition
// reads out of date, not signed-off-able, until colorize refreshes
// it.

export type SignoffKind = "story" | "color";
export type SignoffStateName = "done" | "outstanding" | "unavailable" | "voided" | "unknown";

export interface SignoffState {
  state: SignoffStateName;
  actor: string | null;
  at: string | null;
  /** Color only, when state is "unavailable": the edition is
   * "incomplete" (twins missing) or "stale" (twins older than
   * their line pages). */
  unavailableReason?: "incomplete" | "stale" | null;
}

export interface SignoffStates {
  story: SignoffState;
  color: SignoffState;
}

/** The color edition, judged for sign-off availability:
 *   complete   every page has a color twin and every twin is
 *              current against its line page
 *   incomplete at least one page has no color twin
 *   stale      every page has a twin, but at least one twin was
 *              uploaded before its line page (a redrawn page whose
 *              coloring was never refreshed)
 *   unknown    currency could not be checked (uploaded timestamps
 *              missing from the revision manifest) */
export type ColorEditionAssessment =
  | { state: "complete" }
  | { state: "incomplete"; missingTwins: number }
  | { state: "stale"; stalePages: string[] }
  | { state: "unknown" };

export function assessColorEdition(manifest: BookRevision): ColorEditionAssessment {
  if (!manifest.pages.length) return { state: "incomplete", missingTwins: 0 };
  const missing = manifest.pages.filter((p) => !p.colorKey).length;
  if (missing) return { state: "incomplete", missingTwins: missing };
  const uploaded = manifest.uploaded;
  if (!uploaded) return { state: "unknown" };
  const stalePages: string[] = [];
  for (const p of manifest.pages) {
    const lineAt = uploaded[p.lineKey];
    const colorAt = p.colorKey ? uploaded[p.colorKey] : undefined;
    if (!lineAt || !colorAt) return { state: "unknown" };
    if (Date.parse(colorAt) < Date.parse(lineAt)) stalePages.push(p.id);
  }
  return stalePages.length ? { state: "stale", stalePages } : { state: "complete" };
}

/** The full color edition exists to be read only when every page in
 * the revision carries a color twin that is current against its
 * line page. A partial colorization (Penny's 21 of 40 twins) is not
 * a color edition anyone can sign off, and neither is a complete
 * set of twins left stale by a line redraw. */
export function colorEditionComplete(manifest: BookRevision): boolean {
  return assessColorEdition(manifest).state === "complete";
}

export async function getSignoffStates(
  db: any,
  slug: string,
  revision: string,
  colorEdition: ColorEditionAssessment
): Promise<SignoffStates> {
  const { results } = await db
    .prepare(
      "SELECT kind, actor, created_at, revision FROM book_qc_signoffs WHERE book_slug = ? ORDER BY id DESC"
    )
    .bind(slug)
    .all();
  const rows: any[] = results ?? [];
  const current = new Map<string, any>();
  for (const row of rows) {
    if (row.revision === revision && !current.has(row.kind)) current.set(row.kind, row);
  }
  const storyRow = current.get("story");
  const story: SignoffState = storyRow
    ? { state: "done", actor: storyRow.actor ?? null, at: storyRow.created_at ?? null }
    : { state: "outstanding", actor: null, at: null };

  const colorRow = current.get("color");
  let color: SignoffState;
  if (colorRow) {
    color = { state: "done", actor: colorRow.actor ?? null, at: colorRow.created_at ?? null };
  } else {
    // A color sign-off on any older revision was voided when the
    // book changed after it was recorded. Surface that loudly,
    // with the original attestation, instead of a bare outstanding.
    const voidedRow = rows.find((r) => r.kind === "color");
    if (voidedRow) {
      color = { state: "voided", actor: voidedRow.actor ?? null, at: voidedRow.created_at ?? null };
    } else if (colorEdition.state === "complete") {
      color = { state: "outstanding", actor: null, at: null };
    } else if (colorEdition.state === "unknown") {
      color = { state: "unknown", actor: null, at: null };
    } else {
      color = {
        state: "unavailable",
        actor: null,
        at: null,
        unavailableReason: colorEdition.state === "stale" ? "stale" : "incomplete",
      };
    }
  }
  return { story, color };
}

export async function recordSignoff(
  db: any,
  slug: string,
  kind: SignoffKind,
  revision: string,
  actor: string | null
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO book_qc_signoffs (book_slug, kind, revision, actor, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(slug, kind, revision, actor, new Date().toISOString())
    .run();
}

/** Publish-gate blockers for any sign-off that is not done. The ids
 * carry the signoff: prefix so the gate can refuse to let an override
 * waive them: an attestation is recorded, never waived. */
export function signoffBlockers(states: SignoffStates): { id: string; detail: string }[] {
  const blockers: { id: string; detail: string }[] = [];
  if (states.story.state !== "done") {
    blockers.push({
      id: "signoff:story",
      detail:
        states.story.state === "unknown"
          ? "Full story QC sign-off could not be verified."
          : "Full story QC sign-off is outstanding for the current revision. Read the full story in the QC viewer and sign off.",
    });
  }
  if (states.color.state !== "done") {
    const signedWhen = states.color.at ? ` (signed off ${String(states.color.at).slice(0, 10)})` : "";
    blockers.push({
      id: "signoff:color",
      detail:
        states.color.state === "voided"
          ? `Full color QC sign-off was voided: the color edition changed after the sign-off was recorded${signedWhen}, so it no longer counts. Read the full color edition in the QC viewer and sign off again.`
          : states.color.state === "unavailable" && states.color.unavailableReason === "stale"
            ? "Full color QC sign-off is not yet available: the color edition is out of date. Some color pages are older than the line pages they were colored from. Re-run colorize so every color page is current, then sign off."
            : states.color.state === "unavailable"
              ? "Full color QC sign-off is not yet available: the color edition is incomplete, so there is no full color edition to sign off. Colorize the book first."
              : states.color.state === "unknown"
                ? "Full color QC sign-off could not be verified."
                : "Full color QC sign-off is outstanding for the current revision. Read the full color edition in the QC viewer and sign off.",
    });
  }
  return blockers;
}
