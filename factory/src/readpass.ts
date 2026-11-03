// Whole-book read pass (added 2026-10-28, Phase 1 of the factory
// rethink). Until now the text pipeline had NO whole-book gate: the
// chapter critic saw one chapter at a time plus a state summary, never
// the actual prose of the other chapters, so cross-chapter defects
// shipped in finished books (Wally's story mentioned a computer in an
// animal harbor with no computers; Juno's early chapters had story
// problems nobody read end to end). This pass gives the head of the
// writer chain (Opus) the entire book at once: bible, ladder, and every
// chapter's real text in order.
//
// Severity model (locked by CG in the rethink discussion):
//  - BLOCK checks (hook pickup, world rules, source fidelity, metaphor
//    honesty): any failure means verdict "revise" and the book parks
//    at needs_review BEFORE any art spend.
//  - WARN checks (story sense, opening-job payoff, idea arrival,
//    variety, kid test and fun): logged and ranked, never block.
// The verdict is recomputed in code from the checks, so a lenient
// model verdict cannot override a failed BLOCK check.
//
// Wally (docker) and Juno (motivationmanifesto) are the permanent
// regression set for this prompt: it must flag Wally's computer and
// surface Juno's early-chapter story problems.
//
// Legacy bibles without a worldInventory still run: the world check
// degrades to the story's own established world (common sense), and
// the missing inventory itself is reported as a bible gap.

import { callModel } from "./models";

export interface ReadCheckMeta {
  id: number;
  key: string;
  severity: "block" | "warn";
  label: string;
}

export const READ_CHECKS: ReadCheckMeta[] = [
  { id: 1, key: "hook_pickup", severity: "block", label: "Hook pickup by the next chapter" },
  { id: 2, key: "world_rules", severity: "block", label: "World rules vs the world inventory" },
  { id: 3, key: "source_fidelity", severity: "block", label: "Source fidelity: every ladder idea taught, mechanism in order" },
  { id: 4, key: "metaphor_honesty", severity: "block", label: "Metaphor honesty: no metaphor teaches something false and uncorrected" },
  { id: 5, key: "story_sense", severity: "warn", label: "Story sense: no 'wait, why?' pages" },
  { id: 6, key: "opening_job_payoff", severity: "warn", label: "Opening-job payoff" },
  { id: 7, key: "idea_arrival", severity: "warn", label: "Idea arrival: story, not lecture" },
  { id: 8, key: "variety", severity: "warn", label: "Variety across chapters" },
  { id: 9, key: "kid_test_fun", severity: "warn", label: "Kid test and fun" },
];

export interface ReadChapterInput {
  chapter: string;
  title?: string;
  realConcept?: string;
  pages: { storyText?: string; concept?: string }[];
  finale?: { storyText?: string };
  hook?: string;
}

export function plansToReadInput(plans: any[]): ReadChapterInput[] {
  return (plans ?? [])
    .filter((p) => p && Array.isArray(p.pages))
    .map((p) => ({
      chapter: String(p.storyChapter ?? p.chapter ?? ""),
      title: p.storyTitle ?? p.title,
      realConcept: p.realConcept ? String(p.realConcept) : undefined,
      pages: p.pages.map((pg: any) => ({
        storyText: String(pg.storyText ?? ""),
        concept: pg.concept ? String(pg.concept) : undefined,
      })),
      finale: p.finale ? { storyText: String(p.finale.storyText ?? "") } : undefined,
      hook: p.hook ? String(p.hook) : undefined,
    }));
}

