import { test, expect, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { countBookPages, countApprovedPages, getBookQcState } from '../src/lib/book-plans';

const books = { get: async () => { throw new Error('object store unavailable'); } };
const db = { batch: async () => { throw new Error('must not write'); } };
const bindings: any = { BOOKS: books, DB: db };
mock.module('cloudflare:workers', () => ({ env: bindings }));

function availableBooks() {
  const data: Record<string, unknown> = {
    'books/test/bible.json': { conceptLadder: [{}] },
    'books/test/plans/S1.json': { pages: [{ storyText: 'Story' }], finale: { storyText: 'Finale' } },
  };
  return {
    async get(key: string) { return data[key] ? { arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(data[key])).buffer } : null; },
    async list() { return { objects: [{ key: 'books/test/plans/S1.json' }], truncated: false }; },
  };
}

test('readiness inventory failure renders Unverified instead of zero counts', async () => {
  const source = readFileSync(new URL('../src/pages/admin/books/[slug]/readiness.astro', import.meta.url), 'utf8');
  const fragment = source.slice(source.indexOf('// QC state:'), source.indexOf('// Colorize state:'));
  // Exercise the actual frontmatter decision without a worker or authenticated server.
  const evaluate = new (Object.getPrototypeOf(async function() {}).constructor)(
    'env', 'book', 'slug', 'countBookPages', 'countApprovedPages', 'getBookQcState',
    `${fragment.replace(/\s+as any/g, '')}; return typeof qcState !== 'undefined' ? qcState : { label: String(approvedCount) + ' of ' + String(totalPages), totalPages };`
  );
  const helper = await import('../src/lib/book-plans');
  const result = await evaluate({ BOOKS: books, DB: db }, {}, 'test', countBookPages, countApprovedPages, helper.getBookQcState);
  expect(result.label).toContain('Unverified');
  expect(result.totalPages).toBeNull();
});

test('bulk approval reports unavailable inventory plainly and writes nothing', async () => {
  const { POST } = await import('../src/pages/api/editor/approvals-bulk');
  const response = await POST({ request: new Request('https://example.test/api/editor/approvals-bulk', {
    method: 'POST', body: JSON.stringify({ book_slug: 'test' }),
  }) } as any);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ ok: false, code: 'INVENTORY_UNVERIFIED' });
});

test('unknown approval counts remain Unverified even with a complete inventory', async () => {
  const result = await getBookQcState({ prepare() { throw new Error('database unavailable'); } }, availableBooks(), 'test');
  expect(result).toMatchObject({ totalPages: 2, approvedCount: null, complete: false });
  expect(result.label).toContain('Unverified');
});

test('known counts include the finale and unlock only when every page is approved', async () => {
  const result = await getBookQcState({ prepare() { return { bind() { return { async all() {
    return { results: [{ chapter_num: 1, page_index: 0 }, { chapter_num: 1, page_index: 1 }] };
  } }; } }; } }, availableBooks(), 'test');
  expect(result).toMatchObject({ totalPages: 2, approvedCount: 2, complete: true, label: '2 of 2 pages approved.' });
});

test('a failed approval save returns a useful response without claiming success', async () => {
  bindings.BOOKS = availableBooks();
  try {
    const { POST } = await import('../src/pages/api/editor/approvals-bulk');
    const response = await POST({ request: new Request('https://example.test/api/editor/approvals-bulk', {
      method: 'POST', body: JSON.stringify({ book_slug: 'test' }),
    }) } as any);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'APPROVAL_SAVE_UNCONFIRMED', ok: false });
  } finally { bindings.BOOKS = books; }
});
