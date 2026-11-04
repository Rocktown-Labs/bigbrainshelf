import { bytesHash } from '../packages/core/src/assembly-identity';
import { revisionHash } from '../packages/core/src/book-revision';
export async function editionBindings(books: any, slug: string, raw?: string) {
  const bindings = new Map<string, { sha256: string; bytes: number; source: string; hash: string }>();
  if (!raw) return { bindings, error: null };
  try {
    const exportData = JSON.parse(raw);
    if (exportData.schema !== 'adoption-editions/v1' || exportData.slug !== slug || !Number.isSafeInteger(exportData.auditAt) || !Array.isArray(exportData.rows)) throw new Error('Invalid editions export');
    if (new Set(exportData.rows.map((r: any) => r.id)).size !== exportData.rows.length) throw new Error('Duplicate edition row ids');
    const chains = new Map<string, any[]>();
    for (const row of exportData.rows) {
      if (row.slug !== slug || !Number.isSafeInteger(row.id) || row.id < 1) throw new Error('Wrong-book editions row');
      const entries = chains.get(row.edition) ?? []; entries.push(row); chains.set(row.edition, entries);
    }
    for (const chain of chains.values()) {
      let previous: string | null = null; let latest: any = null;
      for (const row of chain.sort((a, b) => a.id - b.id)) {
        if (!row.manifest_key.startsWith(`books/${slug}/editions/`) || row.manifest_key.includes('..')) throw new Error('Invalid edition key');
        const obj = await books.get(row.manifest_key); if (!obj) throw new Error('Edition manifest missing');
        const bytes = new Uint8Array(await obj.arrayBuffer()); const manifest = JSON.parse(new TextDecoder().decode(bytes));
        if (bytesHash(bytes) !== row.hash || row.parent_hash !== previous || manifest.parent_hash !== previous || manifest.slug !== slug || manifest.edition !== row.edition || manifest.created_at !== row.created_at)
          throw new Error('Edition chain/hash does not match D1 export');
        previous = row.hash;
        if (row.created_at <= exportData.auditAt) latest = { row, manifest };
      }
      if (latest) for (const artifact of latest.manifest.artifacts) {
        if (!artifact.missing && artifact.key.startsWith(`books/${slug}/`) && /^[a-f0-9]{64}$/.test(artifact.sha256)) {
          const existing = bindings.get(artifact.key);
          if (existing && existing.sha256 !== artifact.sha256) throw new Error('Conflicting latest edition bindings');
          bindings.set(artifact.key, { sha256: artifact.sha256, bytes: artifact.bytes, source: latest.row.manifest_key, hash: latest.row.hash });
        }
      }
    }
    return { bindings, error: null };
  } catch (error) { return { bindings: new Map(), error: error instanceof Error ? error.message : 'Invalid editions evidence' }; }
}

/** Integrator-reviewed exceptions are finite, row-bound, and never inferred from a timestamp alone. */
export async function driftFixBinding(books: any, slug: string, key: string, sha256: string, continuity: any) {
  const log = continuity.log;
  if (!continuity.logOk || !['mira-the-heron-and-the-still-water', 'mastery'].includes(slug) || !Array.isArray(log.exceptions) || log.exceptions.length > 6) return null;
  const matches = log.exceptions.filter((x: any) => x.kind === 'mira-drift-fix' && x.key === key);
  if (matches.length !== 1) return null;
  const exception = matches[0];
  const attempt = log.gen_attempts.find((r: any) => `gen_attempts:${r.id}` === exception.ref);
  const classification = log.classifications.find((r: any) => r.ref === exception.ref);
  if (!attempt || !['accepted', 'autofixed', 'edit_accepted'].includes(attempt.outcome) || !attempt.image_key?.startsWith(`books/${slug}/attempts/`) || attempt.image_key.includes('..') ||
    classification?.kind !== 'image-write' || !classification.keys?.includes(key) || classification.rowHash !== revisionHash(attempt) || !exception.qcKey?.startsWith(`books/${slug}/audit/`) || exception.qcKey.includes('..')) return null;
  const archive = await books.get(attempt.image_key); const qc = await books.get(exception.qcKey);
  if (!archive || !qc) return null;
  const archivedSha256 = bytesHash(new Uint8Array(await archive.arrayBuffer()));
  const qcBytes = new Uint8Array(await qc.arrayBuffer());
  if (archivedSha256 !== sha256) return null;
  const replay = JSON.parse(new TextDecoder().decode(qcBytes));
  const rows = (replay.results ?? []).filter((r: any) => r.key === key);
  if (rows.length !== 1 || rows[0].status === 'error') return null;
  const measuredAt = rows[0].ts ? Date.parse(rows[0].ts) / 1000 : replay.measured_at;
  if (!(measuredAt >= attempt.created_at && measuredAt <= log.coverageThrough) || (rows[0].sha256 && rows[0].sha256 !== sha256)) return null;
  return { tier: 'enumerated-drift-fix', source: attempt.image_key, archiveSha256: archivedSha256,
    attemptRef: exception.ref, attemptRowHash: revisionHash(attempt), qcKey: exception.qcKey, qcSha256: bytesHash(qcBytes), measuredAt,
    assumption: 'QC/live-byte association relies on the approved closed-write-log rule; this is not a new visual approval.' };
}
