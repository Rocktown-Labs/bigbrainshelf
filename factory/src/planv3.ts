// Port of plan_chapter_v3.py: the planner that obeys the bible.
// - Title VERBATIM from the ladder entry. No inventing.
// - No raw source-chapter text dump; the ladder entry IS the spec.
// - Banned openers for S4+ are PER-BOOK data (bible.bannedOpeners,
//   generated at bible time from the book's own source and early
//   chapters). Until 2026-10-28 this file hardcoded Docker's list
//   ("once, the harbor built", "giant wagon", ...) and a Docker cast
//   note ("do not make Pip the star") for every book; Phase 1 of the
//   factory rethink moved all of it into the bible, with only a tiny
//   generic fallback left here. No book-specific names or phrases may
//   be hardcoded in this file again.
// - World rules: when the bible carries a worldInventory, the writer
//   prompt gets a hard WORLD RULES block, the critic gains a world
//   consistency check, and a deterministic forbidden-term lint runs in
//   code (biblegate.ts).
// - Hook chaining: first page must address the previous chapter's hook.
// - Critic pass: programmatic checks + model critic, up to 3 attempts.
// - Trigram overlap check vs previous chapters (threshold 0.35).
import { callModel, callOpusAcceptance } from "./models";
import { gatewayConfigured, gatewayDecide } from "./gateway";
import { lintChapterFields } from "./biblegate";

export const MAX_ATTEMPTS = 3;
export const OVERLAP_THRESHOLD = 0.35;

// Generic fallback only, used when a bible predates per-book
// bannedOpeners (every legacy bible). Book-specific lists live in the
// bible now.
export const GENERIC_BANNED_OPENERS = ["long ago", "in the old days"];
export const BANNED_OPENERS = GENERIC_BANNED_OPENERS;

export function bannedOpenersFor(bible: any): string[] {
  const b = bible?.bannedOpeners;
  if (Array.isArray(b) && b.length) {
    return b.map((s: any) => String(s).toLowerCase()).filter(Boolean);
  }
  return [...GENERIC_BANNED_OPENERS];
}

// The hard world block injected into the writer prompt when the bible
// declares an inventory. Writers see ONLY what exists, what never
// exists, and the words that are banned outright.
export function worldRulesBlock(bible: any): string {
  const inv = bible?.worldInventory;
  if (!inv || typeof inv !== "object") return "";
  const exists = (Array.isArray(inv.exists) ? inv.exists : []).join(", ");
  const never = (Array.isArray(inv.doesNotExist) ? inv.doesNotExist : []).join(", ");
  const forbidden = (Array.isArray(inv.forbiddenSourceTerms) ? inv.forbiddenSourceTerms : []).join(", ");
  let out = "WORLD RULES (hard, breaking these fails the chapter):\n";
  if (exists) out += `This world contains ONLY these things: ${exists}.\n`;
  if (never) out += `This world NEVER contains: ${never}.\n`;
  if (forbidden) {
    out +=
      `Never write these words anywhere, not in story text, not in image prompts, not in dialogue: ${forbidden}. ` +
      `If the idea needs one, use its story name from the vocab instead.\n`;
  }
  return out;
}

function ladderFor(bible: any, slug: string): any {
  // Ladder entries key on 'storyChapter' ("S4"). The old lookup read
  // 'chapter', always missed, and '' in slug then matched the FIRST entry
  // for every chapter: on 2026-10-22 every factory-planned chapter was
  // silently planned as S1 (S10 shipped as a duplicate of 'The Island
  // Mix-Up' and S6 burned ~20 attempts against S1's sea-chest metaphor).
  const l = (bible.conceptLadder ?? []).find(
    (c: any) => (c.storyChapter ?? c.chapter ?? "") === slug
  );
  if (!l) throw new Error(`no ladder entry for ${slug}`);
  return l;
}

function metaphorFor(bible: any, slug: string): any {
  return (bible.metaphorBank ?? []).find(
    (m: any) => (m.storyChapter ?? m.chapter ?? "") === slug
  );
}

