// The staged bible build (2026-11-06 rework, phase 1).
//
// Replaces the monolith bible call, where one giant Opus JSON carried
// cast + ladder + inventory + vocab and any single defect (a taken
// name, a short list) invalidated the whole artifact at full price.
// Here each part is its own small call behind its own code gate, parts
// persist at books/{slug}/bible-parts/{cast,ladder,inventory}.json and
// are reused when they still pass their gate, and a failed part retries
// alone at its own price:
//
//   cast       hands chain   invents the hero from the reader's source
//                            pack (or honors a given hero); the library
//                            is never shown, only taken names.
//   ladder     writer chain  the one frontier-priced creative call.
//   inventory  hands chain   termMap + vocab + world lists; the
//                            forbidden list itself is built in CODE
//                            from the pack, never invented by a model.
//
// The assembled bible still faces validateBible in the workflow, with
// its repair loop as the outer net.

import { callModel } from "./models";
import { emitEvent } from "./events";
import { parseSourceIdentity } from "./sourceguard";
import { scanForbiddenTerms } from "./biblegate";
import {
  buildCastPrompt,
  buildLadderPrompt,
  buildInventoryPrompt,
  buildStageRepairPrompt,
} from "./bibleprompt";
import type { SourcePack } from "./reader";

async function r2GetJson(BOOKS: R2Bucket, key: string): Promise<any | null> {
  try {
    const o = await BOOKS.get(key);
    if (!o) return null;
    return JSON.parse(await o.text());
  } catch {
    return null;
  }
}

async function r2PutJson(BOOKS: R2Bucket, key: string, v: any): Promise<void> {
  await BOOKS.put(key, JSON.stringify(v, null, 1), {
    httpMetadata: { contentType: "application/json" },
  });
}

// ---------------------------------------------------------------------
// Deterministic term expansion: plurals and possessive variants are
// string work, not model work.
// ---------------------------------------------------------------------
export function expandVariants(terms: string[]): string[] {
  const out = new Set<string>();
  for (const raw of terms) {
    const t = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!t) continue;
    const base = t.replace(/['’]s$/, "").replace(/['’]$/, "");
    out.add(t);
    out.add(base);
    const words = base.split(" ");
    const last = words[words.length - 1];
    if (last && last.length > 2 && !last.endsWith("s")) {
      words[words.length - 1] = last.endsWith("y") && !/[aeiou]y$/.test(last)
        ? `${last.slice(0, -1)}ies`
        : `${last}s`;
      out.add(words.join(" "));
    }
    if (base.includes(" ")) out.add(`${base}s`);
  }
  return [...out].filter((t) => t.length >= 2);
}

// The forbidden list, built in code: source title phrase + author
// surname forms + the reader's extracted labels + the real terms the
// ladder drew on. Individual generic title words are NOT banned (a
// money book may say "money"); phrases and labels are.
export function buildForbidden(pack: SourcePack, sourceTermsUsed: string[], bookInfo: any): string[] {
  const seeds: string[] = [];
  const rawTitle = String(bookInfo?.sourceTitle ?? bookInfo?.title ?? "");
  const id = parseSourceIdentity(rawTitle);
  if (id?.title) seeds.push(id.title.replace(/-/g, " "));
  if (id?.surname) seeds.push(id.surname);
  seeds.push(...(pack?.labels ?? []));
  seeds.push(...(pack?.keyTerms ?? []));
  seeds.push(...(sourceTermsUsed ?? []));
  return expandVariants(seeds).slice(0, 60);
}

