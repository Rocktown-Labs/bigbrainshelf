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
//   unknown     the state could not be checked (callers produce this
//               when the read itself fails)

export type SignoffKind = "story" | "color";
export type SignoffStateName = "done" | "outstanding" | "unavailable" | "unknown";

export interface SignoffState {
  state: SignoffStateName;
  actor: string | null;
  at: string | null;
}

export interface SignoffStates {
  story: SignoffState;
  color: SignoffState;
}

/** The full color edition exists to be read only when every page in
 * the revision carries a color twin. A partial colorization (Penny's
 * 21 of 40 twins) is not a color edition anyone can sign off. */
export function colorEditionComplete(manifest: BookRevision): boolean {
  return manifest.pages.length > 0 && manifest.pages.every((p) => !!p.colorKey);
}

export async function getSignoffStates(
  db: any,
  slug: string,
  revision: string,
  colorComplete: boolean
): Promise<SignoffStates> {
  const { results } = await db
    .prepare(
      "SELECT kind, actor, created_at FROM book_qc_signoffs WHERE book_slug = ? AND revision = ? ORDER BY id DESC"
    )
    .bind(slug, revision)
    .all();
  const latest = new Map<string, any>();
  for (const row of results ?? []) {
    if (!latest.has(row.kind)) latest.set(row.kind, row);
  }
  const one = (kind: SignoffKind, available: boolean): SignoffState => {
    const row = latest.get(kind);
    if (row) return { state: "done", actor: row.actor ?? null, at: row.created_at ?? null };
    return { state: available ? "outstanding" : "unavailable", actor: null, at: null };
  };
  return { story: one("story", true), color: one("color", colorComplete) };
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
    blockers.push({
      id: "signoff:color",
      detail:
        states.color.state === "unavailable"
          ? "Full color QC sign-off is not yet available: the color edition is incomplete, so there is no full color edition to sign off. Colorize the book first."
          : states.color.state === "unknown"
            ? "Full color QC sign-off could not be verified."
            : "Full color QC sign-off is outstanding for the current revision. Read the full color edition in the QC viewer and sign off.",
    });
  }
  return blockers;
}
