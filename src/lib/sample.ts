// Free-sample page selection for the storefront book viewer.
//
// A sample is the book's first 5 DEFECT-FREE pages, in reading order
// (chapter by chapter; a chapter's finale page comes after its numbered
// pages). Pages on the factory fix list (src/lib/fix-pages.ts) are
// skipped and the walk continues into the next chapter until 5 clean
// pages are gathered. A page is served as its color version when a
// color twin exists, is not itself defect-listed, and is at least as
// new as the line page (the factory's colorize stale-twin rule);
// otherwise the line page is used. The public sample route resolves
// pages through this list only, so no other page of the book can be
// reached through it.

import { FIX_LINE_PAGES, FIX_COLOR_PAGES } from "./fix-pages";

export interface SamplePage {
  /** Factory notation, e.g. "S1p0" or "S1 finale". */
  label: string;
  kind: "line" | "color";
  /** R2 key inside the BOOKS bucket. */
  key: string;
}

export const SAMPLE_SIZE = 5;

interface R2Entry {
  key: string;
  uploaded: number;
}

async function listAll(e: any, prefix: string): Promise<R2Entry[]> {
  const out: R2Entry[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await e.BOOKS.list({ prefix, cursor, limit: 1000 });
    for (const o of res.objects || []) {
      out.push({ key: o.key, uploaded: o.uploaded ? new Date(o.uploaded).getTime() : 0 });
    }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return out;
}

const PAGE_RE = /^S(\d+)-(page-(\d+)|finale)\.jpg$/;

function parsePageFile(file: string): { chapter: number; page: number; label: string } | null {
  const m = PAGE_RE.exec(file);
  if (!m) return null;
  const chapter = Number(m[1]);
  if (m[3] !== undefined) {
    const page = Number(m[3]);
    return { chapter, page, label: `S${chapter}p${page}` };
  }
  // Finale sorts after every numbered page of its chapter.
  return { chapter, page: Number.MAX_SAFE_INTEGER, label: `S${chapter} finale` };
}

export async function getSamplePages(e: any, slug: string): Promise<SamplePage[]> {
  if (!/^[a-z0-9-]+$/.test(slug)) return [];
  const [lineObjs, colorObjs] = await Promise.all([
    listAll(e, `books/${slug}/images/`),
    listAll(e, `books/${slug}/images-color/`),
  ]);

  const colorByFile = new Map<string, R2Entry>();
  for (const o of colorObjs) {
    colorByFile.set(o.key.slice(o.key.lastIndexOf("/") + 1), o);
  }

  const linePages: { file: string; entry: R2Entry; parsed: NonNullable<ReturnType<typeof parsePageFile>> }[] = [];
  for (const o of lineObjs) {
    const file = o.key.slice(o.key.lastIndexOf("/") + 1);
    const parsed = parsePageFile(file);
    if (parsed) linePages.push({ file, entry: o, parsed });
  }
  linePages.sort((a, b) => a.parsed.chapter - b.parsed.chapter || a.parsed.page - b.parsed.page);

  const fixLine = new Set(FIX_LINE_PAGES[slug] || []);
  const fixColor = new Set(FIX_COLOR_PAGES[slug] || []);

  const sample: SamplePage[] = [];
  for (const lp of linePages) {
    if (sample.length >= SAMPLE_SIZE) break;
    const { label } = lp.parsed;
    if (fixLine.has(label)) continue;
    const color = colorByFile.get(lp.file);
    if (color && !fixColor.has(label) && color.uploaded >= lp.entry.uploaded) {
      sample.push({ label, kind: "color", key: color.key });
    } else {
      sample.push({ label, kind: "line", key: lp.entry.key });
    }
  }
  return sample;
}