// The chapter's assigned metaphor, wherever the bible carries it
// (metaphorBank first, the ladder entry as fallback). One resolver so
// the prompt, the anchor check, and the critic all judge the same
// object.
export function assignedMetaphor(bible: any, slug: string): { metaphor: string; why: string } | null {
  const fromBank = metaphorFor(bible, slug);
  if (fromBank?.metaphor) return { metaphor: String(fromBank.metaphor), why: String(fromBank.why ?? "") };
  const ladder = (bible.conceptLadder ?? []).find(
    (c: any) => (c.storyChapter ?? c.chapter ?? "") === slug
  );
  if (ladder?.metaphor)
    return { metaphor: String(ladder.metaphor), why: String(ladder.simplificationHides ?? "") };
  return null;
}

const ANCHOR_STOPWORDS = new Set([
  "the", "a", "an", "of", "with", "and", "her", "his", "their", "its",
  "on", "in", "at", "to", "for", "that", "this", "from", "into", "over",
]);

// Candidate anchor words for a metaphor string ("blueprint" ->
// ["blueprint", "blueprints"]; "the acorn orchard" -> acorn/orchard
// forms). The check is deliberately generous: ANY candidate present
// counts as anchored, plurals included.
export function metaphorAnchorWords(metaphor: string): string[] {
  const out = new Set<string>();
  for (const w of String(metaphor ?? "").toLowerCase().split(/[^a-z]+/)) {
    if (w.length < 4 || ANCHOR_STOPWORDS.has(w)) continue;
    out.add(w);
    if (w.endsWith("s")) out.add(w.slice(0, -1));
    else out.add(`${w}s`);
  }
  return [...out];
}

// True when the plan's text names the metaphor object somewhere. The
// failure this catches is total absence: Joy's S1 burned all 5 attempts
// on 2026-11-06 writing a generic workshop story that never put its
// assigned blueprint on the page, and every attempt paid for a full
// critic read to learn it.
export function metaphorAnchored(plan: any, metaphor: string): boolean {
  const words = metaphorAnchorWords(metaphor);
  if (!words.length) return true;
  const text = JSON.stringify(plan ?? {}).toLowerCase();
  return words.some((w) => new RegExp(`\\b${w}\\b`).test(text));
}

function chapterNum(slug: string): number {
  const m = slug.match(/S(\d+)/);
  return m ? parseInt(m[1], 10) : 99;
}

