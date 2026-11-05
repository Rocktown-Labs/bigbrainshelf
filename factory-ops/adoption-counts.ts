import { PDFDocument } from 'pdf-lib';
import { expectedBookPageCount } from '../factory/src/pdf';
import { bookVocabulary } from '../packages/core/src/book-vocabulary';

export function explainCountDelta(slug: string, kind: string, legacy: number, expected: number, finales: number) {
  if (legacy === expected) return { status: 'explained', defects: [] as string[] };
  if (kind === 'coloring' && legacy === expected - finales) return { status: 'explained', defects: ['omitted-coloring-finales'] };
  if (slug === 'docker' && kind === 'picture' && legacy === expected + 17) return { status: 'explained', defects: ['legacy-chapter-divider-pages:17'] };
  if (['mira-the-heron-and-the-still-water', 'mastery'].includes(slug)) {
    if (legacy === expected + 1) return { status: 'explained', defects: ['mira-legacy-extra-page:1'] };
    if (kind === 'coloring' && legacy === expected - finales + 1) return { status: 'explained', defects: ['omitted-coloring-finales', 'mira-legacy-extra-page:1'] };
  }
  return { status: 'blocked', defects: ['unexplained-page-count-delta'] };
}
export async function adoptionCounts(books: any, slug: string, bible: any, pages: any[], declared: any, colorEligible: number) {
  const chapters = new Set(pages.map(p => p.chapter)).size;
  const finales = pages.filter(p => p.kind === 'finale').length;
  let expected: number;
  let expectedByKind: Record<string, number>;
  try {
    const vocab = bookVocabulary(bible);
    expected = await expectedBookPageCount(pages.length, chapters, vocab, 'picture');
    expectedByKind = {
      picture: expected,
      coloring: await expectedBookPageCount(pages.length, chapters, vocab, 'coloring'),
      color: expected,
    };
  }
  catch { return { expected: null, inventoryPages: pages.length, finales, results: [{ kind: 'matter', legacy: null, expected: null, delta: null, status: 'blocked', defects: ['matter-count-could-not-be-derived'], colorEligible }], status: 'blocked' }; }
  const results = [];
  for (const [kind, file] of [['picture', 'picture-book.pdf'], ['coloring', 'coloring-book.pdf'], ['color', 'picture-book-color.pdf']]) {
    const expected = expectedByKind[kind];
    const object = await books.get(`books/${slug}/${file}`);
    if (!object) {
      results.push({ kind, legacy: null, expected, delta: null, status: 'not-available', defects: ['no-legacy-pdf'], colorEligible });
      continue;
    }
    try {
      const legacy = (await PDFDocument.load(await object.arrayBuffer())).getPageCount();
      const explanation = legacy === declared?.[kind] ? explainCountDelta(slug, kind, legacy, expected, finales) : { status: 'blocked', defects: ['live-pdf-count-differs-from-audit'] };
      if (kind === 'color' && colorEligible < pages.length) {
        explanation.status = 'blocked';
        explanation.defects.push(slug === 'compoundeffect' ? 'prior-edition-color-twins' : 'incomplete-current-color-twins');
      }
      results.push({ kind, legacy, expected, delta: expected - legacy, ...explanation, colorEligible });
    } catch { results.push({ kind, legacy: null, expected, delta: null, status: 'blocked', defects: ['unreadable-legacy-pdf'], colorEligible }); }
  }
  return { expected, inventoryPages: pages.length, finales, results,
    status: results.some(r => r.status === 'blocked') ? 'blocked' : results.every(r => r.status === 'not-available') ? 'not-available' : 'explained' };
}
