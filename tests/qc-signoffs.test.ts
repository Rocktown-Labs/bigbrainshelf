// QC sign-off tests: the two book-level attestations (full story,
// then full color) bind to the exact book revision, orphan when the
// revision changes, and report explicit states. The color sign-off
// is unavailable until every page carries a color twin, and (CG,
// 2026-11-11) the twins must be current against their line pages;
// a color sign-off voided by a later change of revision surfaces
// as voided, never as a bare outstanding.
import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { assessColorEdition, colorEditionComplete, getSignoffStates, recordSignoff, signoffBlockers, type ColorEditionAssessment } from '../src/lib/qc-signoffs';
import { pageDerivativeKey, PAGE_DERIVATIVE_WIDTHS } from '../src/lib/media';

const COMPLETE: ColorEditionAssessment = { state: 'complete' };
const INCOMPLETE: ColorEditionAssessment = { state: 'incomplete', missingTwins: 3 };
const STALE: ColorEditionAssessment = { state: 'stale', stalePages: ['S1:0'] };

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
  let states = await getSignoffStates(db, 'test', 'rev1', COMPLETE);
  expect(states.story.state).toBe('outstanding');
  expect(states.color.state).toBe('outstanding');
  await recordSignoff(db, 'test', 'story', 'rev1', 'cg');
  states = await getSignoffStates(db, 'test', 'rev1', COMPLETE);
  expect(states.story.state).toBe('done');
  expect(states.story.actor).toBe('cg');
  expect(states.color.state).toBe('outstanding');
  const orphaned = await getSignoffStates(db, 'test', 'rev2', COMPLETE);
  expect(orphaned.story.state).toBe('outstanding');
});

test('color is unavailable while the color edition is incomplete', async () => {
  const { db } = makeDb();
  const states = await getSignoffStates(db, 'test', 'rev1', INCOMPLETE);
  expect(states.color.state).toBe('unavailable');
  expect(states.color.unavailableReason).toBe('incomplete');
  expect(states.story.state).toBe('outstanding');
  const blockers = signoffBlockers(states);
  expect(blockers.map(b => b.id)).toEqual(['signoff:story', 'signoff:color']);
  expect(blockers[1].detail).toMatch(/not yet available/);
  expect(blockers[1].detail).toMatch(/incomplete/);
});

test('color is unavailable as out of date while a twin is stale', async () => {
  const { db } = makeDb();
  const states = await getSignoffStates(db, 'test', 'rev1', STALE);
  expect(states.color.state).toBe('unavailable');
  expect(states.color.unavailableReason).toBe('stale');
  const blockers = signoffBlockers(states);
  const colorBlocker = blockers.find(b => b.id === 'signoff:color');
  expect(colorBlocker?.detail).toMatch(/out of date/);
  expect(colorBlocker?.detail).toMatch(/Re-run colorize/);
});

test('a color sign-off on an older revision reads voided, with its attestation', async () => {
  const { db } = makeDb();
  await recordSignoff(db, 'test', 'color', 'rev1', 'cg');
  const signed = await getSignoffStates(db, 'test', 'rev1', COMPLETE);
  expect(signed.color.state).toBe('done');
  const voided = await getSignoffStates(db, 'test', 'rev2', COMPLETE);
  expect(voided.color.state).toBe('voided');
  expect(voided.color.actor).toBe('cg');
  expect(voided.color.at).toBeTruthy();
  const blockers = signoffBlockers(voided);
  const colorBlocker = blockers.find(b => b.id === 'signoff:color');
  expect(colorBlocker?.detail).toMatch(/voided/);
  expect(colorBlocker?.detail).toMatch(/sign off again/);
  // Re-signing the new revision restores done.
  await recordSignoff(db, 'test', 'color', 'rev2', 'cg');
  const restored = await getSignoffStates(db, 'test', 'rev2', COMPLETE);
  expect(restored.color.state).toBe('done');
});

test('sign-offs are append-only', async () => {
  const { raw, db } = makeDb();
  await recordSignoff(db, 'test', 'story', 'rev1', 'cg');
  expect(() => raw.exec('DELETE FROM book_qc_signoffs')).toThrow();
  expect(() => raw.exec("UPDATE book_qc_signoffs SET actor = 'x'")).toThrow();
});

test('colorEditionComplete requires a current twin on every page', () => {
  const T0 = '2026-11-01T00:00:00.000Z';
  const T1 = '2026-11-02T00:00:00.000Z';
  const manifest = (pairs: [string, string | null][], uploaded?: Record<string, string>) => ({
    pages: pairs.map(([lineKey, colorKey], i) => ({ id: `S1:${i}`, lineKey, colorKey })),
    ...(uploaded ? { uploaded } : {}),
  }) as any;
  // Twins uploaded after their line pages: complete and current.
  expect(colorEditionComplete(manifest(
    [['l1', 'c1'], ['l2', 'c2']],
    { l1: T0, c1: T1, l2: T0, c2: T1 }
  ))).toBe(true);
  // A twin older than its line page (line redrawn, never recolored):
  // the edition is stale, not complete.
  const stale = manifest([['l1', 'c1']], { l1: T1, c1: T0 });
  expect(colorEditionComplete(stale)).toBe(false);
  expect(assessColorEdition(stale)).toEqual({ state: 'stale', stalePages: ['S1:0'] });
  // A page without a twin: incomplete.
  const partial = manifest([['l1', 'c1'], ['l2', null]], { l1: T0, c1: T1 });
  expect(colorEditionComplete(partial)).toBe(false);
  expect(assessColorEdition(partial)).toEqual({ state: 'incomplete', missingTwins: 1 });
  // No uploaded evidence: currency is unknown, never a pass.
  expect(assessColorEdition(manifest([['l1', 'c1']]))).toEqual({ state: 'unknown' });
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
