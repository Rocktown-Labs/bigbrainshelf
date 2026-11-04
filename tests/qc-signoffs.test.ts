// QC sign-off tests: the two book-level attestations (full story,
// then full color) bind to the exact book revision, orphan when the
// revision changes, and report explicit states. The color sign-off
// is unavailable until every page carries a color twin.
import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { colorEditionComplete, getSignoffStates, recordSignoff, signoffBlockers } from '../src/lib/qc-signoffs';
import { pageDerivativeKey, PAGE_DERIVATIVE_WIDTHS } from '../src/lib/media';

function makeDb() {
  const raw = new Database(':memory:');
  raw.exec(readFileSync(new URL('../db/migrations/0003_qc_signoffs.sql', import.meta.url), 'utf8'));
  const db: any = {
    prepare(sql: string) {
      let values: any[] = [];
      const statement = { bind(...v: any[]) { values = v; return statement; },
        async first() { return raw.query(sql).get(...values); },
        async all() { return { results: raw.query(sql).all(...values) }; },
        async run() { return raw.query(sql).run(...values); } };
      return statement;
    },
  };
  return { raw, db };
}

const SHA = 'a'.repeat(64);

test('states start outstanding, record to done, and orphan on revision change', async () => {
  const { db } = makeDb();
  let states = await getSignoffStates(db, 'test', 'rev1', true);
  expect(states.story.state).toBe('outstanding');
  expect(states.color.state).toBe('outstanding');
  await recordSignoff(db, 'test', 'story', 'rev1', 'cg');
  states = await getSignoffStates(db, 'test', 'rev1', true);
  expect(states.story.state).toBe('done');
  expect(states.story.actor).toBe('cg');
  expect(states.color.state).toBe('outstanding');
  const orphaned = await getSignoffStates(db, 'test', 'rev2', true);
  expect(orphaned.story.state).toBe('outstanding');
});

test('color is unavailable while the color edition is incomplete', async () => {
  const { db } = makeDb();
  const states = await getSignoffStates(db, 'test', 'rev1', false);
  expect(states.color.state).toBe('unavailable');
  expect(states.story.state).toBe('outstanding');
  const blockers = signoffBlockers(states);
  expect(blockers.map(b => b.id)).toEqual(['signoff:story', 'signoff:color']);
  expect(blockers[1].detail).toMatch(/not yet available/);
});

test('sign-offs are append-only', async () => {
  const { raw, db } = makeDb();
  await recordSignoff(db, 'test', 'story', 'rev1', 'cg');
  expect(() => raw.exec('DELETE FROM book_qc_signoffs')).toThrow();
  expect(() => raw.exec("UPDATE book_qc_signoffs SET actor = 'x'")).toThrow();
});

test('colorEditionComplete requires a twin on every page', () => {
  const page = (colorKey: string | null) => ({ colorKey } as any);
  expect(colorEditionComplete({ pages: [page('a'), page('b')] } as any)).toBe(true);
  expect(colorEditionComplete({ pages: [page('a'), page(null)] } as any)).toBe(false);
  expect(colorEditionComplete({ pages: [] } as any)).toBe(false);
});

test('page derivative keys are content-addressed and predicate-safe', () => {
  expect(pageDerivativeKey('books/docker/images/S1-page-0.jpg', SHA, 960)).toBe(`books/docker/derivatives/${SHA}-w960.webp`);
  expect(pageDerivativeKey('books/docker/images-color/S2-finale.jpg', SHA, 200)).toBe(`books/docker/derivatives/${SHA}-w200.webp`);
  expect(pageDerivativeKey('books/docker/images/S1-page-0.jpg', SHA, 123)).toBeNull();
  expect(pageDerivativeKey('books/docker/images/S1-page-0.jpg', 'not-a-hash', 960)).toBeNull();
  expect(pageDerivativeKey('cast-gallery/x.png', SHA, 960)).toBeNull();
  expect(PAGE_DERIVATIVE_WIDTHS).toEqual([200, 480, 960]);
});
