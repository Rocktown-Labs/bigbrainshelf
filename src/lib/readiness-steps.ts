// Step-flow states for the admin Readiness page's "Finalize in
// order" list (CG, 2026-11-10): the steps must read in sync with
// the status of the project. A step is
//   done     the step's work has landed (its artifacts exist)
//   waiting  the work has landed and what remains is the owner's
//            review, approval, or sign-off
//   current  the next action: the work genuinely has not happened
//            yet, or is only partly on file
//   unknown  the state could not be checked; never presented as
//            done, the same conservative rule as the checklist
//
// This module is presentation derivation only. It consumes the
// delivery checklist's computed check states plus the raw R2 page
// counts the readiness page already reads, and decides how each
// step presents. It changes no gate: readiness verdicts, sign-offs,
// and publish gating live in delivery-readiness.ts /
// publish-readiness.ts / publish-gate.ts and are untouched.
//
// The colorize step is the case that forced this (Ruby, 2026-11-10):
// her color edition was complete on disk (25 of 25 color twins, the
// color storybook assembled) while the step still presented the
// Colorize run button, disabled "until QC is green". The factory
// colors from its own gates, so color routinely lands before hub
// page approvals exist; the step presented finished work as locked
// and not started. Color completeness here requires a color twin
// for every line page AND the color storybook on file, not just a
// color_book_key: Maisie's key is set and a color PDF exists with
// only 5 of 40 pages colored, which is a partial colorize, not a
// color edition.

export type ReadinessStepState = "done" | "waiting" | "current" | "unknown";
export type StepCheckState = "pass" | "fail" | "unknown";

export interface ReadinessStepFacts {
  /** QC step: every page approved on the current revision. */
  qcComplete: boolean;
  /** QC step: page inventory size; null = inventory could not be read. */
  qcTotalPages: number | null;
  /** The delivery checklist's color-edition check (color storybook on file). */
  colorCheck: StepCheckState | null;
  colorCheckDetail: string | null;
  /** R2 .jpg counts: line pages and their color twins; null = unread. */
  linePages: number | null;
  colorPages: number | null;
  /** The delivery checklist's full-color sign-off check. */
  colorSignoff: StepCheckState | null;
  /** The raw color sign-off state behind the check, when known:
   * a voided sign-off (the color edition changed after it was
   * recorded) and an out-of-date edition (twins older than their
   * line pages) present differently from a plain outstanding one. */
  colorSignoffState?: "done" | "outstanding" | "unavailable" | "voided" | "unknown" | null;
  /** The delivery checklist's casting and audiobook-production checks. */
  castState: StepCheckState | null;
  audioState: StepCheckState | null;
  /** Publish step: the audio gate (publish-readiness) verdict. */
  publishReady: boolean | null;
  deliveryVerdict: "ready" | "product-ready" | "not-ready" | "unverified" | null;
  /** The delivery checklist's marketing-assets check. */
  marketingState: StepCheckState | null;
}

export interface StepPresentation {
  state: ReadinessStepState;
  badge: string;
}

export interface ColorizeStepPresentation extends StepPresentation {
  detail: string;
  /** "run": colorize is the step's action. "rerun": the color
   *  edition has landed; the button stays available as a secondary
   *  re-run (the factory skips pages that are already current). */
  action: "run" | "rerun";
}

export interface ReadinessSteps {
  qc: StepPresentation;
  colorize: ColorizeStepPresentation;
  castingAudio: StepPresentation;
  publish: StepPresentation;
  marketing: StepPresentation;
}

const BADGE: Record<ReadinessStepState, string> = {
  done: "Done",
  waiting: "Waiting",
  current: "Next step",
  unknown: "Unverified",
};

function step(state: ReadinessStepState, badge?: string): StepPresentation {
  return { state, badge: badge ?? BADGE[state] };
}

