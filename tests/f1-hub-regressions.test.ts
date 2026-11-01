// SECURITY F1 follow-up (2026-11-01): the rebuilt account hub added
// new surfaces after the original fix pass. This suite pins that none
// of them email-match without the verified-session gate.
// Run with: bun tests/f1-hub-regressions.test.ts
let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const read = async (rel: string) =>
  Bun.file(new URL(rel, import.meta.url)).text();

// The dashboard's club panel resolves through getClubSignupForUser
// (user_id first; the email term only for a verified session), never
// a raw email-keyed query.
const dashSrc = await read("../src/pages/account/index.astro");
assert(
  dashSrc.includes("getClubSignupForUser"),
  "F1: the dashboard club panel uses the user-first member lookup"
);
assert(
  !dashSrc.includes("OR LOWER(email)"),
  "F1: no raw email-OR lookup remains on the dashboard"
);
assert(
  dashSrc.includes("session.user.emailVerified === true"),
  "F1: the dashboard lookup threads the session verification flag"
);

// The 80% completion upsell (revops) reads reviews by user email and
// sends to it: it now requires a verified session.
const progressSrc = await read("../src/pages/api/account/progress.ts");
assert(
  progressSrc.includes("session.user.emailVerified === true"),
  "F1: the completion upsell waits for a verified email"
);

// The rebuilt reader threads the flag into entitlements too.
const readerSrc = await read("../src/pages/read/[slug].astro");
assert(
  readerSrc.includes("emailVerified: (session.user as any).emailVerified === true"),
  "F1: the rebuilt reader threads the verification flag into entitlements"
);

// The library and book overview pages go through the shared hub loader,
// which is already gated (pinned in the library suite); a direct pin
// that the loader call is unchanged:
assert(
  dashSrc.includes("loadCustomerHubContext"),
  "F1: the dashboard loads through the shared (gated) hub context"
);
const libSrc = await read("../src/pages/account/library.astro");
assert(
  libSrc.includes("loadCustomerHubContext"),
  "F1: the library page loads through the shared (gated) hub context"
);
const bookSrc = await read("../src/pages/account/book/[slug].astro");
assert(
  bookSrc.includes("loadCustomerHubContext"),
  "F1: the book overview loads through the shared (gated) hub context"
);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll F1 hub regression pins passed.");
