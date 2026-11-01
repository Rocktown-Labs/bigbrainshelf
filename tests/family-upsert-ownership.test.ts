// SECURITY F4 (2026-10-31): kid-profile upsert ownership. The upsert
// conflicted on the profile's primary key with no user_id guard, so a
// client-supplied id for ANOTHER family's profile rewrote that
// family's child row. Now a foreign id is rejected before any write,
// and the DO UPDATE clause carries a user_id guard as defense in
// depth. Run with: bun tests/family-upsert-ownership.test.ts
import { Database } from "bun:sqlite";
import {
  ensureFamilyTables,
  listKidProfiles,
  upsertKidProfile,
} from "../src/lib/family";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

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

// The victim family's profile.
const victim = await upsertKidProfile(db, "user-victim", {
  name: "Victim Kid",
  birth_date: "2018-04-02",
  age: 8,
  daily_limit_minutes: 30,
  bedtime_cutoff: "20:00",
  allowed_book_slugs: ["alpha"],
});
const victimId = String(victim.id);
const victimBefore = (await listKidProfiles(db, "user-victim")).find((p) => p.id === victimId)!;

// The attacker, a different account, upserts with the victim's id.
let threw = false;
try {
  await upsertKidProfile(db, "user-attacker", {
    id: victimId,
    name: "Hacked Kid",
    birth_date: "2020-01-01",
    daily_limit_minutes: 480,
    bedtime_cutoff: null,
    allowed_book_slugs: ["beta"],
  });
} catch (err: any) {
  threw = String(err?.message || "").startsWith("not_found:");
}
assert(threw, "upsert with another family's profile id is rejected");

// Nothing changed for the victim...
const victimAfter = (await listKidProfiles(db, "user-victim")).find((p) => p.id === victimId)!;
assert(victimAfter.name === victimBefore.name, "F4: victim's name unchanged");
assert(victimAfter.birth_date === victimBefore.birth_date, "F4: victim's birth date unchanged");
assert(Number(victimAfter.daily_limit_minutes) === 30, "F4: victim's daily limit unchanged");
assert(String(victimAfter.bedtime_Cutoff ?? victimAfter.bedtime_cutoff ?? "") === "20:00", "F4: victim's bedtime unchanged");
assert(
  JSON.stringify(victimAfter.allowed_book_slugs) === JSON.stringify(["alpha"]),
  "F4: victim's allowed books unchanged"
);
assert(victimAfter.user_id === "user-victim", "F4: victim's row keeps its user_id");

// ...and nothing was created for the attacker.
const attackerProfiles = await listKidProfiles(db, "user-attacker");
assert(attackerProfiles.length === 0, "F4: no new row created for the attacker");
assert(
  (await listKidProfiles(db, "user-victim")).length === 1,
  "F4: no duplicate row created for the victim"
);

// The caller's OWN profile id still updates.
const own = await upsertKidProfile(db, "user-victim", {
  id: victimId,
  name: "Renamed Kid",
  daily_limit_minutes: 45,
});
assert(own.name === "Renamed Kid", "own profile id still updates");
assert(Number(own.daily_limit_minutes) === 45, "own profile limit still updates");

// No id at all still creates a new profile.
const fresh = await upsertKidProfile(db, "user-victim", { name: "Second Kid" });
assert(String(fresh.id) !== victimId, "no-id upsert creates a fresh profile");

// Defense in depth pin: the SQL guard itself.
const familySrc = await Bun.file(new URL("../src/lib/family.ts", import.meta.url)).text();
assert(
  familySrc.includes("WHERE kid_profiles.user_id = excluded.user_id"),
  "DO UPDATE clause carries the user_id guard (defense in depth)"
);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll family upsert ownership tests passed.");
