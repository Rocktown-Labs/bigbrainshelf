import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fixture, identityDatabase } from './helpers/identity-fixture';
import { stampLine, stampColor } from '../packages/core/src/assembly-identity';
import { captureApprovalRevision } from '../src/lib/approval-identity';

// Viewer speed fix (2026-11-09): CG's network tab showed the chapters
// call taking 2.55s and a wall of change-requests polls. Three moves:
// the identity fingerprint probe fans out wider, the chapters payload
// carries the change notes + book status, and the viewer drops its
// 25s polling interval for a refresh on return to the tab.

test('the fingerprint probe fans out past the old 12-wide pool', async () => {
  const f = fixture(); const { db, raw } = identityDatabase();
  raw.exec(readFileSync(new URL('../db/migrations/0004_revision_cache.sql', import.meta.url), 'utf8'));
  raw.exec('ALTER TABLE books ADD COLUMN picture_book_key TEXT;');
  raw.exec("UPDATE books SET picture_book_key = 'books/test/picture-book.pdf'");
  f.put('books/test/picture-book.pdf', 'PDF');
  // Grow the chapter to 20 pages so the probe has ~46 keys to HEAD:
  // at the old limit the peak could never pass 12.
  for (let i = 1; i < 20; i++) {
    const pg: any = { storyText: 'Story ' + i, imagePrompt: 'draw' };
    stampLine(f.bible, f.plan, pg, new TextEncoder().encode('LINE'));
    pg.imageColorKey = `books/test/images-color/S1-page-${i}.jpg`;
    stampColor(f.bible, f.plan, pg, new TextEncoder().encode('LINE'), new TextEncoder().encode('COLOR'));
    f.put(`books/test/images/S1-page-${i}.jpg`, 'LINE'); f.put(pg.imageColorKey, 'COLOR');
    f.plan.pages.push(pg);
  }
  f.save();
  let active = 0, peak = 0;
  const bucket = {
    ...f.bucket,
    async head(key: string) {
      active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 2));
      active--;
      return f.bucket.head(key);
    },
  };
  const snapshot = await captureApprovalRevision(db, bucket, 'test');
  expect(snapshot.manifest.slug).toBe('test');
  expect(peak).toBeGreaterThan(12);
  expect(peak).toBeLessThanOrEqual(32);
});

test('the chapters route carries change notes and book status in the review payload', () => {
  const src = readFileSync(new URL('../src/pages/api/editor/chapters.ts', import.meta.url), 'utf8');
  expect(src).toContain('changeRequests');
  expect(src).toContain('bookStatus');
  expect(src).toContain('FROM change_requests WHERE book_slug = ?');
  // Notes stay best-effort: the identity load must not depend on them.
  expect(src).toContain('notes degrade to empty');
});

test('the viewer seeds notes from the payload and never polls on an interval', () => {
  const src = readFileSync(new URL('../src/pages/admin/books/[slug].astro', import.meta.url), 'utf8');
  expect(src).toContain('data.changeRequests');
  expect(src).toContain('applyRequests(data.changeRequests)');
  expect(src).not.toContain('setInterval(loadRequests');
  expect(src).toContain('refreshRequestsOnReturn');
  // Startup no longer fetches the whole catalog to find one book.
  expect(src).not.toContain('Promise.all([\n      loadBook(),');
});
