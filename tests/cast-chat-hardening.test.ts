// SECURITY F6 (2026-10-31): cast-chat hardening — the route spends
// real AI gateway credits and answers children, so it must be
// rate-limited per user, restricted to catalog books, and must not
// accept another family's kid profile id. Source pins (the route
// lives behind the Workers runtime; behavior pins live in the F4/F5
// suites for the shared helpers it uses).
// Run with: bun tests/cast-chat-hardening.test.ts
import { askCastCompanion } from "../src/lib/family-sync";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const read = async (rel: string) =>
  Bun.file(new URL(rel, import.meta.url)).text();

const routeSrc = await read("../src/pages/api/account/cast-chat.ts");
assert(
  routeSrc.includes("cast_chat:min:") && routeSrc.includes("cast_chat:day:"),
  "F6: per-user minute + daily rate limits on the route"
);
assert(routeSrc.includes("429"), "F6: over-limit requests get a 429, not an AI call");
assert(
  routeSrc.includes("SELECT slug FROM books WHERE slug = ?"),
  "F6: the book slug is validated against the catalog"
);
assert(
  routeSrc.includes("SELECT id FROM kid_profiles WHERE id = ? AND user_id = ?"),
  "F6: a kid profile id must belong to the caller"
);
assert(
  routeSrc.includes("String(body.kidProfileId)"),
  "F6: kid profile ids are handled as strings (they are UUIDs, not numbers)"
);
assert(
  routeSrc.includes("allowlist") && routeSrc.includes("TODO(output filter)"),
  "F6: the output filter TODO is flagged before the companion UI ships"
);

// The lib accepts a string kid profile id (typed contract after the
// route fix) and keeps the 280-char question cap.
const reply = await askCastCompanion({
  userId: "u-test",
  kidProfileId: "11111111-2222-3333-4444-555555555555",
  bookSlug: "fern-counts-the-forest",
  characterName: "Fern",
  questionText: "x".repeat(400),
});
assert(
  reply.questionText.length === 280,
  "F6: the lib still caps the stored question at 280 chars"
);
assert(reply.source === "story_canon_scaffolding", "F6: no gateway configured -> deterministic canon fallback");
assert(reply.characterName === "Fern", "F6: character resolves from the cast roster");

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll cast-chat hardening tests passed.");
