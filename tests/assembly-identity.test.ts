import { normalizeBible } from '../packages/core/src/bible-normalization';
import { test, expect } from 'bun:test';
import { prepareAssembly, loadAssemblyPage, assertAssemblyCurrent, stampLine, stampColor, holdColor } from '../packages/core/src/assembly-identity';

import { fixture } from './helpers/identity-fixture';

test('exact inventory includes each finale once for both base and color assembly', async () => {
  const f = fixture();
  for (const kind of ['line', 'color'] as const) {
    const s = await prepareAssembly(f.bucket, 'test', kind);
    expect(s.entries.map(e => e.ref.id)).toEqual(['S1:0', 'S1:finale']);
    expect(await loadAssemblyPage(f.bucket, s, s.entries[1])).toEqual(new TextEncoder().encode(kind === 'line' ? 'LINE' : 'COLOR'));
  }
});

test.each(['plan', 'image', 'finale', 'color', 'color-finale'])('missing %s blocks assembly', async kind => {
  const f = fixture();
  const key = { plan: 'plans/S1.json', image: 'images/S1-page-0.jpg', finale: 'images/S1-finale.jpg', color: 'images-color/S1-page-0.jpg', 'color-finale': 'images-color/S1-finale.jpg' }[kind]!;
  f.values.delete(`books/test/${key}`);
  await expect(prepareAssembly(f.bucket, 'test', kind.startsWith('color') ? 'color' : 'line')).rejects.toThrow();
});

test.each(['held', 'colorHeld', 'stale-line', 'stale-color', 'unverifiable-color', 'missing-finale-plan'])('%s blocks with an explicit reason', async kind => {
  const f = fixture();
  if (kind === 'held') f.plan.pages[0].held = true;
  if (kind === 'colorHeld') f.plan.finale.colorHeld = true;
  if (kind === 'stale-line') f.plan.pages[0].storyText = 'changed revision';
  if (kind === 'stale-color') f.put(f.plan.pages[0].imageColorKey, 'OTHER');
  if (kind === 'unverifiable-color') delete f.plan.pages[0].colorIdentity;
  if (kind === 'missing-finale-plan') delete f.plan.finale;
  f.save();
  await expect(prepareAssembly(f.bucket, 'test', 'color')).rejects.toThrow();
});

test('line changed after coloring invalidates its twin even if timestamps look current', async () => {
  const f = fixture(); f.put('books/test/images/S1-page-0.jpg', 'EDIT');
  stampLine(f.bible, f.plan, f.plan.pages[0], new TextEncoder().encode('EDIT')); f.save();
  await expect(prepareAssembly(f.bucket, 'test', 'color')).rejects.toThrow('color');
});

test('a changed source, added plan or image during PDF building prevents installation', async () => {
  for (const kind of ['image', 'source', 'extra-plan']) {
    const f = fixture(); const s = await prepareAssembly(f.bucket, 'test', 'line');
    if (kind === 'image') { f.put('books/test/images/S1-finale.jpg', 'EDIT'); await expect(loadAssemblyPage(f.bucket, s, s.entries[1])).rejects.toThrow(); }
    if (kind === 'source') { f.plan.pages[0].storyText = 'edit'; f.save(); }
    if (kind === 'extra-plan') f.put('books/test/plans/S2.json', f.plan);
    await expect(assertAssemblyCurrent(f.bucket, s)).rejects.toThrow();
  }
});

test('every unsuccessful color result holds the page and preserves prior identity evidence', () => {
  const f = fixture(); const prior = f.plan.pages[0].colorIdentity;
  holdColor(f.plan.pages[0], 'gateway unavailable');
  expect(f.plan.pages[0].colorHeld).toBe(true); expect(f.plan.pages[0].colorIdentity).toEqual(prior);
});


test('identity derives consistently from generated-shape and normalized bibles', async () => {
  const f = fixture();
  const rawBible = { bookTitle: 'Test', conceptLadder: [{ chapter: 1 }], protagonist: { name: 'Lead' }, metaphorBank: [{ storyChapter: 1, metaphor: 'bridge' }] };
  for (const [page, stem] of [[f.plan.pages[0], 'page-0'], [f.plan.finale, 'finale']] as const) {
    stampLine(normalizeBible(rawBible), f.plan, page, new TextEncoder().encode('LINE'));
  }
  f.put('books/test/bible.json', rawBible); f.put('books/test/plans/S1.json', f.plan);
  expect((await prepareAssembly(f.bucket, 'test', 'line')).entries).toHaveLength(2);
});
