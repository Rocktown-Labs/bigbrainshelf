// Readiness step-flow states (CG, 2026-11-10): the admin Readiness
// page's "Finalize in order" steps must read in sync with the
// project. A step whose work has landed says so; a step waiting on
// the owner's review or sign-off says that; a run button presents
// as the current step only when the work has not happened.
//
// The book cases below carry the facts measured live on 2026-11-10
// (D1 books rows, R2 page counts, book_qc_signoffs) for the books
// CG checked. Run with: bun tests/readiness-steps.test.ts
import { deriveReadinessSteps, type ReadinessStepFacts } from "../src/lib/readiness-steps";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const base: ReadinessStepFacts = {
  qcComplete: false,
  qcTotalPages: null,
  colorCheck: null,
  colorCheckDetail: null,
  linePages: null,
  colorPages: null,
  colorSignoff: null,
  castState: null,
  audioState: null,
  publishReady: null,
  deliveryVerdict: null,
  marketingState: null,
};

// ---- Ruby (2026-11-10): colorize COMPLETE on disk (25 of 25 twins,
// color storybook assembled and on file), cast to Zephyr with the
// final audiobook live the same day. No hub page approvals and no
// sign-offs recorded yet (CG's passes were verbal). Before this
// derivation the step presented the Colorize run button, disabled
// "until QC is green", for a book whose color had already landed.
const ruby = deriveReadinessSteps({
  ...base,
  qcComplete: false,
  qcTotalPages: 25,
  colorCheck: "pass",
  colorCheckDetail: "Color edition: on file.",
  linePages: 25,
  colorPages: 25,
  colorSignoff: "fail",
  castState: "pass",
  audioState: "pass",
  publishReady: true,
  deliveryVerdict: "not-ready",
  marketingState: "fail",
});
assert(ruby.colorize.state === "waiting", "ruby: colorize step is waiting, not an action");
assert(ruby.colorize.badge === "Waiting on color sign-off", "ruby: colorize badge names the color sign-off");
assert(ruby.colorize.action === "rerun", "ruby: colorize button demoted to a re-run");
assert(ruby.colorize.detail.startsWith("Color edition complete: 25 of 25 pages colored"), "ruby: colorize detail says the edition landed");
assert(!ruby.colorize.detail.includes("unlocks"), "ruby: no 'unlocks when QC is green' text over finished color");
assert(ruby.qc.state === "waiting" && ruby.qc.badge === "Waiting on your review", "ruby: QC step waits on the owner's review");
assert(ruby.castingAudio.state === "done", "ruby: casting and audio step is done (Zephyr cast, final audiobook)");
assert(ruby.publish.state === "waiting", "ruby: publish waits behind the outstanding sign-offs");
assert(ruby.marketing.state === "waiting", "ruby: marketing waits");

// ---- Mira (2026-11-10): everything landed and signed; the book
// sits at the Publish step. Colorize must read Done, and Publish
// must remain the current step.
const mira = deriveReadinessSteps({
  ...base,
  qcComplete: true,
  qcTotalPages: 45,
  colorCheck: "pass",
  colorCheckDetail: "Color edition: on file.",
  linePages: 40,
  colorPages: 40,
  colorSignoff: "pass",
  castState: "pass",
  audioState: "pass",
  publishReady: true,
  deliveryVerdict: "ready",
  marketingState: "pass",
});
assert(mira.qc.state === "done", "mira: QC step done");
assert(mira.colorize.state === "done" && mira.colorize.action === "rerun", "mira: colorize done, re-run only");
assert(mira.colorize.detail.includes("Full color sign-off is recorded"), "mira: colorize detail records the sign-off");
assert(mira.castingAudio.state === "done", "mira: casting and audio done");
assert(mira.publish.state === "current" && mira.publish.badge === "Next step", "mira: publish is the current step");
assert(mira.marketing.state === "done", "mira: marketing done");

// ---- Tilda (2026-11-10): color complete and current (40 of 40
// twins), story signed off, color sign-off outstanding.
const tilda = deriveReadinessSteps({
  ...base,
  qcComplete: true,
  qcTotalPages: 45,
  colorCheck: "pass",
  colorCheckDetail: "Color edition: on file.",
  linePages: 40,
  colorPages: 40,
  colorSignoff: "fail",
  castState: "pass",
  audioState: "pass",
  publishReady: true,
  deliveryVerdict: "not-ready",
  marketingState: "fail",
});
assert(tilda.colorize.state === "waiting" && tilda.colorize.badge === "Waiting on color sign-off", "tilda: colorize waits on the color sign-off");
assert(tilda.colorize.action === "rerun", "tilda: colorize button is a re-run");
assert(tilda.castingAudio.state === "done", "tilda: casting and audio done (Leda final)");

