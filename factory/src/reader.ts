// The Reader: a frontier model actually READS the source, chapter by
// chapter, and writes the source pack every later stage works from.
//
// Why this exists (2026-11-06): the old bookinfo stage never read the
// source at all. Each chapter's "summary" was its first two sentences
// (400 chars, string code), the full split texts were saved and never
// reopened, and the bible writer reconstructed famous books from model
// memory. The pack replaces rumor with a reading: per-chapter idea
// cards (idea, mechanism, the author's example, the payoff), the
// author's labels, the real terms, and world notes, persisted at
// books/{slug}/source-pack.json and reused by cast, ladder, inventory,
// and (phase 2) planning.

import { callModel } from "./models";
import { emitEvent } from "./events";

export interface SourcePackChapter {
  chapter: string; // "S1"
  sourceTitle: string;
  idea: string;
  mechanism: string;
  example: string;
  payoff: string;
  labels: string[];
  terms: string[];
  worldNotes: string[];
}

export interface SourcePack {
  chapters: SourcePackChapter[];
  labels: string[]; // author's coined labels / framework names, lowercased
  keyTerms: string[]; // the subject's real vocabulary
  worldNotes: string[];
  throughLine: string; // what the whole book adds up to
  sourceKindHint: "technical" | "ideas" | "";
  readerModel: string;
}

const CHAPTER_CHAR_CAP = 24_000;

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

function lcList(xs: any): string[] {
  if (!Array.isArray(xs)) return [];
  const out: string[] = [];
  for (const x of xs) {
    const s = String(x ?? "").trim().toLowerCase();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function chapterPrompt(
  bookTitle: string,
  subject: string,
  chTitle: string,
  body: string,
  running: string
): string {
  return `You are the reader for a children's-book adaptation. Read this chapter of the grown-up source book "${bookTitle}" (${subject}) and take production notes. Reply with ONLY a JSON object, no other text.

${running ? `The book so far, in one line: ${running}\n` : ""}
CHAPTER TITLE: ${chTitle}
CHAPTER TEXT:
${body.slice(0, CHAPTER_CHAR_CAP)}${body.length > CHAPTER_CHAR_CAP ? "\n[chapter truncated for the reading pass]" : ""}

Return exactly this JSON shape:
{
  "idea": "the one idea this chapter teaches, in plain words",
  "mechanism": "HOW the idea works, according to the author: the steps, the cause and effect",
  "example": "the example, story, or case the author uses to prove it, in two sentences at most",
  "payoff": "how the chapter lands: the result or moment everything in the chapter was building toward",
  "labels": ["any term or name the author coined or popularized for an idea in this chapter"],
  "terms": ["the subject's real vocabulary used in this chapter"],
  "worldNotes": ["concrete settings, objects, jobs, or situations in this chapter that a story could borrow"]
}
No em dashes.`;
}

export async function readSource(
  env: any,
  slug: string,
  bookInfo: any,
  splits: { title: string; body: string }[]
): Promise<SourcePack> {
  const key = `books/${slug}/source-pack.json`;
  const existing = await r2GetJson(env.BOOKS, key);
  if (existing?.chapters?.length) {
    console.log(`read: reusing source pack for ${slug} (${existing.chapters.length} chapters)`);
    return existing as SourcePack;
  }
  const title = String(bookInfo?.title ?? slug);
  const subject = String(bookInfo?.subject ?? "");
  const chapters: SourcePackChapter[] = [];
  let running = "";
  let readerModel = "";
  for (let i = 0; i < splits.length; i++) {
    const s = splits[i];
    const { data, model } = await callModel(
      env,
      chapterPrompt(title, subject, s.title, s.body, running),
      2048,
      "writer",
      { slug, purpose: "read-chapter" }
    );
    readerModel = model;
    if (!data?.idea) throw new Error(`reader produced no idea card for chapter ${i + 1} (${s.title})`);
    const card: SourcePackChapter = {
      chapter: `S${i + 1}`,
      sourceTitle: s.title,
      idea: String(data.idea ?? ""),
      mechanism: String(data.mechanism ?? ""),
      example: String(data.example ?? ""),
      payoff: String(data.payoff ?? ""),
      labels: lcList(data.labels),
      terms: lcList(data.terms),
      worldNotes: Array.isArray(data.worldNotes) ? data.worldNotes.map((x: any) => String(x)) : [],
    };
    chapters.push(card);
    running = card.idea;
  }
  // One synthesis call over the cards (small input): the through-line
  // and the technical/ideas classification the cast stage starts from.
  const cardsText = chapters
    .map((c) => `${c.chapter} "${c.sourceTitle}": ${c.idea} (${c.mechanism})`)
    .join("\n");
  const { data: syn } = await callModel(
    env,
    `You read a grown-up book, "${title}", chapter by chapter. Your notes:\n${cardsText}\n\nReply with ONLY JSON: {"throughLine": "what the whole book adds up to, one or two plain sentences", "sourceKindHint": "technical" if the book teaches a real tool or system whose own names are the curriculum (a manual, a software book, a how-to), otherwise "ideas"}. No em dashes.`,
    512,
    "writer",
    { slug, purpose: "read-synthesis" }
  );
  const pack: SourcePack = {
    chapters,
    labels: lcList(chapters.flatMap((c) => c.labels)),
    keyTerms: lcList(chapters.flatMap((c) => c.terms)),
    worldNotes: chapters.flatMap((c) => c.worldNotes),
    throughLine: String(syn?.throughLine ?? chapters[chapters.length - 1]?.idea ?? ""),
    sourceKindHint: syn?.sourceKindHint === "technical" ? "technical" : syn?.sourceKindHint === "ideas" ? "ideas" : "",
    readerModel,
  };
  await r2PutJson(env.BOOKS, key, pack);
  await emitEvent(env, {
    slug,
    kind: "reader",
    stage: "read",
    event: "source_pack_written",
    detail: `${chapters.length} chapters read by ${readerModel}; ${pack.labels.length} labels, ${pack.keyTerms.length} terms`,
  }).catch(() => {});
  console.log(`read: source pack for ${slug}: ${chapters.length} chapters, model ${readerModel}`);
  return pack;
}
