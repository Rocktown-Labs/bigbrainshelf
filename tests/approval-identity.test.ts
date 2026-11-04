import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { fixture } from './helpers/identity-fixture';
import { captureApprovalRevision, saveApprovals, approvedPages } from '../src/lib/approval-identity';

function database() {
  const raw = new Database(':memory:');
  raw.exec('CREATE TABLE books (slug TEXT); INSERT INTO books VALUES (\'test\');');
  raw.exec(readFileSync(new URL('../db/migrations/0002_artifact_approvals.sql', import.meta.url), 'utf8'));
  const db: any = { prepare(sql: string) { let values: any[] = []; const s = { bind(...args: any[]) { values = args; return s; }, async first() { return raw.query(sql).get(...values); }, async all() { return { results: raw.query(sql).all(...values) }; }, run: async () => raw.query(sql).run(...values), execute: () => raw.query(sql).run(...values) }; return s; }, async batch(statements: any[]) { return raw.transaction(() => statements.map(s => s.execute()))(); } };
  return { raw, db };
}

test.each(['page', 'finale', 'cover', 'revision'])('changing approved %s invalidates the approval', async kind => {
  const f = fixture(); const { db } = database();
  f.put('books/test/cover.jpg', 'COVER');
  const snapshot = await captureApprovalRevision(db, f.bucket, 'test');
  await saveApprovals(db, f.bucket, snapshot, snapshot.manifest.pages, true);
  expect(await approvedPages(db, snapshot.manifest)).toHaveLength(2);
  if (kind === 'page') f.put('books/test/images/S1-page-0.jpg', 'EDIT');
  if (kind === 'finale') f.put('books/test/images/S1-finale.jpg', 'EDIT');
  if (kind === 'cover') f.put('books/test/cover.jpg', 'EDIT');
  if (kind === 'revision') { f.plan.pages[0].storyText = 'new'; f.save(); }
  const next = await captureApprovalRevision(db, f.bucket, 'test');
  expect(await approvedPages(db, next.manifest)).toHaveLength(0);
});

test('duplicate approvals cannot replace a finale; revocations append without deleting evidence', async () => {
  const f = fixture(); const { db, raw } = database(); const s = await captureApprovalRevision(db, f.bucket, 'test');
  await saveApprovals(db, f.bucket, s, [s.manifest.pages[0]], true);
  await saveApprovals(db, f.bucket, s, [s.manifest.pages[0]], true);
  expect(await approvedPages(db, s.manifest)).toHaveLength(1);
  await saveApprovals(db, f.bucket, s, [s.manifest.pages[0]], false);
  expect(await approvedPages(db, s.manifest)).toHaveLength(0);
  expect(raw.query('SELECT * FROM artifact_approvals').all()).toHaveLength(3);
});

test('a change between review snapshot and approval save writes no approvals', async () => {
  const f = fixture(); const { db, raw } = database(); const s = await captureApprovalRevision(db, f.bucket, 'test');
  f.put('books/test/images/S1-finale.jpg', 'EDIT');
  await expect(saveApprovals(db, f.bucket, s, s.manifest.pages, true)).rejects.toThrow();
  expect(raw.query('SELECT * FROM artifact_approvals').all()).toHaveLength(0);
});


test('migration enforces append-only approval evidence and is safe to apply twice', async () => {
  const f = fixture(); const { db, raw } = database(); const s = await captureApprovalRevision(db, f.bucket, 'test');
  await saveApprovals(db, f.bucket, s, [s.manifest.pages[0]], true);
  raw.exec(readFileSync(new URL('../db/migrations/0002_artifact_approvals.sql', import.meta.url), 'utf8'));
  expect(() => raw.exec('DELETE FROM artifact_approvals')).toThrow('append-only');
  expect(() => raw.exec('UPDATE artifact_approvals SET approved = 0')).toThrow('append-only');
  expect(raw.query('SELECT * FROM artifact_approvals').all()).toHaveLength(1);
});
