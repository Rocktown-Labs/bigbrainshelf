// Bible gate + normalization: the schema authority for story bibles.
//
// Two bible shapes exist in the wild:
//  - Canonical (hand-authored / bookstore-attached): characters[] plus a
//    conceptLadder whose entries carry metaphor, mechanism, failureCase
//    and location inline.
//  - Factory-generated (bibleprompt.ts): protagonist + supportingCast +
//    newCharacters instead of characters[], and metaphors in a separate
//    metaphorBank[] keyed by storyChapter, with no failureCase and a
//    top-level locations[] pool instead of per-chapter locations.
//
// normalizeBible folds the generated shape into the canonical one
// (cast merged into characters[], bank metaphors merged into ladder
// entries) WITHOUT inventing content: no failureCase is fabricated for
// bibles that never had one. Pipelines normalize at the bible stage so
// every downstream consumer (planner, gate, sheets, matter) reads one
// shape. This matters: planv3 reads bible.characters, and a generated
// bible silently gave it an empty cast, which is part of why the
// DevOps book drifted.
//
// The gate then runs cheap structural checks BEFORE any planning or
// image spend. Born from real failures:
//  - Docker S15's self-contradictory failureCase burned ~50 plan
//    attempts (2026-10-22) because nothing validated the bible itself.
//  - pythonfordevops' generated bible lifted Pip and Skipper straight
//    out of the character library into a different book, against CG's
//    rule (2026-10-23): character names are never reused across
//    stories. planv3 never saw them (empty characters[]), and the seal
//    in the plans is what got drawn.
//  - The planv3 ladder lookup bug showed chapter keys must be exact:
//    S1..Sn, no gaps, no dupes.
//
// The gate is structural, not editorial: it cannot judge whether a
// metaphor is good, only whether the bible is complete, internally
// consistent, and legal under the house rules.

export function normalizeBible(bible: any): any {
  if (!bible || typeof bible !== "object") return bible;
  const b = { ...bible };

  if (!Array.isArray(b.characters) || !b.characters.length) {
    const cast: any[] = [];
    if (b.protagonist?.name) cast.push(b.protagonist);
    for (const c of b.supportingCast ?? []) if (c?.name) cast.push(c);
    for (const c of b.newCharacters ?? []) if (c?.name) cast.push(c);
    if (cast.length) b.characters = cast;
  }

  if (Array.isArray(b.conceptLadder) && Array.isArray(b.metaphorBank)) {
    const bank = new Map<string, any>(
      b.metaphorBank.map((m: any) => [String(m?.storyChapter ?? ""), m])
    );
    b.conceptLadder = b.conceptLadder.map((e: any) => {
      if (e?.metaphor) return e;
      const m = bank.get(String(e?.storyChapter ?? e?.chapter ?? ""));
      return m?.metaphor ? { ...e, metaphor: m.metaphor } : e;
    });
  }

  return b;
}

// ------------------------------------------------------------ world lint
//
// World-inventory lint (added 2026-10-28, Phase 1 of the factory
// rethink). Pure code, no model. Bibles written since the redesign
// carry an openingJob and a worldInventory (exists / doesNotExist /
// forbiddenSourceTerms, see bibleprompt.ts); this lint holds them to
// the declared minimums and keeps forbidden terms out of the bible's
// own descriptive fields.
//
// Two result classes, deliberately:
//  - gaps: the inventory (or openingJob) is absent entirely. That is a
//    reported bible gap, NOT a failure: every legacy bible predates
//    the inventory, and a missing inventory must never crash a gate.
//  - problems: the inventory is present but broken (too thin, a
//    forbidden term with no vocab storyName, a forbidden term leaking
//    into setting/locations/metaphors/arc/gags). validateBible folds
//    problems into its reasons, so a NEW bible with a broken inventory
//    fails the gate before any spend; gaps never fail it.

