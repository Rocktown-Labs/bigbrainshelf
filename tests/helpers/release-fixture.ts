import { readFileSync } from 'node:fs';
import { revisionHash } from '../../packages/core/src/book-revision';
import { sha256Hex } from '../../packages/core/src/sha256';
import { freezeArtifactRelease } from '../../src/lib/artifact-releases';
import { seedPrintables } from '../../src/lib/print-fulfillment';

export function releaseBucket(objects = new Map<string, Uint8Array>()) {
  const version = (b: Uint8Array) => sha256Hex(b);
  return {
    async get(key: string, options?: any) {
      const bytes = objects.get(key); if (!bytes) return null;
      const etag = version(bytes);
      if (options?.onlyIf?.etagMatches && options.onlyIf.etagMatches !== etag) return { etag };
      return { etag, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer,
        body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice()); c.close(); } }) };
    },
    async head(key: string) { const bytes = objects.get(key); return bytes ? { etag: version(bytes), size: bytes.length } : null; },
    async put(key: string, value: any, options?: any) {
      if (options?.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null;
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, bytes); return { etag: version(bytes) };
    },
  };
}

export function installReleaseSchema(raw: any) {
  raw.exec(readFileSync(new URL('../../db/migrations/0001_release_and_run_provenance.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('../../db/migrations/0005_immutable_artifact_releases.sql', import.meta.url), 'utf8'));
}

/** Fixture-only promotion of real PDF stock masters. No approvals are fabricated in production. */
export async function seedPrintReleases(raw: any, db: any, books: any, objects: Map<string, Uint8Array>) {
  installReleaseSchema(raw);
  await seedPrintables(db);
  for (const { slug } of raw.query('SELECT DISTINCT slug FROM printables').all() as any[]) {
    const printables = (raw.query('SELECT * FROM printables WHERE slug = ? ORDER BY kind').all(slug) as any[]).map(r => ({ kind: r.kind,
      podPackageId: r.pod_package_id, interiorPages: r.interior_pages, interiorKey: r.interior_key, coverKey: r.cover_key, validationStatus: r.validation_status }));
    const artifacts = printables.flatMap(p => [ ['interior', p.interiorKey], ['cover', p.coverKey] ].map(([part, key]) => {
      if (!objects.has(key)) objects.set(key, new TextEncoder().encode('fixture stock'));
      const bytes = objects.get(key)!;
      return { key, role: `print:${p.kind}:${part}`, bytes: bytes.length, sha256: sha256Hex(bytes) };
    }));
    const payload = { schema: 'book-revision/v1' as const, slug, pages: [], artifacts, printables };
    const source = { ...payload, revision: revisionHash(payload) };
    const id = `fixture-${slug}`;
    const r = await freezeArtifactRelease(books, source, id);
    raw.query('INSERT INTO publish_releases (id,book_slug,revision,manifest_json,checks_json,created_at) VALUES (?,?,?,?,?,?)').run(id,slug,source.revision,JSON.stringify(source),'{}',0);
    raw.query('INSERT INTO artifact_releases (id,book_slug,revision,manifest_key,manifest_sha256,manifest_etag,created_at) VALUES (?,?,?,?,?,?,?)').run(id,slug,source.revision,r.manifestKey,r.manifestSha256,r.manifestEtag,0);
    raw.query('INSERT INTO artifact_release_heads (book_slug,release_id) VALUES (?,?)').run(slug,id);
  }
}
