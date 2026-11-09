import { test, expect } from 'bun:test';
import { sha256Hex } from '../packages/core/src/sha256';
import { revisionHash } from '../packages/core/src/book-revision';
import { freezeArtifactRelease, openReleaseArtifact } from '../src/lib/artifact-releases';

function fixture() {
  const data = new Map<string, { bytes: Uint8Array; etag: string; metadata?: any }>(); let serial = 0;
  const put = (key: string, value: string | Uint8Array, metadata?: any) => data.set(key, { bytes: typeof value === 'string' ? new TextEncoder().encode(value) : value, etag: String(++serial), metadata });
  put('books/test/picture-book.pdf', 'APPROVED');
  const bucket: any = {
    async get(key: string, opts?: any) { const v = data.get(key); if (!v) return null; if (opts?.onlyIf?.etagMatches && opts.onlyIf.etagMatches !== v.etag) return { etag: v.etag };
      return { etag: v.etag, size: v.bytes.length, customMetadata: v.metadata, httpMetadata: { contentType: 'application/pdf' }, arrayBuffer: async () => v.bytes.slice().buffer,
        body: new ReadableStream({ start(c) { c.enqueue(v.bytes.slice()); c.close(); } }) }; },
    async head(key: string) { const v = data.get(key); return v ? { etag: v.etag, size: v.bytes.length } : null; },
    async put(key: string, body: any, opts: any) {
      if (opts?.onlyIf?.etagDoesNotMatch === '*' && data.has(key)) return null;
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
      put(key, bytes, opts?.customMetadata); return { etag: data.get(key)!.etag };
    },
  };
  const payload = { schema: 'book-revision/v1' as const, slug: 'test', pages: [], artifacts: [{ key: 'books/test/picture-book.pdf', role: 'picture_book_key', bytes: 8, sha256: sha256Hex(new TextEncoder().encode('APPROVED')) }] };
  const manifest = { ...payload, revision: revisionHash(payload) };
  return { data, put, bucket, manifest };
}

test('frozen release bytes survive a later live-key edit; original manifest stays exact', async () => {
  const f = fixture(); const release = await freezeArtifactRelease(f.bucket, f.manifest, 'release-one');
  f.put('books/test/picture-book.pdf', 'CHANGED!');
  const entry = release.manifest.artifacts[0]; const obj = await openReleaseArtifact(f.bucket, entry);
  expect(new TextDecoder().decode(await obj.arrayBuffer())).toBe('APPROVED');
  expect(release.manifest.sourceManifest).toEqual(f.manifest);
  expect(entry.sha256).toBe(f.manifest.artifacts[0].sha256);
});

test('changed source bytes, including equal-size edits, prevent freezing an approved revision', async () => {
  const f = fixture(); f.put('books/test/picture-book.pdf', 'CHANGED!');
  await expect(freezeArtifactRelease(f.bucket, f.manifest, 'release-one')).rejects.toThrow();
  expect(f.data.has('books/test/releases/release-one/intent.json')).toBe(true);
  expect(f.data.has('books/test/releases/release-one/freeze-failed.json')).toBe(true);
});

test('create-only release keys cannot be overwritten and failed candidates remain retained', async () => {
  const f = fixture(); await freezeArtifactRelease(f.bucket, f.manifest, 'release-one'); const count = f.data.size;
  await expect(freezeArtifactRelease(f.bucket, f.manifest, 'release-one')).rejects.toThrow();
  expect(f.data.size).toBe(count);
});

test('changed or missing frozen object fails closed without reading the live fallback', async () => {
  const f = fixture(); const r = await freezeArtifactRelease(f.bucket, f.manifest, 'release-one'); const entry = r.manifest.artifacts[0];
  f.put(entry.key, 'TAMPERED');
  await expect(openReleaseArtifact(f.bucket, entry)).rejects.toThrow();
  f.data.delete(entry.key);
  await expect(openReleaseArtifact(f.bucket, entry)).rejects.toThrow();
});

test('manifest hash and append-only database constraints protect historical releases', async () => {
  const { Database } = await import('bun:sqlite');
  const { installReleaseSchema } = await import('./helpers/release-fixture');
  const { readArtifactRelease } = await import('../src/lib/artifact-releases');
  const f = fixture(); const r = await freezeArtifactRelease(f.bucket,f.manifest,'release-one');
  const raw = new Database(':memory:'); installReleaseSchema(raw);
  raw.query('INSERT INTO publish_releases (id,book_slug,revision,manifest_json,checks_json,created_at) VALUES (?,?,?,?,?,?)').run('release-one','test',f.manifest.revision,JSON.stringify(f.manifest),'{}',0);
  raw.query('INSERT INTO artifact_releases VALUES (?,?,?,?,?,?,?)').run('release-one','test',f.manifest.revision,r.manifestKey,r.manifestSha256,r.manifestEtag,0);
  raw.query('INSERT INTO artifact_release_heads VALUES (?,?)').run('test','release-one');
  const db: any = { prepare(sql: string) { return { bind(...v: any[]) { return { first: async () => raw.query(sql).get(...v) }; } }; } };
  expect((await readArtifactRelease(db,f.bucket,'test')).id).toBe('release-one');
  expect(()=>raw.exec('DELETE FROM artifact_releases')).toThrow('append-only');
  expect(()=>raw.exec("UPDATE artifact_releases SET revision='other'")).toThrow('append-only');
  // Even an unchanged etag cannot mask corrupted manifest bytes.
  f.data.get(r.manifestKey)!.bytes = new TextEncoder().encode('{}');
  await expect(readArtifactRelease(db,f.bucket,'test')).rejects.toThrow('hash mismatch');
});