export function buildPrompt(
  bible: any,
  slug: string,
  storySoFar = "",
  prevHook = "",
  criticNotes = ""
): string {
  const chars = (bible.characters ?? [])
    .map((c: any) => `${c.name} (${c.visual})`)
    .join("; ");
  const ladder = ladderFor(bible, slug);
  // Metaphor fallback: the critic judges the ladder's metaphor, so the
  // writer must always see it. Penny's bible carries no metaphorBank,
  // and before this fix its writers were failed for a metaphor they
  // never received (exposed by the 2026-10-24 model test).
  const meta = assignedMetaphor(bible, slug);
  const chNum = chapterNum(slug);

  let banBlock = "";
  if (chNum >= 4) {
    const openers = bannedOpenersFor(bible);
    banBlock =
      "BANNED OPENERS for this chapter. Do NOT open with any variant of: " +
      openers.map((o) => `'${o}'`).join(", ") +
      ". Openings that re-litigate an old way of doing things were the early chapters' job. " +
      "This chapter starts INSIDE the story's world, with the new problem.\n";
  }

  const worldBlock = worldRulesBlock(bible);

  let vocabBlock = "";
  if (Array.isArray(bible.vocab) && bible.vocab.length) {
    vocabBlock =
      "Vocab (real term = story name). In story text and image prompts use ONLY the story name, never the real term:\n" +
      bible.vocab.map((v: any) => `${v.term} = ${v.storyName}`).join("; ") +
      "\n";
  }

  let hookBlock = "";
  if (prevHook) {
    hookBlock =
      `The previous chapter ended with this unresolved hook: "${prevHook}"\n` +
      `Your FIRST page must address or pick up this hook directly. Do not ignore it and restart.\n`;
  }

  let sofarBlock = "";
  if (storySoFar) {
    sofarBlock =
      `CURRENT STATE (things that now exist because of previous chapters; ` +
      `use them as established facts, do not re-explain the premise):\n${storySoFar}\n`;
  }

  let metaphorBlock = "";
  if (meta) {
    metaphorBlock =
      `Use ONLY this metaphor: ${meta.metaphor}\nWhy it fits: ${meta.why}\n` +
      `HARD RULE: the metaphor is a PHYSICAL OBJECT in the story world, not a theme. ` +
      `The ${meta.metaphor} itself must appear on the page as a real thing the characters ` +
      `touch, carry, or use: in the first scene and again at the payoff. A draft where the ` +
      `object never physically appears is rejected unread.\n`;
  }

  let criticBlock = "";
  if (criticNotes) {
    criticBlock =
      `A reviewer rejected your previous draft for these reasons. Fix ALL of them:\n${criticNotes}\n`;
  }

  const safeTitle = String(ladder.title ?? "").replace(/"/g, '\\"');
  return (
    "You are an expert curriculum designer and children's book author writing one chapter " +
    "of a kids' storybook (ages 4-8) that teaches technical concepts.\n" +
    `Book: ${bible.bookTitle ?? ""}. Big idea: ${bible.bigIdea ?? ""}\n` +
    `Characters (use these exact visuals, never redesign): ${chars}\n` +
    `Setting: ${bible.setting ?? ""}\n` +
    sofarBlock +
    hookBlock +
    banBlock +
    worldBlock +
    vocabBlock +
    criticBlock +
    `CHAPTER TITLE (use EXACTLY, do not change a word): ${ladder.title}\n` +
    `This chapter must teach ONLY this one idea: ${ladder.idea}\n` +
    `The real mechanism (your story must follow this cause and effect, in this order): ${ladder.mechanism}\n` +
    `It builds on: ${ladder.buildsOn}\n` +
    `The failure case that proves the idea matters: ${ladder.failureCase}\n` +
    metaphorBlock +
    "Write 4 pages plus a finale. Each page: 2-4 simple sentences (read-aloud), " +
    "one clear visual moment, at most 2 characters on screen.\n" +
    "CRITICAL RULES:\n" +
    "1. The story must teach THIS chapter's idea so specifically that swapping in another " +
    "chapter's idea would break the story. Name the idea in plain words inside the story.\n" +
    "2. Follow the mechanism's cause and effect in order. Include the failure case: show what " +
    "goes wrong when the idea is ignored.\n" +
    "3. End with a small win AND a hook: one new unresolved problem or question (1-2 sentences) " +
    "that the NEXT chapter can pick up. Only the book's final chapter ends with the big payoff.\n" +
    "4. Vary which character leads; " +
    (bible.starNote ? `${String(bible.starNote).replace(/\.?$/, ".")}` : "do not make the same character the star every chapter.") +
    "\n" +
    "5. STORY FIRST: open the chapter inside a problem the hero cares about: something " +
    "they want, fear losing, or must finish before a deadline. The chapter's idea must " +
    "arrive as the ANSWER to that problem, discovered while solving it, never as a " +
    "lecture or an explanation scene. If a page could be deleted without changing " +
    "the story, rewrite it.\n" +
    "6. NEVER recite steps in dialogue (no 'Step one... step two...' speeches). " +
    "Characters DO the steps while racing the problem; the reader learns them by " +
    "watching the work. Counts and numbers appear on at most one page, as a " +
    "discovery the characters react to, never as a recital.\n" +
    "Hard rules for every imagePrompt (clean black-and-white line art):\n" +
    "- NO color words at all. NO text, letters, numbers, or words anywhere in the art: no signs, " +
    "labels, screens, shirts with writing, book covers with titles, name tags, banners, or " +
    "chalkboards with words. Describe boxes, jars, and containers as plain and unmarked. " +
    "Never put a character's name in the imagePrompt. No marked clothing.\n" +
    "- Paste each character's visual description VERBATIM from the character list above.\n" +
    "- The imagePrompt must depict THAT page's storyText scene, INCLUDING its setting: " +
    "if the text says water, harbor, docks, or sea, the art shows water; if it says " +
    "shore, sand, or kitchen, the art shows that place. Never draw a generic floating " +
    "character when the text names a location.\n" +
    "- END every imagePrompt by describing the place GENERICALLY, with a location word " +
    "from the story (harbor, dock, shore, island, kitchen, bay, lighthouse, village, " +
    "sea, water): finish the line like 'at the busy island harbor' or 'on the sandy " +
    "shore'. NEVER use a place's NAME (like Brambleburrow or Bellweather Square) in an " +
    "imagePrompt or a scene field: the art model draws names as lettering on signs. " +
    "A prompt with no place word in it is rejected automatically, so check every page " +
    "before replying.\n" +
    "- Max 2 characters and 3 props per image. One clear subject, bold clean outlines, " +
    "no shading, no gray fills, wide white margins.\n" +
    "ALSO give every page and the finale a structured \"scene\" object. Rules for scene " +
    "fields: cast names appear ONLY in cast[].name, never inside doing, setting, or " +
    "props; describe places by what they look like, never by their name; each cast " +
    "member appears exactly once, doing one clear physical action, in one single " +
    "moment; props are at most 3 plain unmarked objects (no signs, lists, plans, maps, " +
    "labels, or books with writing); cast is animals only, no people. colorScript " +
    "names each cast member's colors plus background and light; it guides the later " +
    "coloring step and never appears in the line art.\n" +
    "Reply with ONLY a JSON object: " +
    `{"storyTitle": "${safeTitle}", ` +
    `"realConcept": "one line for parents: what this chapter actually teaches", ` +
    `"pages": [{"character": name, "concept": one sentence, "imagePrompt": one line, ` +
    `"scene": {"cast": [{"name": character name, "doing": one physical action}], ` +
    `"setting": generic visual description of the place, "props": [plain objects], ` +
    `"colorScript": {"<character name>": "their colors", "background": "...", "light": "..."}}, ` +
    `"storyText": "2-4 sentences"}], ` +
    `"finale": {"imagePrompt": one line, "scene": {same shape as a page scene}, "storyText": "2-3 sentences"}, ` +
    `"takeaway": "one plain-language sentence: what the reader learned", ` +
    `"hook": "1-2 sentences: the unresolved problem or question for the next chapter", ` +
    `"newStorySoFar": "3 sentences of STATE: what now exists or is known (not the premise)"}. ` +
    "No em dashes."
  );
}

// The thoroughness critic prompt (locked 2026-10-24): the judge must
// rule on each check separately and quote the line that decides it.
// In the Penny S5 test, GLM judging agreed with Opus on every major
// defect but filed half the issues: accurate, stops early. Forcing
// per-check verdicts with evidence is how the judge gets thorough.
// Check 7 (world consistency, added 2026-10-28) is included only when
// the bible declares a worldInventory; without one there is no list
// to judge against, and the deterministic forbidden-term lint in
// criticCheck covers what code can.
export function buildCriticPrompt(plan: any, ladder: any, bible?: any): string {
  const storyText =
    (plan.pages ?? []).map((p: any) => p.storyText ?? "").join(" ") +
    " " +
    (plan.finale?.storyText ?? "");
  const inv = bible?.worldInventory;
  let worldCheck = "";
  if (inv && typeof inv === "object") {
    const exists = (Array.isArray(inv.exists) ? inv.exists : []).join(", ");
    const never = (Array.isArray(inv.doesNotExist) ? inv.doesNotExist : []).join(", ");
    const forbidden = (Array.isArray(inv.forbiddenSourceTerms) ? inv.forbiddenSourceTerms : []).join(", ");
    worldCheck =
      "7. WORLD CONSISTENCY. The story world contains ONLY: " +
      `${exists}. It NEVER contains: ${never}. These words are forbidden in the story: ${forbidden}. ` +
      "Does any page show, mention, or imply an object, place, creature, or term that is not in the " +
      "exists list, or anything from the never list, or any forbidden word? Quote the exact offending " +
      "line as evidence. If yes, it FAILS. One exception: if the chapter's idea genuinely needs a term " +
      "the world does not declare, still FAIL, but phrase the issue as a BIBLE GAP (the bible must add " +
      "the thing to its world or give the term a story name), not as a writing error.\n";
  }
  return (
    "You are a strict children's curriculum reviewer. A chapter plan was written for a kids' " +
    "storybook (ages 4-8) that teaches technical concepts.\n" +
    `The chapter MUST teach this idea: ${ladder.idea}\n` +
    `Using this metaphor: ${ladder.metaphor ?? ""}\n` +
    `Following this mechanism: ${ladder.mechanism}\n\n` +
    `Chapter title: ${plan.storyTitle}\n` +
    `Story text:\n${storyText}\n\n` +
    "Rule on EACH check separately. For every check give: pass (true or false), " +
    "evidence (quote the exact line from the story that decides it, or write " +
    "'no line shows this'), and issue (one concrete problem sentence when it " +
    "fails, empty when it passes).\n" +
    "1. Does the story teach THIS specific idea (not just 'containers are handy')?\n" +
    "2. Does it follow the mechanism's cause and effect, all the way to the payoff?\n" +
    "3. Does it use the assigned metaphor rather than a generic box?\n" +
    "4. Would this story still make sense if a different chapter's idea were swapped in? " +
    "(If yes, it FAILS.)\n" +
    "5. Does the chapter open inside a problem the hero cares about (a want, a worry, " +
    "a deadline), with the idea arriving as the answer to that problem? If the opening " +
    "pages mostly explain or lecture, it FAILS.\n" +
    "6. Does any page merely recite a list of steps or numbers in dialogue instead of " +
    "the characters doing the steps under pressure? If yes, it FAILS.\n" +
    worldCheck +
    'Reply with ONLY JSON: {"checks": [{"n": 1, "pass": true, "evidence": "...", "issue": ""}, ...], ' +
    '"pass": true/false}. pass is true ONLY if every check passes. No em dashes.'
  );
}

// Lenient verdict parse: the thoroughness shape (checks[]) or the old
// {pass, issues} shape a fallback model might still return.
export function parseCriticVerdict(data: any): { pass: boolean; issues: string[] } {
  if (Array.isArray(data?.checks) && data.checks.length) {
    const issues = data.checks
      .filter((c: any) => !c.pass)
      .map((c: any) => String(c.issue || `Check ${c.n} failed.`));
    return { pass: issues.length === 0 && data.pass !== false, issues };
  }
  return {
    pass: !!data?.pass,
    issues: Array.isArray(data?.issues) ? data.issues.map(String) : ["Critic rejected the chapter."],
  };
}

export async function criticCheck(
  env: any,
  plan: any,
  bible: any,
  slug: string,
  bookSlug?: string
): Promise<{ ok: boolean; notes: string }> {
  const ladder = ladderFor(bible, slug);
  const storyText =
    (plan.pages ?? []).map((p: any) => p.storyText ?? "").join(" ") +
    " " +
    (plan.finale?.storyText ?? "");
  const lowered = storyText.toLowerCase();
  const issues: string[] = [];

  if ((plan.storyTitle ?? "").trim() !== ladder.title) {
    issues.push(`Title must be exactly '${ladder.title}' but was '${plan.storyTitle}'.`);
  }
  // Empty-draft guard: a fallback writer returned a structurally valid
  // plan with empty story text on Penny S5 (2026-10-24) and burned a
  // full gate + judge cycle discovering it. A real chapter is ~200
  // words; anything under 40 is not a draft.
  const wordCount = storyText.split(/\s+/).filter(Boolean).length;
  if (wordCount < 40) {
    issues.push(
      `The story text is empty or near-empty (${wordCount} words). Write the full chapter: 4 pages of story plus a finale, every page with real story text.`
    );
  }
  if (chapterNum(slug) >= 4) {
    const head = lowered.slice(0, 600);
    for (const b of bannedOpenersFor(bible)) {
      if (head.includes(b)) {
        issues.push(
          `Story opens with a banned opener ('${b}'). Start inside the story's world, in the middle of the current problem.`
        );
        break;
      }
    }
  }
  const ideaNouns = String(ladder.idea ?? "")
    .toLowerCase()
    .match(/[a-z]{4,}/g)
    ?.filter((w) => !["that", "with", "from", "this", "they", "will", "into", "when"].includes(w)) ?? [];
  const hits = ideaNouns.slice(0, 8).filter((w) => lowered.includes(w)).length;
  if (hits < 2) {
    issues.push("The story does not seem to teach this chapter's specific idea; it reads generic.");
  }
  // Setting check: if a page's text names a location, the art must show it.
  // Match on the bible's location phrases plus strong setting nouns, with
  // word boundaries so 'sea-chest' (a prop) does not count as the sea.
  const locPhrases = (bible.locations ?? []).map((l: any) => String(l).toLowerCase());
  const settingNouns = ["water", "sea", "ocean", "harbor", "dock", "lighthouse",
    "shore", "sand", "kitchen", "island", "village", "bay", "wave", "tide"];
  const settingHits = (s: string): string[] => {
    const low = s.toLowerCase();
    const out = locPhrases.filter((p) => low.includes(p));
    for (const w of settingNouns) {
      if (new RegExp(`(?<!-)\\b${w}\\b(?!-chest)`).test(low)) out.push(w);
    }
    return out;
  };
  const settingCovered = (prm: string, hits: string[]): boolean => {
    const low = prm.toLowerCase();
    return hits.some((h) => {
      const esc = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?<!-)\\b${esc}\\b(?!-chest)`).test(low);
    });
  };
  // Proper-noun scrub (2026-10-27): place NAMES in an art prompt come
  // back as lettering on signs ("Bramblebrrow", "BELLWATTER / SOPAARE",
  // "Plan-Ahead burrow"). Strip bible location names out of image
  // prompts and scene prose, and character names out of scene prose
  // (names live only in scene cast[].name). Deterministic and free, so
  // it scrubs instead of burning a planning attempt on a rejection.
  const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rawLocations = (bible.locations ?? [])
    .map((l: any) => String(l))
    .filter((l: string) => /[A-Z]/.test(l));
  const charNames = (bible.characters ?? []).map((c: any) => String(c.name)).filter(Boolean);
  const scrubText = (s: string, withChars: boolean): string => {
    let out = s;
    for (const loc of rawLocations) {
      out = out.replace(new RegExp(escRe(loc), "gi"), "the story's setting");
    }
    if (withChars) {
      for (const n of charNames) {
        out = out.replace(new RegExp(`\\b${escRe(n)}\\b`, "g"), "it");
      }
    }
    return out;
  };
  const allPages: any[] = [...(plan.pages ?? []), ...(plan.finale ? [plan.finale] : [])];
  for (const pg of allPages) {
    if (pg.imagePrompt) pg.imagePrompt = scrubText(String(pg.imagePrompt), false);
    const sc = pg.scene;
    if (sc) {
      if (sc.setting) sc.setting = scrubText(String(sc.setting), true);
      if (Array.isArray(sc.props)) sc.props = sc.props.map((p: any) => scrubText(String(p), true));
      if (Array.isArray(sc.cast)) {
        for (const c of sc.cast) {
          if (c.doing) c.doing = scrubText(String(c.doing), true);
        }
      }
    }
  }
  // Scene presence: new plans must carry the structured scene; the
  // image prompt is assembled from it in code from here on.
  (plan.pages ?? []).forEach((pg: any, i: number) => {
    if (!pg.scene?.cast?.length) {
      issues.push(
        `Page ${i + 1} has no structured scene. Give every page a scene object with cast, setting, props, and colorScript.`
      );
    }
  });
  if (plan.finale && !plan.finale.scene?.cast?.length) {
    issues.push("The finale has no structured scene. Give it a scene object like the pages.");
  }
  for (let i = 0; i < plan.pages.length; i++) {
    const named = settingHits(plan.pages[i].storyText ?? "");
    if (named.length && !settingCovered(plan.pages[i].imagePrompt ?? "", named)) {
      // Do not reject the draft over this: the hard reject burned all 5
      // attempts on Penny S4 (the word 'village') and Wren S5 ('water')
      // on 2026-10-23. Name the setting in the prompt instead. But name
      // it GENERICALLY (2026-10-27): appending a place's proper name
      // verbatim is how "Brambleburrow" became a sign. A generic noun
      // cannot be lettered; a proper name gets a scenery instruction.
      const hit = named[0];
      const append = settingNouns.includes(hit)
        ? `Setting: the ${hit}.`
        : "Setting: the place from the story, drawn as scenery with no signs or lettering.";
      plan.pages[i].imagePrompt = `${plan.pages[i].imagePrompt ?? ""} ${append}`.trim();
      console.log(`setting check: appended generic setting to page ${i + 1}'s imagePrompt (hit '${hit}')`);
    }
  }
  // Label check: a "labeled" container in the art prompt makes the image
  // model draw words, which image QC then rejects. Catch it here, where
  // the fix is free. (Observed 2026-10-22: 3.6 drafts kept writing
  // "a crate labeled 'Cake Model'" and the critic model never flagged it.)
  const allPrompts = [...(plan.pages ?? []).map((p: any) => p.imagePrompt ?? ""),
    plan.finale?.imagePrompt ?? ""];
  for (let i = 0; i < allPrompts.length; i++) {
    if (/\blabel/i.test(allPrompts[i])) {
      issues.push(
        `Art prompt ${i + 1} describes a LABELED container. Containers must be plain ` +
        `and unmarked: remove the word label and any words the art would draw.`);
      break;
    }
  }

  // Forbidden-term lint (2026-10-28): deterministic, free, and exact.
  // When the bible declares forbiddenSourceTerms, any hit in story
  // text, an image prompt, or a scene field is an automatic issue with
  // the offending line quoted. Legacy bibles have no inventory and
  // lint clean (the gap is reported at the bible gate instead).
  {
    const lintHits: string[] = [];
    const units: any[] = [...(plan.pages ?? []), ...(plan.finale ? [plan.finale] : [])];
    units.forEach((pg: any, i: number) => {
      const where = i < (plan.pages ?? []).length ? `page ${i + 1}` : "the finale";
      for (const hit of lintChapterFields(bible, {
        storyText: pg.storyText,
        imagePrompt: pg.imagePrompt,
        scene: pg.scene,
      })) {
        lintHits.push(
          `Forbidden term '${hit.term}' in ${where} ${hit.field}: "${hit.line}". Use the term's story name from the vocab instead.`
        );
      }
    });
    issues.push(...lintHits.slice(0, 3));
  }

  // Jev gate (locked 2026-10-24): a decision-model triage in front of
  // the prose critic, at ~$0.00004 a call. Its mechanism boolean was a
  // laser in the S5 test (0.72 for the dramatized draft, 0.03 for the
  // summarized one, the exact defect that kills chapters here). A gate
  // failure joins the notes like any other issue; a gate ERROR never
  // blocks a chapter.
  if (gatewayConfigured(env)) {
    try {
      const answers = await gatewayDecide(
        env,
        `Chapter brief: title '${ladder.title}', idea: ${ladder.idea}\nMechanism: ${ladder.mechanism}\n\nStory text:\n${storyText}`,
        {
          teaches_idea: {
            type: "boolean",
            instructions: `Does the story teach this specific idea: ${ladder.idea}?`,
          },
          mechanism_shown: {
            type: "boolean",
            instructions:
              "Does the story SHOW this mechanism happening as actions under pressure, " +
              "rather than summarizing lessons in a list or ending before the payoff? " +
              `Mechanism: ${ladder.mechanism}`,
          },
        }
      );
      const mech = answers?.mechanism_shown?.probability;
      const teach = answers?.teaches_idea?.probability;
      if (typeof mech === "number" && mech < 0.5) {
        issues.push(
          `Jev gate: the mechanism reads summarized, not shown (mechanism_shown ${mech.toFixed(2)}). ` +
            "Dramatize the mechanism as actions under pressure and land the payoff inside the chapter."
        );
      } else if (typeof teach === "number" && teach < 0.35) {
        issues.push(
          `Jev gate: the story does not read as teaching this chapter's idea (teaches_idea ${teach.toFixed(2)}).`
        );
      }
    } catch (e: any) {
      console.log(`jev gate unavailable (${e?.message ?? e}); continuing to the prose critic`);
    }
  }

  try {
    const { data } = await callModel(env, buildCriticPrompt(plan, ladder, bible), 4096, "judge", {
      slug: bookSlug,
      purpose: "critic",
    });
    const verdict = parseCriticVerdict(data);
    if (!verdict.pass) issues.push(...verdict.issues);
  } catch (e: any) {
    console.log(`critic unavailable (${e?.message ?? e}); programmatic checks only`);
  }
  return { ok: issues.length === 0, notes: issues.map((i) => `- ${i}`).join("\n") };
}

export function trigrams(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const out = new Set<string>();
  for (let i = 0; i + 3 <= words.length; i++) {
    out.add(words.slice(i, i + 3).join(" "));
  }
  return out;
}

export function overlapScore(plan: any, prevPlans: any[]): number {
  const text = (plan.pages ?? []).map((p: any) => p.storyText ?? "").join(" ");
  const tg = trigrams(text);
  if (!tg.size) return 0;
  let best = 0;
  for (const prev of prevPlans) {
    const ptext = (prev.pages ?? []).map((p: any) => p.storyText ?? "").join(" ");
    const ptg = trigrams(ptext);
    if (!ptg.size) continue;
    const inter = [...tg].filter((t) => ptg.has(t)).length;
    const union = new Set([...tg, ...ptg]).size;
    best = Math.max(best, inter / union);
  }
  return best;
}

// One planning attempt: generate, critic-check, overlap-check. Split out so
// workflow callers can put each attempt in its own step (a full 3-attempt
// loop inside one step can exceed the platform's 10-minute step timeout
// when the model chain is riding out rate limits).
export async function planChapterAttempt(
  env: any,
  bible: any,
  slug: string,
  storySoFar = "",
  prevHook = "",
  criticNotes = "",
  prevPlans: any[] = [],
  bookSlug?: string
): Promise<{ plan: any; passed: boolean; notes: string; model: string }> {
  const prompt = buildPrompt(bible, slug, storySoFar, prevHook, criticNotes);
  const res = await callModel(env, prompt, 4096, "writer", { slug: bookSlug, purpose: "plan" });
  const plan = res.data;
  // Free anchor check before any judging spend: if the assigned
  // metaphor object never appears in the plan, the critic's verdict is
  // already known (it rejected Joy's S1 five times for exactly this).
  // Fail the attempt here with the precise fix as the note, and let
  // the retry loop carry it into the next draft's prompt.
  const meta = assignedMetaphor(bible, slug);
  if (plan && meta && !metaphorAnchored(plan, meta.metaphor)) {
    return {
      plan,
      passed: false,
      notes:
        `- The assigned metaphor object (${meta.metaphor}) never appears in the story. ` +
        `Put the physical object itself in the characters' hands: present in the first scene ` +
        `and again at the payoff, used to do the chapter's work, not just mentioned as an idea.`,
      model: res.model,
    };
  }
  const { ok, notes } = await criticCheck(env, plan, bible, slug, bookSlug);
  let allNotes = notes;
  let passed = ok;
  const ov = overlapScore(plan, prevPlans);
  if (ov > OVERLAP_THRESHOLD) {
    passed = false;
    allNotes += `\n- Story overlaps too much with a previous chapter (similarity ${ov.toFixed(2)}). Use the assigned metaphor and a fresh situation.`;
  }
  // Opus acceptance seat (locked 2026-10-24): one Opus look at a chapter
  // that already passed everything else. In the S5 test Opus judging
  // caught taste and logic problems nobody else filed (a starvation
  // backstory too grim for ages 4-8), at ~$0.04 a look, so it gates
  // acceptance instead of burning on every attempt. If the seat itself
  // errors (gateway down, balance out), the chapter stands on the judge
  // chain's verdict and the failure is logged, never silent.
  if (passed) {
    try {
      const data = await callOpusAcceptance(env, buildCriticPrompt(plan, ladderFor(bible, slug), bible), {
        slug: bookSlug,
        purpose: "acceptance",
      });
      const verdict = parseCriticVerdict(data);
      if (!verdict.pass) {
        passed = false;
        allNotes += "\n" + verdict.issues.map((i) => `- Opus acceptance: ${i}`).join("\n");
      }
    } catch (e: any) {
      console.log(`opus acceptance unavailable (${e?.message ?? e}); chapter stands on the judge chain verdict`);
    }
  }
  return { plan, passed, notes: allNotes, model: res.model };
}

export async function planChapter(
  env: any,
  bible: any,
  slug: string,
  storySoFar = "",
  prevHook = "",
  prevPlans: any[] = []
): Promise<any> {
  let criticNotes = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const att = await planChapterAttempt(env, bible, slug, storySoFar, prevHook, criticNotes, prevPlans);
    if (att.passed) {
      att.plan._v3_attempts = attempt;
      att.plan._model = att.model;
      return att.plan;
    }
    criticNotes = att.notes;
    console.log(`${slug}: attempt ${attempt} failed checks, retrying...`);
  }
  throw new Error(`${slug}: failed critic checks after ${MAX_ATTEMPTS} attempts. Last issues:\n${criticNotes}`);
}
