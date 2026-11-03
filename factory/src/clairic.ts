// Clairic (@cf/cloudflare/clairic): System One extraction model on Workers
// AI. Single forward pass, typed answers with spans + confidence, cannot
// return malformed JSON or prose. Used for document-ingestion extraction
// (chapter headings, book title) where an LLM call is overkill and its
// failure modes (non-JSON, empty content) are pure downside.
//
// Everything here is best-effort: any error or low-confidence result returns
// null and callers fall back to the existing regex logic.

const CLAIRIC = "@cf/cloudflare/clairic";

export async function clairicExtract(
  AI: any,
  state: string,
  fields: Record<string, any>
): Promise<Record<string, any> | null> {
  try {
    const r: any = await AI.run(CLAIRIC, { state, fields });
    return r?.answers ?? null;
  } catch (e: any) {
    console.log(`clairic failed: ${e?.message ?? e}`);
    return null;
  }
}

// Extract chapter headings as merged spans. Clairic returns fine-grained
// spans ("Chapter 1:" and "Ports and Maps" separately), so spans that sit on
// the same line or within a few characters merge into one heading. Returns
// [{ title, offset }] in document order, deduped, or null.
export async function clairicHeadings(
  AI: any,
  text: string
): Promise<{ title: string; offset: number }[] | null> {
  const answers = await clairicExtract(AI, text, {
    chapter_titles: {
      type: "list",
      items: "text",
      instructions: "Chapter or major section headings, in the order they appear",
    },
    chapter_count: {
      type: "number",
      integer: true,
      instructions: "How many chapters or major sections are in this text",
    },
  });
  const list = answers?.chapter_titles;
  if (!list?.spans?.length) return null;
  const spans: { text: string; start: number; end: number }[] = list.spans
    .map((s: number[], i: number) => ({
      text: (list.value?.[i] ?? text.slice(s[0], s[1])).trim(),
      start: s[0],
      end: s[1],
    }))
    .filter((s: any) => s.text.length > 0)
    .sort((a: any, b: any) => a.start - b.start);
  if (!spans.length) return null;

  const merged: { title: string; offset: number; end: number }[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    const gap = last ? text.slice(last.end, s.start) : "";
    if (last && s.start - last.end <= 4 && !gap.includes("\n\n")) {
      last.title = `${last.title} ${s.text}`.replace(/\s+/g, " ").trim();
      last.end = s.end;
    } else {
      merged.push({ title: s.text, offset: s.start, end: s.end });
    }
  }
  // Drop duplicates (running heads repeat chapter titles in body text) and
  // anything that is not plausibly a heading.
  const seen = new Set<string>();
  const out: { title: string; offset: number }[] = [];
  for (const m of merged) {
    const key = m.title.toLowerCase();
    if (seen.has(key) || m.title.length < 3 || m.title.length > 120) continue;
    seen.add(key);
    out.push({ title: m.title, offset: m.offset });
  }
  return out.length ? out : null;
}

// Split a document on extracted headings. Each segment must carry real body
// text; returns null when the headings do not produce a sane split.
export function splitOnHeadings(
  text: string,
  headings: { title: string; offset: number }[]
): { title: string; body: string }[] | null {
  if (headings.length < 3) return null;
  const chunks: { title: string; body: string }[] = [];
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].offset;
    const end = i + 1 < headings.length ? headings[i + 1].offset : text.length;
    const body = text.slice(start, end).trim();
    if (body.length <= 500) return null;
    chunks.push({ title: headings[i].title, body });
  }
  return chunks;
}