// ---- Blaze (designpatterns): no color at all (0 of 40 twins, no
// color book key). Colorize must remain the step's action.
const blaze = deriveReadinessSteps({
  ...base,
  qcComplete: false,
  qcTotalPages: 40,
  colorCheck: "fail",
  colorCheckDetail: "Color edition: no colorized story book exists, but the bundle advertises the full color story book.",
  linePages: 40,
  colorPages: 0,
  colorSignoff: "fail",
  castState: "pass",
  audioState: "pass",
  publishReady: true,
  deliveryVerdict: "not-ready",
  marketingState: "fail",
});
assert(blaze.colorize.state === "current" && blaze.colorize.badge === "Next step", "blaze: colorize is the next step");
assert(blaze.colorize.action === "run", "blaze: colorize button is the run action");
assert(blaze.colorize.detail.startsWith("0 of 40 pages colored"), "blaze: detail leads with the real count");
assert(blaze.colorize.detail.includes("unlocks when every page is green in QC"), "blaze: QC unlock note still guards the run");

// ---- Maisie (compoundeffect): the trap case. color_book_key is
// set and a color PDF is on file, so the checklist's color-edition
// row passes, but only 5 of 40 pages have color twins. A key alone
// is not a color edition: the step must read partial/action.
const maisie = deriveReadinessSteps({
  ...base,
  qcComplete: true,
  qcTotalPages: 40,
  colorCheck: "pass",
  colorCheckDetail: "Color edition: on file.",
  linePages: 40,
  colorPages: 5,
  colorSignoff: "fail",
  castState: "pass",
  audioState: "pass",
  publishReady: true,
  deliveryVerdict: "not-ready",
  marketingState: "fail",
});
assert(maisie.colorize.state === "current" && maisie.colorize.action === "run", "maisie: partial colorize is still the action despite the key");
assert(maisie.colorize.detail.startsWith("5 of 40 pages colored"), "maisie: detail leads with the partial count");

// ---- Twins all colored but the assembled storybook missing:
// running colorize is the fix (the factory skips current pages).
const unassembled = deriveReadinessSteps({
  ...base,
  qcComplete: true,
  qcTotalPages: 40,
  colorCheck: "fail",
  colorCheckDetail: "Color edition: no colorized story book exists, but the bundle advertises the full color story book.",
  linePages: 40,
  colorPages: 40,
  colorSignoff: "fail",
});
assert(unassembled.colorize.state === "current" && unassembled.colorize.action === "run", "unassembled: colorize run assembles the edition");
assert(unassembled.colorize.detail.includes("not on file"), "unassembled: detail names the missing storybook");

// ---- Unverifiable states stay unverified, never done: no delivery
// computed at all, and a color check that could not be read.
const blind = deriveReadinessSteps({ ...base });
assert(blind.colorize.state === "unknown" && blind.colorize.badge === "Unverified", "blind: colorize unverified");
assert(blind.castingAudio.state === "unknown", "blind: casting and audio unverified");
assert(blind.publish.state === "unknown", "blind: publish unverified");
assert(blind.marketing.state === "unknown", "blind: marketing unverified");
const headError = deriveReadinessSteps({
  ...base,
  qcComplete: true,
  qcTotalPages: 25,
  colorCheck: "unknown",
  colorCheckDetail: "Color edition: presence could not be checked.",
  linePages: 25,
  colorPages: 25,
  colorSignoff: "unknown",
});
assert(headError.colorize.state === "unknown", "head error: complete twins still unverified without the storybook check");
assert(headError.colorize.detail.includes("could not be checked"), "head error: detail says the check failed");

// ---- Marketing as the only outstanding check is the current step
// (the delivery verdict's product-ready case).
const productReady = deriveReadinessSteps({
  ...miraFacts(),
  deliveryVerdict: "product-ready",
  marketingState: "fail",
});
function miraFacts(): ReadinessStepFacts {
  return {
    ...base,
    qcComplete: true,
    qcTotalPages: 45,
    colorCheck: "pass",
    colorCheckDetail: "Color edition: on file.",
    linePages: 40,
    colorPages: 40,
    colorSignoff: "pass",
    castState: "pass",
    audioState: "pass",
    publishReady: true,
    deliveryVerdict: "ready",
    marketingState: "pass",
  };
}
assert(productReady.marketing.state === "current", "product-ready: marketing is the current step");
assert(productReady.publish.state === "current", "product-ready: publish stays current");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