export interface WorldLint {
  gaps: string[];
  problems: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary scan of text for terms; returns one hit per (term,
// offending line). Lines are newline-split, then sentence-split when
// long, so evidence quotes stay readable.
export function scanForbiddenTerms(
  text: string,
  terms: string[]
): { term: string; line: string }[] {
  if (!text || !terms.length) return [];
  const pats = terms
    .map((t) => String(t).trim().toLowerCase())
    .filter(Boolean)
    .map((t) => ({ term: t, re: new RegExp(`\\b${escapeRegExp(t)}\\b`, "i") }));
  if (!pats.length) return [];
  const lines: string[] = [];
  for (const chunk of String(text).split(/\n+/)) {
    const c = chunk.trim();
    if (!c) continue;
    if (c.length <= 300) {
      lines.push(c);
    } else {
      for (const s of c.split(/(?<=[.!?])\s+/)) if (s.trim()) lines.push(s.trim());
    }
  }
  const hits: { term: string; line: string }[] = [];
  for (const line of lines) {
    for (const p of pats) {
      if (p.re.test(line)) hits.push({ term: p.term, line: line.slice(0, 300) });
    }
  }
  return hits;
}

export function forbiddenTermsOf(bible: any): string[] {
  const inv = bible?.worldInventory;
  if (!inv || typeof inv !== "object" || !Array.isArray(inv.forbiddenSourceTerms)) return [];
  return inv.forbiddenSourceTerms.map((t: any) => String(t).trim().toLowerCase()).filter(Boolean);
}

export function lintWorldInventory(rawBible: any): WorldLint {
  const gaps: string[] = [];
  const problems: string[] = [];
  if (!rawBible || typeof rawBible !== "object") {
    return { gaps: ["bible gap: bible is missing or not an object"], problems };
  }
  const bible = normalizeBible(rawBible);

  const job = String(bible.openingJob ?? "").trim();
  if (!job) {
    gaps.push("bible gap: no openingJob (the concrete job the story opens in the middle of)");
  } else if (job.split(/\s+/).length >= 30) {
    problems.push(`openingJob is ${job.split(/\s+/).length} words (must be under 30)`);
  }

  const inv = bible.worldInventory;
  if (!inv || typeof inv !== "object") {
    gaps.push(
      "bible gap: no worldInventory (exists / doesNotExist / forbiddenSourceTerms); world consistency cannot be linted or gated for this book"
    );
    return { gaps, problems };
  }
  const exists = Array.isArray(inv.exists) ? inv.exists : [];
  const doesNotExist = Array.isArray(inv.doesNotExist) ? inv.doesNotExist : [];
  const forbidden = forbiddenTermsOf(bible);
  if (exists.length < 15) problems.push(`worldInventory.exists has ${exists.length} items (minimum 15)`);
  if (doesNotExist.length < 8) {
    problems.push(`worldInventory.doesNotExist has ${doesNotExist.length} items (minimum 8)`);
  }
  if (forbidden.length < 10) {
    problems.push(`worldInventory.forbiddenSourceTerms has ${forbidden.length} items (minimum 10)`);
  }

  // Every forbidden term must be mapped: present in vocab as a real
  // term with a storyName, so writers have a legal way to say it.
  const vocabTerms = new Set(
    (Array.isArray(bible.vocab) ? bible.vocab : []).map((v: any) =>
      String(v?.term ?? "").trim().toLowerCase()
    )
  );
  for (const t of forbidden) {
    if (!vocabTerms.has(t)) {
      problems.push(`forbiddenSourceTerm '${t}' has no vocab entry with a storyName`);
    }
  }

  // The bible's own descriptive fields must not contain forbidden terms
  // (vocab.term and realMapsTo are the only legal homes for real terms).
  const fields: [string, string][] = [
    ["setting", String(bible.setting ?? "")],
    ["locations", (Array.isArray(bible.locations) ? bible.locations : []).join(" ")],
    ["arc", [bible.arc?.act1, bible.arc?.act2, bible.arc?.act3].filter(Boolean).join(" ")],
    ["runningGags", (Array.isArray(bible.runningGags) ? bible.runningGags : []).join(" ")],
  ];
  const ladder = Array.isArray(bible.conceptLadder) ? bible.conceptLadder : [];
  ladder.forEach((e: any, i: number) => {
    const ch = String(e?.storyChapter ?? e?.chapter ?? `S${i + 1}`);
    fields.push([`${ch} metaphor`, String(e?.metaphor ?? "")]);
  });
  const bank = Array.isArray(bible.metaphorBank) ? bible.metaphorBank : [];
  bank.forEach((m: any) => {
    fields.push([
      `${String(m?.storyChapter ?? "?")} metaphor`,
      String(m?.metaphor ?? "") + " " + String(m?.why ?? ""),
    ]);
  });
  for (const [field, text] of fields) {
    for (const hit of scanForbiddenTerms(text, forbidden)) {
      problems.push(`forbidden term '${hit.term}' appears in ${field}: "${hit.line}"`);
    }
  }

  return { gaps, problems };
}

// Reusable chapter lint: scans a chapter's story text, image prompt,
// and structured scene fields for the bible's forbidden source terms.
// Returns offending lines, or [] when the bible has no inventory
// (legacy bibles lint clean by definition; the gap is reported by
// lintWorldInventory instead). Used by planv3's critic as a
// programmatic gate alongside the model checks.
export function lintChapterFields(
  bible: any,
  fields: { storyText?: string; imagePrompt?: string; scene?: any }
): { field: string; term: string; line: string }[] {
  const terms = forbiddenTermsOf(bible);
  if (!terms.length) return [];
  const out: { field: string; term: string; line: string }[] = [];
  for (const hit of scanForbiddenTerms(String(fields.storyText ?? ""), terms)) {
    out.push({ field: "story text", ...hit });
  }
  for (const hit of scanForbiddenTerms(String(fields.imagePrompt ?? ""), terms)) {
    out.push({ field: "image prompt", ...hit });
  }
  const scene = fields.scene;
  if (scene && typeof scene === "object") {
    const sceneText = [
      String(scene.setting ?? ""),
      ...(Array.isArray(scene.cast) ? scene.cast.map((c: any) => String(c?.doing ?? "")) : []),
      ...(Array.isArray(scene.props) ? scene.props.map((p: any) => String(p ?? "")) : []),
    ].join("\n");
    for (const hit of scanForbiddenTerms(sceneText, terms)) {
      out.push({ field: "scene", ...hit });
    }
  }
  return out;
}

export function validateBible(rawBible: any, takenNames: Set<string>): string[] {
  const reasons: string[] = [];
  if (!rawBible || typeof rawBible !== "object") return ["bible is missing or not an object"];
  const bible = normalizeBible(rawBible);

  if (!String(bible.bookTitle ?? "").trim()) reasons.push("bookTitle is empty");

  const chars = Array.isArray(bible.characters) ? bible.characters : [];
  if (chars.length < 1 || chars.length > 3) {
    reasons.push(`cast has ${chars.length} characters (house rule: 1 to 3)`);
  }
  const seen = new Set<string>();
  for (const c of chars) {
    const name = String(c?.name ?? "").trim();
    if (!name) {
      reasons.push("a character has no name");
      continue;
    }
    const lower = name.toLowerCase();
    if (seen.has(lower)) reasons.push(`character name '${name}' appears twice in this bible`);
    seen.add(lower);
    if (takenNames.has(lower)) {
      reasons.push(`character name '${name}' is already used by another book (names are never reused across stories)`);
    }
    if (!String(c?.visual ?? "").trim()) reasons.push(`character '${name}' has no visual description`);
  }

  const ladder = Array.isArray(bible.conceptLadder) ? bible.conceptLadder : [];
  if (ladder.length < 3) {
    reasons.push(`conceptLadder has ${ladder.length} chapters (minimum 3)`);
    return reasons;
  }
  const chapters = ladder.map((e: any) => String(e?.storyChapter ?? e?.chapter ?? ""));
  const expected = ladder.map((_: any, i: number) => `S${i + 1}`);
  if (JSON.stringify(chapters) !== JSON.stringify(expected)) {
    reasons.push(`storyChapter sequence must be exactly ${expected.join(",")} (got ${chapters.join(",") || "none"})`);
  }
  const hasLocationsPool = Array.isArray(bible.locations) && bible.locations.length > 0;
  const anyFailureCase = ladder.some((e: any) => String(e?.failureCase ?? "").trim());
  const metaphors = new Map<string, string>();
  ladder.forEach((e: any, i: number) => {
    const ch = expected[i];
    const metaphor = String(e?.metaphor ?? "").trim();
    const mechanism = String(e?.mechanism ?? "").trim();
    const failure = String(e?.failureCase ?? "").trim();
    const location = String(e?.location ?? "").trim();
    if (!metaphor) reasons.push(`${ch}: no metaphor (ladder entry and metaphorBank both empty)`);
    if (!mechanism) reasons.push(`${ch}: mechanism is empty`);
    if (!location && !hasLocationsPool) reasons.push(`${ch}: no location (ladder entry and locations pool both empty)`);
    if (anyFailureCase) {
      if (!failure) {
        reasons.push(`${ch}: failureCase is empty (this bible carries failure cases; all chapters need one)`);
      } else {
        if (failure.length < 20) reasons.push(`${ch}: failureCase is too thin to plan against (under 20 chars)`);
        if (mechanism && failure.toLowerCase() === mechanism.toLowerCase()) {
          reasons.push(`${ch}: failureCase just repeats the mechanism (the S15 contradiction class)`);
        }
      }
    }
    if (metaphor) {
      const norm = metaphor.toLowerCase();
      if (metaphors.has(norm)) {
        reasons.push(`${ch}: metaphor duplicates ${metaphors.get(norm)} (one metaphor per chapter)`);
      } else {
        metaphors.set(norm, ch);
      }
    }
  });

  // World lint: a present-but-broken inventory fails the gate; a
  // missing one (every legacy bible) is a gap, reported by
  // lintWorldInventory callers, and never blocks here.
  reasons.push(...lintWorldInventory(bible).problems);

  return reasons;
}
