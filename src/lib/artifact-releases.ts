import { revisionHash, type BookRevision, type RevisionArtifact } from '../../packages/core/src/book-revision';
import { createSha256, digestHex, sha256Hex } from '../../packages/core/src/sha256';

export interface FrozenArtifact extends RevisionArtifact { sourceKey: string; etag: string }
export interface ArtifactRelease {
  schema: 'artifact-release/v1'; id: string; slug: string; createdAt: string;
  sourceManifest: BookRevision; artifacts: FrozenArtifact[];
}
export const artifactReleasePrefix = (slug: string, id: string) => `books/${slug}/releases/${id}/`;
const validId = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9-]{0,100}$/.test(value);

async function hashObject(obj: any) {
  const hash = createSha256(); let bytes = 0;
  if (!obj?.body) throw new Error('Release object body is unavailable');
  const reader = obj.body.getReader();
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; hash.update(chunk.value); } }
  finally { reader.releaseLock(); }
  return { bytes, sha256: digestHex(hash.digest()) };
}
async function createOnly(books: any, key: string, body: any, options: any = {}) {
  const result = await books.put(key, body, { ...options, onlyIf: { etagDoesNotMatch: '*' } });
  if (!result?.etag) throw new Error(`Release object already exists or write was not confirmed: ${key}`);
  return result;
}

/** Failure records add evidence; they never rewrite an earlier attempt. */
export async function recordReleaseFailure(books: any, slug: string, id: string, phase: 'freeze' | 'promotion', error: unknown) {
  try {
    await createOnly(books, `${artifactReleasePrefix(slug, id)}${phase}-failed.json`, JSON.stringify({
      schema: 'artifact-release-failure/v1', id, phase, recordedAt: new Date().toISOString(),
      error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
    }), { httpMetadata: { contentType: 'application/json' } });
  } catch { console.warn('Release failure evidence could not be written', id, phase); }
}

/** Append-only staging. Failures intentionally leave the intent and all candidates.
 * Nothing changes a delivery pointer until every copied byte has been verified. */
export async function freezeArtifactRelease(books: any, sourceManifest: BookRevision, id: string, actor: string | null = null) {
  // uploaded is currency evidence, never part of the hashed payload.
  const { revision, uploaded: _uploaded, ...source } = sourceManifest;
  if (!validId(id) || !validId(source.slug) || revisionHash(source) !== revision || !source.artifacts.length)
    throw new Error('Invalid source revision for release');
  const prefix = artifactReleasePrefix(source.slug, id);
  const createdAt = new Date().toISOString();
  await createOnly(books, `${prefix}intent.json`, JSON.stringify({ schema: 'artifact-release-intent/v1', id, createdAt, actor, sourceManifest }),
    { httpMetadata: { contentType: 'application/json' } });
  try {
    const artifacts: FrozenArtifact[] = [];
    for (const [index, artifact] of source.artifacts.entries()) {
      if (!artifact.key.startsWith(`books/${source.slug}/`) || artifact.key.includes('..') || artifact.bytes < 1 || !/^[a-f0-9]{64}$/.test(artifact.sha256))
        throw new Error(`Invalid release artifact: ${artifact.key}`);
      const obj = await books.get(artifact.key);
      if (!obj?.body) throw new Error(`Release source unavailable: ${artifact.key}`);
      const extension = artifact.key.match(/\.[a-z0-9]{1,8}$/i)?.[0] ?? '';
      const key = `${prefix}artifacts/${index}-${artifact.sha256}${extension}`;
      // R2 validates the expected SHA while ingesting, without buffering large masters.
      const written = await createOnly(books, key, obj.body, { sha256: artifact.sha256,
        httpMetadata: obj.httpMetadata, customMetadata: { sourceKey: artifact.key, sourceRevision: revision, sha256: artifact.sha256 } });
      const pinned = await books.get(key, { onlyIf: { etagMatches: written.etag } });
      const copied = await hashObject(pinned);
      if (copied.bytes !== artifact.bytes || copied.sha256 !== artifact.sha256) throw new Error(`Release byte verification failed: ${artifact.key}`);
      artifacts.push({ ...artifact, sourceKey: artifact.key, key, etag: written.etag });
    }
    const manifest: ArtifactRelease = { schema: 'artifact-release/v1', id, slug: source.slug, createdAt, sourceManifest, artifacts };
    const bytes = new TextEncoder().encode(JSON.stringify(manifest));
    const manifestKey = `${prefix}manifest.json`, manifestSha256 = sha256Hex(bytes);
    const written = await createOnly(books, manifestKey, bytes, { sha256: manifestSha256, httpMetadata: { contentType: 'application/json' } });
    const check = await books.get(manifestKey, { onlyIf: { etagMatches: written.etag } });
    if (!check?.body || sha256Hex(new Uint8Array(await check.arrayBuffer())) !== manifestSha256) throw new Error('Release manifest write could not be verified');
    return { manifest, manifestKey, manifestSha256, manifestEtag: written.etag };
  } catch (error) {
    await recordReleaseFailure(books, source.slug, id, 'freeze', error);
    throw error;
  }
}