// Cheap change detector: the stored report is reused only while the
// plan texts it judged are byte-identical, so a regen that rewrites a
// chapter re-runs the pass instead of reusing a stale verdict.
export function readFingerprint(bible: any, chapters: ReadChapterInput[]): string {
  const src =
    JSON.stringify(bible?.worldInventory ?? null) +
    "|" +
    chapters
      .map(
        (c) =>
          c.chapter +
          "\n" +
          (c.title ?? "") +
          "\n" +
          (c.realConcept ?? "") +
          "\n" +
          c.pages.map((p) => (p.storyText ?? "") + "\n" + (p.concept ?? "")).join("\n") +
          "\n" +
          (c.finale?.storyText ?? "") +
          "\n" +
          (c.hook ?? "")
      )
      .join("\n==\n");
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < src.length; i++) {
    h1 = Math.imul(h1 ^ src.charCodeAt(i), 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 31) + src.charCodeAt(i)) >>> 0;
  }
  return `${src.length}-${h1.toString(16)}-${h2.toString(16)}`;
}

function bibleForPrompt(bible: any): any {
  const ladder = Array.isArray(bible.conceptLadder) ? bible.conceptLadder : [];
  const bank = new Map<string, any>(
    (Array.isArray(bible.metaphorBank) ? bible.metaphorBank : []).map((m: any) => [
      String(m?.storyChapter ?? ""),
      m,
    ])
  );
  return {
    bookTitle: bible.bookTitle ?? "",
    bigIdea: bible.bigIdea ?? "",
    setting: bible.setting ?? "",
    locations: bible.locations ?? [],
    characters: (bible.characters ?? []).map((c: any) => ({
      name: c.name,
      species: c.species,
    })),
    openingJob: bible.openingJob ?? null,
    worldInventory: bible.worldInventory ?? null,
    vocab: bible.vocab ?? [],
    ladder: ladder.map((e: any) => {
      const m = bank.get(String(e?.storyChapter ?? ""));
      return {
        storyChapter: e.storyChapter ?? e.chapter,
        title: e.title,
        idea: e.idea,
        mechanism: e.mechanism,
        metaphor: e.metaphor ?? m?.metaphor ?? "",
        fidelity: m?.fidelity ?? "",
        simplificationHides: e.simplificationHides ?? m?.simplificationHides ?? "",
      };
    }),
  };
}

