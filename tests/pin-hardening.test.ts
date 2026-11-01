// SECURITY F9 + N2 (2026-10-31): the parental PIN was stored and
// compared in plaintext, a client flag decided whether to check it,
// and the family-room sync route let the client widen its own daily
// limit. Now: PINs hash at rest (legacy rows upgrade on first
// verify), verification is rate-limited, protected-field edits and
// profile deletes require the PIN server-side, and the room limit is
// capped at the kid profile's saved limit.
// Run with: bun tests/pin-hardening.test.ts
import { Database } from "bun:sqlite";
import {
  ensureFamilyTables,
  getParentOnboarding,
  saveParentOnboarding,
  verifyParentPin,
  upsertKidProfile,
  deleteKidProfile,
} from "../src/lib/family";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const read = async (rel: string) =>
  Bun.file(new URL(rel, import.meta.url)).text();

const raw = new Database(":memory:");
const db = {
  prepare(sql: string) {
    return {
      bind(...args: any[]) {
        const stmt = raw.query(sql);
        return {
          async run() { const r = stmt.run(...args) as any; return { meta: { changes: r?.changes ?? 0 } }; },
          async first() { return stmt.get(...args) ?? null; },
          async all() { return { results: stmt.all(...args) }; },
        };
      },
    };
  },
} as any;

await ensureFamilyTables(db);

// ---- Hashing at rest -------------------------------------------------------
const ob = await saveParentOnboarding(db, "u-pin", "p@example.com", {
  parent_name: "Pat",
  parent_pin: "4321",
  mark_complete: true,
}, "https://bigbrainshelf.com");
assert(ob.parent_pin?.startsWith("pbkdf2$"), "F9: the stored PIN is a PBKDF2 hash");
assert(ob.parent_pin !== "4321", "F9: the plaintext never lands in the row");
assert(await verifyParentPin(db, "u-pin", "4321"), "F9: the real PIN verifies against the hash");
assert(!(await verifyParentPin(db, "u-pin", "0000")), "F9: a wrong PIN fails");
const after = await getParentOnboarding(db, "u-pin");
assert(after?.parent_pin?.startsWith("pbkdf2$"), "F9: a failed verify does not downgrade the hash");

// ---- Legacy plaintext upgrades on first successful verify -------------------
// A pre-hashing row: created normally, then backdated to plaintext
// exactly like the rows already in D1.
await saveParentOnboarding(db, "u-legacy", "l@example.com", {
  parent_pin: "9999",
  mark_complete: true,
}, "https://bigbrainshelf.com");
raw.query(
  "UPDATE parent_onboarding SET parent_pin = '9999' WHERE user_id = ?"
).run("u-legacy");
const legOb = await getParentOnboarding(db, "u-legacy");
assert(legOb?.parent_pin === "9999", "legacy row starts as plaintext");
assert(await verifyParentPin(db, "u-legacy", "9999"), "F9: legacy plaintext PIN verifies");
const upgraded = await getParentOnboarding(db, "u-legacy");
assert(upgraded?.parent_pin?.startsWith("pbkdf2$"), "F9: the legacy row upgraded to a hash on success");
assert(await verifyParentPin(db, "u-legacy", "9999"), "F9: the upgraded hash still verifies");

// ---- No PIN configured: still open (parent not locked out) ------------------
assert(await verifyParentPin(db, "u-nopin", "1111"), "F9: no PIN configured keeps allowing access");

// ---- Guess throttling --------------------------------------------------------
// 10 attempts per 5 minutes per account. Burn the budget with wrong PINs.
for (let i = 0; i < 10; i++) {
  await verifyParentPin(db, "u-throttle", "0000"); // no PIN configured: consumes nothing meaningful
}
// Configure a PIN, then hammer it past the cap.
await saveParentOnboarding(db, "u-throttle2", "t@example.com", { parent_pin: "2468" }, "https://bigbrainshelf.com");
for (let i = 0; i < 10; i++) await verifyParentPin(db, "u-throttle2", "0000");
assert(!(await verifyParentPin(db, "u-throttle2", "2468")), "F9: the 11th attempt is refused even with the right PIN");
const src = await read("../src/lib/family.ts");
assert(src.includes("checkRateLimit(db, `family_pin:${userId}`, 10, 5 * 60)"), "F9: the verifier rate-limits guesses");

// ---- Server-side enforcement pins ------------------------------------------
const familyApiSrc = await read("../src/pages/api/account/family.ts");
assert(
  familyApiSrc.includes('"daily_limit_minutes",') &&
    familyApiSrc.includes('"bedtime_cutoff",') &&
    familyApiSrc.includes("touchesProtected"),
  "F9: protected-field edits derive the PIN requirement server-side"
);
assert(
  familyApiSrc.includes('if (!pin) {\n      return json({ error: "Parent PIN required" }, 403);'),
  "F9: deleting a profile demands the PIN when one is set (no more omit-the-param bypass)"
);
assert(
  !(await Bun.file(new URL("../src/pages/onboarding.astro", import.meta.url)).text()).includes(
    'value={parentOnboarding?.parent_pin || ""}'
  ) &&
    !(await Bun.file(new URL("../src/pages/account/onboarding.astro", import.meta.url)).text()).includes(
      'value={parentOnboarding?.parent_pin || ""}'
    ),
  "F9: no page echoes the stored PIN into markup"
);

// deleteKidProfile itself stays user-scoped (the route owns the PIN gate).
const kid = await upsertKidProfile(db, "u-pin", { name: "A" });
await deleteKidProfile(db, "u-pin", String(kid.id));
assert((await getParentOnboarding(db, "u-pin"))?.parent_pin?.startsWith("pbkdf2$"), "suite state intact");

// ---- N2: family-room limit capped at the kid profile's setting -------------
const syncSrc = await read("../src/lib/family-sync.ts");
assert(
  syncSrc.includes("SELECT daily_limit_minutes FROM kid_profiles WHERE id = ? AND user_id = ?"),
  "N2: the room limit is validated against the caller's own kid profile"
);
assert(
  syncSrc.includes("nextLimit = Math.min(nextLimit,"),
  "N2: the client value is capped, never adopted unchecked"
);
const syncRouteSrc = await read("../src/pages/api/account/sync.ts");
assert(
  !syncRouteSrc.includes("Number(body.activeKidId)"),
  "N2/latent: kid ids are strings (UUIDs), not Number()-coerced"
);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll PIN hardening tests passed.");