/** R2 conditional GET pins the exact object version whose bytes were verified at
 * promotion. Missing/changed masters never fall back to mutable authoring keys. */
export async function openReleaseArtifact(books: any, artifact: FrozenArtifact) {
  const obj = await books.get(artifact.key, { onlyIf: { etagMatches: artifact.etag } });
  if (!obj?.body || obj.etag !== artifact.etag || obj.size !== artifact.bytes) throw new Error('Frozen release artifact is missing or changed');
  return obj;
}

export async function readArtifactRelease(db: any, books: any, slug: string, id?: string): Promise<ArtifactRelease> {
  const row = id
    ? await db.prepare('SELECT * FROM artifact_releases WHERE book_slug = ? AND id = ?').bind(slug, id).first()
    : await db.prepare('SELECT r.* FROM artifact_releases r JOIN artifact_release_heads h ON h.release_id = r.id WHERE h.book_slug = ? AND r.book_slug = h.book_slug').bind(slug).first();
  if (!row) throw new Error('No frozen release is available for this book');
  const prefix = artifactReleasePrefix(slug, row.id);
  if (!validId(slug) || !validId(row.id) || row.manifest_key !== `${prefix}manifest.json`) throw new Error('Invalid release pointer');
  const obj = await books.get(row.manifest_key, { onlyIf: { etagMatches: row.manifest_etag } });
  if (!obj?.body || obj.etag !== row.manifest_etag) throw new Error('Frozen release manifest is unavailable');
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if (sha256Hex(bytes) !== row.manifest_sha256) throw new Error('Frozen release manifest hash mismatch');
  const release: ArtifactRelease = JSON.parse(new TextDecoder().decode(bytes));
  const { revision, uploaded: _uploaded, ...source } = release.sourceManifest;
  if (release.schema !== 'artifact-release/v1' || release.id !== row.id || release.slug !== slug || source.slug !== slug || revision !== row.revision || revisionHash(source) !== revision ||
    release.artifacts.length !== source.artifacts.length || new Set(release.artifacts.map(a => a.key)).size !== source.artifacts.length ||
    new Set(release.artifacts.map(a => a.sourceKey)).size !== source.artifacts.length || release.artifacts.some(a => {
      const original = source.artifacts.find(s => s.key === a.sourceKey);
      return !original || a.role !== original.role || a.sha256 !== original.sha256 || a.bytes !== original.bytes || !a.etag || !a.key.startsWith(`${prefix}artifacts/`) || a.key.includes('..');
    })) throw new Error('Frozen release contract is invalid');
  return release;
}

export function releaseArtifact(release: ArtifactRelease, role: string) {
  const matches = release.artifacts.filter(a => a.role === role);
  if (matches.length !== 1) throw new Error(`Frozen release has no unique ${role} artifact`);
  return matches[0];
}