export function buildReadPassPrompt(bible: any, chapters: ReadChapterInput[]): string {
  const hasInventory = !!bible?.worldInventory;
  const bookText = chapters
    .map((c) => {
      const pages = c.pages
        .map(
          (p, i) =>
            `Page ${i + 1}: ${p.storyText ?? ""}` +
            (p.concept ? `\nPage ${i + 1} concept note (printed): ${p.concept}` : "")
        )
        .join("\n");
      const concept = c.realConcept
        ? `\nParents' concept line (printed in the book): ${c.realConcept}`
        : "";
      const finale = c.finale?.storyText ? `\nFinale: ${c.finale.storyText}` : "";
      const hook = c.hook ? `\nHook left for the next chapter: ${c.hook}` : "";
      return `## ${c.chapter}: ${c.title ?? ""}\n${pages}${concept}${finale}${hook}`;
    })
    .join("\n\n");

  const worldSection =
    "Book text under review includes EVERYTHING printed: the story text, each page's printed concept " +
    "note, and each chapter's parents' concept line. The world rules bind all of it: a real-world " +
    "machine or source term named in a concept line is a world break exactly as if a character had " +
    "said it, because it is printed in the book. " +
    (hasInventory
      ? "The bible below declares a worldInventory. Check 2 judges the book against it exactly: " +
        "anything shown or named that is not in exists, anything from doesNotExist, and any " +
        "forbiddenSourceTerms word is a world-rules failure, even if it appears once, even in dialogue."
      : "This bible predates world inventories, so there is no declared list to check against. For check 2, " +
        "judge world consistency against the world the story itself establishes (its setting, its locations, " +
        "its animal cast, and what earlier chapters establish as normal). A real-world technology object (a " +
        "computer, a phone, a screen), a piece of source-domain jargon with no story name, or anything else " +
        "the established world has no version of is a world-rules failure: quote the exact line. Also list " +
        "the missing worldInventory itself in bibleGaps.");

  return (
    "You are the senior editor doing the final whole-book read of a kids' storybook (ages 4-8) " +
    "that teaches real concepts through an animal story. You are reading the ENTIRE book at once: " +
    "every chapter's actual story text, in order. No single-chapter reviewer has seen this whole text.\n\n" +
    `BIBLE (trimmed):\n${JSON.stringify(bibleForPrompt(bible), null, 1)}\n\n` +
    `${worldSection}\n\n` +
    `THE WHOLE BOOK, in order:\n${bookText}\n\n` +
    "Rule on EACH of the 9 checks below separately. For every check give: pass (true or false), " +
    "evidence (quote the EXACT line from the book that decides it; if several lines matter, quote the " +
    "worst one; write 'no line shows this' only when nothing in the book decides it), and fix (one " +
    "concrete sentence: what to change; empty when it passes).\n" +
    "BLOCK checks (a failure on ANY of these means the book is not ready):\n" +
    "1. HOOK PICKUP. For each chapter except the last: does the NEXT chapter's opening actually pick up " +
    "the hook this chapter left (the unresolved problem or question), instead of ignoring it or starting " +
    "over? A hook that is dropped, or answered offstage, FAILS.\n" +
    "2. WORLD RULES. Does anything in the story break the story world's rules (see the world note above)? " +
    "Quote the exact offending line.\n" +
    "3. SOURCE FIDELITY. Does every ladder chapter's idea actually get taught in its chapter, with the " +
    "mechanism's cause and effect in the ladder's order? A chapter that skips its idea, teaches a " +
    "different one, or scrambles the mechanism's order FAILS.\n" +
    "4. METAPHOR HONESTY. Does any chapter's metaphor teach something FALSE about the real idea, in a way " +
    "no later chapter corrects? Judge against each metaphor's simplificationHides in the bible: what a " +
    "metaphor admits it hides is fine only if the book handles it honestly; a metaphor that leaves a " +
    "child believing the opposite of the truth FAILS.\n" +
    "WARN checks (real problems worth fixing, but they never block the book on their own):\n" +
    "5. STORY SENSE. Any page where a reader would stop and ask 'wait, why?' (a character acts against " +
    "their want, something appears from nowhere, a cause has no effect or an effect no cause)?\n" +
    "6. OPENING-JOB PAYOFF. The bible's openingJob is the job the story opens in the middle of. Is it " +
    "actually the spine of the book, and does its finish line land as the payoff? (If the bible has no " +
    "openingJob, judge whether the book has ANY concrete through-line job and say so.)\n" +
    "7. IDEA ARRIVAL. Per chapter: does the idea arrive as a tool grabbed mid-job while solving a " +
    "problem, or as a lecture, explanation scene, or list? Name the worst lecture chapter.\n" +
    "8. VARIETY. Do chapters differ in situation, stakes, and shape, or do they repeat one pattern " +
    "(same opening move, same rescue, same ending beat)?\n" +
    "9. KID TEST AND FUN. Words a 6-year-old would not understand that the text never explains; and is " +
    "there at least one joke, surprise, or running gag that actually lands?\n\n" +
    "Also give chapterNotes: one entry per chapter, action 'rewrite' (the chapter needs new drafting), " +
    "'patch' (small fixes only), or 'ok', with one or two sentences of notes. Give bibleGaps: anything " +
    "the story needed that the bible failed to declare (a missing world item, an unmapped term, a ladder " +
    "hole); phrase these as bible defects, not writing errors. Rank warnings: the failed WARN checks' " +
    "fixes, most damaging first.\n" +
    'Reply with ONLY this JSON: {"checks": [{"id": 1, "severity": "block", "pass": true, ' +
    '"evidence": "...", "fix": ""}], "chapterNotes": [{"chapter": "S1", "action": "ok", "notes": ""}], ' +
    '"bibleGaps": [], "warnings": [], "verdict": "ship"}. ' +
    'verdict is "revise" if any BLOCK check fails, "ship_with_warnings" if all BLOCK checks pass but ' +
    "any WARN check fails, otherwise \"ship\". No em dashes anywhere."
  );
}

