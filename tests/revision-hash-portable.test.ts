import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { createSha256, digestHex, sha256Hex } from '../packages/core/src/sha256';
import { revisionHash } from '../packages/core/src/book-revision';

test('portable hashing preserves SHA-256 identities and incremental hashing without Node in the factory', () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  expect(sha256Hex(encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const reference = createHash('sha256'); const portable = createSha256();
  for (let i = 0; i < 200; i++) { const part = encode(`chunk ${i}\n`); reference.update(part); portable.update(part); }
  expect(digestHex(portable.digest())).toBe(reference.digest('hex'));
  expect(revisionHash({ b: 2, a: 1 })).toBe(createHash('sha256').update('{"a":1,"b":2}').digest('hex'));
});