// ---------------------------------------------------------------------
// Stage gates (pure; mirror the bible gate's invariants per part).
// ---------------------------------------------------------------------
export function castGate(cast: any, taken: Set<string>, hero: any): string[] {
  const problems: string[] = [];
  if (!cast || typeof cast !== "object") return ["cast is not an object"];
  if (!String(cast.bookTitle ?? "").trim()) problems.push("bookTitle is empty");
  if (!String(cast.bigIdea ?? "").trim()) problems.push("bigIdea is empty");
  const chars = [cast.protagonist, ...(Array.isArray(cast.supportingCast) ? cast.supportingCast : [])].filter(
    (c: any) => c && typeof c === "object"
  );
  if (chars.length < 1 || chars.length > 3)
    problems.push(`cast must be 1 to 3 characters, found ${chars.length}`);
  const names = new Set<string>();
  const species = new Set<string>();
  for (const c of chars) {
    const nm = String(c.name ?? "").trim();
    if (!nm) problems.push("a character has no name");
    else {
      if (names.has(nm.toLowerCase())) problems.push(`duplicate character name '${nm}'`);
      names.add(nm.toLowerCase());
      if (taken.has(nm.toLowerCase()))
        problems.push(`character name '${nm}' is already used by another book`);
    }
    const sp = String(c.species ?? "").trim().toLowerCase();
    if (!sp) problems.push(`character '${nm}' has no species`);
    else {
      if (species.has(sp)) problems.push(`two characters share the species '${sp}'`);
      species.add(sp);
    }
    const vis = String(c.visual ?? "").trim();
    if (!vis) problems.push(`character '${nm}' has no visual description`);
    else if (vis.split(/\s+/).length > 45)
      problems.push(`character '${nm}' visual is over 40 words`);
  }
  if (hero?.name) {
    const p = cast.protagonist ?? {};
    if (String(p.name ?? "").trim().toLowerCase() !== String(hero.name).trim().toLowerCase())
      problems.push(`the protagonist must be the given hero ${hero.name}, got '${p.name ?? ""}'`);
    if (hero.species && !String(p.species ?? "").toLowerCase().includes(String(hero.species).toLowerCase().split(" ").pop()!))
      problems.push(`the hero ${hero.name} must be a ${hero.species}, got '${p.species ?? ""}'`);
  }
  if (!String(cast.openingJob ?? "").trim()) problems.push("openingJob is empty");
  if (!String(cast.setting ?? "").trim()) problems.push("setting is empty");
  if (!Array.isArray(cast.locations) || cast.locations.length < 4)
    problems.push("locations must list at least 4 places");
  return problems;
}

export function ladderGate(ladder: any, chapterCount: number, labels: string[]): string[] {
  const problems: string[] = [];
  const runs = Array.isArray(ladder?.conceptLadder) ? ladder.conceptLadder : [];
  if (runs.length !== chapterCount)
    problems.push(`conceptLadder must have exactly ${chapterCount} rungs (one per source chapter), found ${runs.length}`);
  const metaphors = new Set<string>();
  let anyFailure = false;
  let anyMissing = false;
  runs.forEach((e: any, i: number) => {
    const want = `S${i + 1}`;
    if (String(e?.storyChapter ?? "") !== want)
      problems.push(`rung ${i + 1} must be storyChapter ${want}, got '${e?.storyChapter ?? ""}'`);
    if (Number(e?.sequence) !== i + 1) problems.push(`rung ${want} has the wrong sequence`);
    for (const f of ["title", "idea", "mechanism", "metaphor"]) {
      if (!String(e?.[f] ?? "").trim()) problems.push(`rung ${want} is missing ${f}`);
    }
    const m = String(e?.metaphor ?? "").trim().toLowerCase();
    if (m) {
      if (metaphors.has(m)) problems.push(`rung ${want} repeats another rung's metaphor`);
      metaphors.add(m);
    }
    const fc = String(e?.failureCase ?? "").trim();
    if (fc) anyFailure = true;
    else anyMissing = true;
    if (fc && fc.length < 20) problems.push(`rung ${want} failureCase is under 20 characters`);
    if (fc && fc === String(e?.mechanism ?? "").trim())
      problems.push(`rung ${want} failureCase repeats its mechanism`);
  });
  if (anyFailure && anyMissing)
    problems.push("failureCase must appear on every rung or on none");
  if (labels.length) {
    const text = runs.map((e: any) => `${e?.title ?? ""} ${e?.idea ?? ""} ${e?.metaphor ?? ""}`).join("\n");
    for (const hit of scanForbiddenTerms(text, labels))
      problems.push(`an author label leaks into the ladder: '${hit.term}'`);
  }
  return problems;
}

export function inventoryGate(inv: any, forbidden: string[]): string[] {
  const problems: string[] = [];
  const exists = Array.isArray(inv?.exists) ? inv.exists : [];
  const dne = Array.isArray(inv?.doesNotExist) ? inv.doesNotExist : [];
  if (exists.length < 15) problems.push(`exists must list at least 15 items, found ${exists.length}`);
  if (dne.length < 8) problems.push(`doesNotExist must list at least 8 items, found ${dne.length}`);
  const mapped = new Set<string>();
  for (const m of Array.isArray(inv?.termMap) ? inv.termMap : []) {
    const t = String(m?.term ?? "").trim().toLowerCase();
    if (t && String(m?.storyName ?? "").trim()) mapped.add(t);
  }
  for (const v of Array.isArray(inv?.vocab) ? inv.vocab : []) {
    const t = String(v?.term ?? "").trim().toLowerCase();
    if (t && String(v?.storyName ?? "").trim()) mapped.add(t);
  }
  for (const t of forbidden) {
    if (!mapped.has(t)) problems.push(`forbidden term '${t}' has no storyName mapping in termMap or vocab`);
  }
  return problems;
}

