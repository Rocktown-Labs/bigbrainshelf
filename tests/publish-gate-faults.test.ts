import { test, expect } from 'bun:test';
import { listBookPages } from '../src/lib/book-plans';
import { audioGateDecision } from '../src/lib/publish-readiness';

test('a failed plan read cannot become an empty approved book', async () => {
  const books = { get: async () => { throw new Error('storage unavailable'); } };
  await expect(listBookPages(books, 'test')).rejects.toThrow();
});

test('unknown audio readiness blocks unless explicitly overridden', () => {
  expect(audioGateDecision(null, false)).toEqual({ block: true, recordOverride: false });
  expect(audioGateDecision(null, true)).toEqual({ block: false, recordOverride: true });
});