// Normalize the model's JSON into the stored report shape and recompute
// the verdict from the BLOCK checks in code: the model's own verdict
// field is advisory only.
export function normalizeReadReport(data: any, model: string, fingerprint: string): any {
  const byId = new Map<number, any>();
  for (const c of Array.isArray(data?.checks) ? data.checks : []) {
    const id = Number(c?.id);
    if (Number.isFinite(id)) byId.set(id, c);
  }
  const checks = READ_CHECKS.map((meta) => {
    const c = byId.get(meta.id) ?? {};
    return {
      id: meta.id,
      key: meta.key,
      severity: meta.severity,
      pass: !!c.pass,
      evidence: String(c.evidence ?? ""),
      fix: String(c.fix ?? ""),
    };
  });
  const blockFail = checks.some((c) => c.severity === "block" && !c.pass);
  const warnFail = checks.some((c) => c.severity === "warn" && !c.pass);
  const verdict = blockFail ? "revise" : warnFail ? "ship_with_warnings" : "ship";
  const warnings = Array.isArray(data?.warnings) && data.warnings.length
    ? data.warnings.map(String)
    : checks
        .filter((c) => c.severity === "warn" && !c.pass)
        .map((c) => c.fix || c.evidence)
        .filter(Boolean);
  return {
    checks,
    chapterNotes: (Array.isArray(data?.chapterNotes) ? data.chapterNotes : []).map((n: any) => ({
      chapter: String(n?.chapter ?? ""),
      action: ["rewrite", "patch", "ok"].includes(n?.action) ? n.action : "patch",
      notes: String(n?.notes ?? ""),
    })),
    bibleGaps: (Array.isArray(data?.bibleGaps) ? data.bibleGaps : []).map(String),
    warnings,
    verdict,
    modelVerdict: typeof data?.verdict === "string" ? data.verdict : null,
    model,
    fingerprint,
    at: Math.floor(Date.now() / 1000),
  };
}

// Run the read pass for one book and store the report at
// books/{slug}/readpass.json in R2. A stored report whose fingerprint
// still matches the current plans is returned as-is (no model call).
// The missing-inventory bible gap is appended deterministically for
// legacy bibles so it surfaces even if the model forgets it.
export async function runReadPass(
  env: any,
  slug: string,
  bible: any,
  plans: any[]
): Promise<any> {
  const chapters = plansToReadInput(plans);
  if (!chapters.length) throw new Error(`read pass: no chapter plans found for ${slug}`);
  const fingerprint = readFingerprint(bible, chapters);
  const key = `books/${slug}/readpass.json`;
  try {
    const obj = await env.BOOKS.get(key);
    if (obj) {
      const existing = await obj.json();
      if (existing?.fingerprint === fingerprint && existing?.verdict) return existing;
    }
  } catch {
    // unreadable stored report: fall through and regenerate
  }
  const prompt = buildReadPassPrompt(bible, chapters);
  const { data, model } = await callModel(env, prompt, 8192, "writer", {
    slug,
    purpose: "readpass",
  });
  const report = normalizeReadReport(data, model, fingerprint);
  if (!bible?.worldInventory) {
    const gap =
      "bible gap: no worldInventory (exists / doesNotExist / forbiddenSourceTerms); world consistency was judged against the story's own established world";
    if (!report.bibleGaps.some((g: string) => g.includes("worldInventory"))) {
      report.bibleGaps.unshift(gap);
    }
  }
  await env.BOOKS.put(key, JSON.stringify(report, null, 1), {
    httpMetadata: { contentType: "application/json" },
  });
  return report;
}