// ---------------------------------------------------------------------
// Orchestration: one stage = one call, one gate, at most one repair.
// A persisted part that still passes its gate is reused verbatim, so a
// workflow step retry never re-buys a finished part.
// ---------------------------------------------------------------------
async function runStage(
  env: any,
  slug: string,
  part: string,
  prompt: string,
  role: "writer" | "hands",
  maxTokens: number,
  gate: (data: any) => string[],
  repairContext: string
): Promise<any> {
  const key = `books/${slug}/bible-parts/${part}.json`;
  const saved = await r2GetJson(env.BOOKS, key);
  if (saved && gate(saved).length === 0) {
    console.log(`bible stage ${part}: reusing saved part for ${slug}`);
    return saved;
  }
  let { data } = await callModel(env, prompt, maxTokens, role, { slug, purpose: `bible-${part}` });
  let problems = data ? gate(data) : [`${part} call returned no JSON`];
  if (problems.length) {
    console.log(`bible stage ${part} for ${slug} failed its gate: ${problems.join("; ")}`);
    const fix = await callModel(
      env,
      `${buildStageRepairPrompt(part, problems, data ?? {})}\n\nADDITIONAL CONTEXT:\n${repairContext}`,
      maxTokens,
      role,
      { slug, purpose: `bible-${part}-repair` }
    );
    if (fix.data) {
      data = fix.data;
      problems = gate(data);
    }
  }
  if (!data || problems.length) {
    throw new Error(`bible stage ${part} failed its gate after one repair: ${problems.join("; ")}`);
  }
  await r2PutJson(env.BOOKS, key, data);
  await emitEvent(env, {
    slug,
    kind: "bible-stage",
    stage: part,
    event: "part_accepted",
    detail: `${part} passed its gate`,
  }).catch(() => {});
  return data;
}

export async function buildBibleStaged(
  env: any,
  slug: string,
  bookInfo: any,
  pack: SourcePack,
  taken: Set<string>,
  hero: any
): Promise<any> {
  const takenArr = [...taken];
  // ---- cast ---------------------------------------------------------
  const cast = await runStage(
    env,
    slug,
    "cast",
    buildCastPrompt(bookInfo, pack, takenArr, hero),
    "hands",
    4096,
    (d) => castGate(d, taken, hero),
    `Taken names: ${takenArr.join(", ") || "(none)"}. ${hero?.name ? `The hero is ${hero.name} the ${hero.species}.` : "Invent the hero from the source's world."}`
  );
  const sourceKind = cast.sourceKind === "technical" ? "technical" : "ideas";
  // ---- ladder -------------------------------------------------------
  const chapterCount = pack.chapters.length;
  const ladder = await runStage(
    env,
    slug,
    "ladder",
    buildLadderPrompt(bookInfo, pack, cast),
    "writer",
    16384,
    (d) => ladderGate(d, chapterCount, pack.labels ?? []),
    `Exactly ${chapterCount} rungs, S1..S${chapterCount}. The final rung finishes the opening job: ${cast.openingJob}`
  );
  // ---- inventory ----------------------------------------------------
  const forbidden = buildForbidden(pack, ladder.sourceTermsUsed ?? [], bookInfo);
  const inv = await runStage(
    env,
    slug,
    "inventory",
    buildInventoryPrompt(cast, ladder, forbidden, sourceKind),
    "hands",
    6144,
    (d) => inventoryGate(d, forbidden),
    `Every one of these forbidden terms needs a termMap or vocab storyName: ${forbidden.join(", ")}`
  );
  // ---- assemble -----------------------------------------------------
  const chars = [cast.protagonist, ...(cast.supportingCast ?? [])].filter(Boolean);
  const bible: any = {
    bookTitle: cast.bookTitle,
    bigIdea: cast.bigIdea,
    ageBand: cast.ageBand ?? bookInfo?.ageBand ?? "4 to 8",
    sourceKind,
    protagonist: cast.protagonist,
    supportingCast: cast.supportingCast ?? [],
    characters: chars,
    setting: cast.setting,
    locations: cast.locations ?? [],
    openingJob: cast.openingJob,
    starNote: cast.starNote ?? "",
    series: cast.series ?? { name: null, promise: null, throughLine: null, rule: null, companion: null, starter: null },
    conceptLadder: ladder.conceptLadder,
    metaphorBank: (ladder.conceptLadder ?? []).map((e: any) => ({
      storyChapter: e.storyChapter,
      metaphor: e.metaphor,
    })),
    arc: ladder.arc ?? "",
    runningGags: ladder.runningGags ?? [],
    bannedOpeners: ladder.bannedOpeners ?? [],
    worldInventory: {
      exists: inv.exists ?? [],
      doesNotExist: inv.doesNotExist ?? [],
      forbiddenSourceTerms: forbidden,
    },
    termMap: inv.termMap ?? [],
    vocab: inv.vocab ?? [],
    _bible_model: "staged:reader+hands+writer",
    _bible_staged: true,
  };
  return bible;
}