function deriveColorize(f: ReadinessStepFacts): ColorizeStepPresentation {
  const countsKnown = f.linePages !== null && f.colorPages !== null && f.linePages > 0;
  const twinsComplete = countsKnown && (f.colorPages as number) >= (f.linePages as number);
  const countsText = countsKnown ? ` ${f.colorPages} of ${f.linePages} pages colored.` : "";
  const unlockNote = f.qcComplete ? "" : " Colorize unlocks when every page is green in QC.";

  // The color edition has landed: a twin for every line page and
  // the assembled color storybook on file. What remains is the
  // owner's color sign-off, never another colorize run.
  if (twinsComplete && f.colorCheck === "pass") {
    const landed = `Color edition complete: ${f.colorPages} of ${f.linePages} pages colored and the color storybook is on file.`;
    if (f.colorSignoff === "pass") {
      return {
        ...step("done"),
        detail: `${landed} Full color sign-off is recorded.`,
        action: "rerun",
      };
    }
    // Sign-off order (CG, 2026-11-11): a sign-off recorded before
    // the latest colorize is void, and an edition whose twins are
    // older than their line pages is out of date. Neither reads as
    // a plain "waiting on sign-off": the voided one needs a fresh
    // review of the current edition; the stale one needs colorize
    // to refresh the twins before any sign-off is even available.
    if (f.colorSignoffState === "voided") {
      return {
        ...step("waiting", "Waiting on color sign-off"),
        detail:
          landed +
          " The full color sign-off was voided when the color edition changed after it was recorded. Read the full color edition in the QC viewer and sign off again.",
        action: "rerun",
      };
    }
    if (f.colorSignoffState === "unavailable") {
      return {
        ...step("current"),
        detail:
          `Color edition out of date: ${f.colorPages} of ${f.linePages} pages colored, but the edition is not current (color pages older than their line pages), so the full color sign-off is not available yet. Run colorize to refresh it; the factory skips pages that are already current.` +
          unlockNote,
        action: "rerun",
      };
    }
    return {
      ...step("waiting", "Waiting on color sign-off"),
      detail:
        landed +
        (f.colorSignoff === "fail"
          ? " Waiting on the full color sign-off: read the full color edition in the QC viewer and sign off."
          : " The color sign-off state could not be checked."),
      action: "rerun",
    };
  }

  // The color storybook's presence could not be checked at all:
  // say so, and never claim the step either way.
  if (f.colorCheck === null || f.colorCheck === "unknown") {
    return {
      ...step("unknown"),
      detail:
        (twinsComplete
          ? `${f.colorPages} of ${f.linePages} pages colored, but the color storybook's state could not be checked.`
          : `Color edition state could not be checked.${countsText}`) + unlockNote,
      action: "run",
    };
  }

  // Color genuinely missing or partial: colorize is the action.
  let detail: string;
  if (twinsComplete) {
    // Every page has a twin but the assembled storybook is not on
    // file (check failed): running colorize assembles it, and the
    // factory skips the pages that are already colored.
    detail = `${f.colorPages} of ${f.linePages} pages colored, but the color storybook is not on file. Run colorize to assemble the color edition.`;
  } else if (countsKnown) {
    detail = `${f.colorPages} of ${f.linePages} pages colored. The color edition is complete only when every line page has a color twin and the color storybook is on file.`;
  } else {
    detail = f.colorCheckDetail ?? "Color edition state unknown.";
  }
  return { ...step("current"), detail: detail + unlockNote, action: "run" };
}

export function deriveReadinessSteps(f: ReadinessStepFacts): ReadinessSteps {
  const qc: StepPresentation = f.qcComplete
    ? step("done")
    : f.qcTotalPages === null
      ? step("unknown")
      : step("waiting", "Waiting on your review");

  const castingAudio: StepPresentation =
    f.castState === null || f.audioState === null
      ? step("unknown")
      : f.castState === "pass" && f.audioState === "pass"
        ? step("done")
        : f.castState === "unknown" || f.audioState === "unknown"
          ? step("unknown")
          : step("current");

  const publish: StepPresentation =
    f.publishReady === null || f.deliveryVerdict === null
      ? step("unknown")
      : f.publishReady && (f.deliveryVerdict === "ready" || f.deliveryVerdict === "product-ready")
        ? step("current")
        : step("waiting");

  const marketing: StepPresentation =
    f.marketingState === null
      ? step("unknown")
      : f.marketingState === "pass"
        ? step("done")
        : f.marketingState === "unknown"
          ? step("unknown")
          : f.deliveryVerdict === "product-ready"
            ? step("current")
            : step("waiting");

  return { qc, colorize: deriveColorize(f), castingAudio, publish, marketing };
}
