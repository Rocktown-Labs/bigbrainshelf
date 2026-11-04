import { adoptionCounts } from './adoption-counts';
import { editionBindings, driftFixBinding } from './adoption-evidence';
/** Offline-first legacy adoption. Identity of record is not approval or visual QC. */
import { captureBookRevision, readPlanInventory, revisionHash, assertRevisionUnchanged } from '../packages/core/src/book-revision';
import { bytesHash, pageSourceRevision } from '../packages/core/src/assembly-identity';
import { fingerprintOf, isSnapshotArtifact } from '../factory/src/versioning';

export interface AdoptionEvidence {
  inventory: string; line: string; color?: string; bookQa: string;
  continuity?: string; editions?: string; colorPairing?: string;
  auditSupplement?: string;
}
interface Decision { identity?: { revision: string; sha256: string; lineSha256?: string }; status: 'eligible' | 'unchanged' | 'reported'; reason: string; tier?: string; evidence?: unknown }
interface PageDecision { id: string; line: Decision; color: Decision }
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));
async function read(books: any, key: string) {
  const object = await books.get(key);
  return object ? { bytes: new Uint8Array(await object.arrayBuffer()), etag: object.etag } : null;
}
async function listing(books: any, slug: string) {
  const entries: { key: string; size: number }[] = []; let cursor: string | undefined;
  do {
    const result = await books.list({ prefix: `books/${slug}/`, cursor });
    for (const obj of result.objects) if (isSnapshotArtifact(slug, obj.key)) {
      if (!Number.isSafeInteger(obj.size) || obj.size < 0) throw new Error(`Size unavailable for fingerprint: ${obj.key}`);
      entries.push({ key: obj.key, size: obj.size });
    }
    if (result.truncated && (!result.cursor || result.cursor === cursor)) throw new Error('Invalid object pagination');
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);
  return entries;
}
const denied = (reason: string): Decision => ({ status: 'reported', reason });

interface ContinuityProof {
  ok: boolean; reason: string; logOk?: boolean; log?: any; imageWrites?: any[];
  fingerprint?: string; baseline?: any; versionsSha256?: string;
  currentFileSet?: { key: string; size: number }[];
}
async function continuityProof(books: any, slug: string, raw?: string): Promise<ContinuityProof> {
  if (!raw) return { ok: false, reason: 'No closed-write-log export supplied' };
  const log = JSON.parse(raw);
  if (log.schema !== 'adoption-continuity/v1' || log.slug !== slug || (!Number.isSafeInteger(log.auditAt) || log.auditAt <= 0) ||
    !log.attestation?.by || log.attestation.complete !== true || log.attestation.writeFreeze !== true ||
    !(Number.isSafeInteger(log.coverageFrom) && Number.isSafeInteger(log.coverageThrough) && log.coverageFrom <= log.auditAt && log.coverageThrough >= log.auditAt) || log.attestation.freezeFrom !== log.coverageThrough)
    return { ok: false, reason: 'Missing log coverage or operator closed-log/freeze attestation' };
  const versionsObject = await read(books, `books/${slug}/versions.json`);
  if (!versionsObject) return { ok: false, reason: 'versions.json missing' };
  const document = decode(versionsObject.bytes);
  if (document.slug !== slug || !Array.isArray(document.versions)) return { ok: false, reason: 'Invalid versions document' };
  const versions = document.versions.filter((v: any) => v.at <= log.auditAt).sort((a: any, b: any) => b.at - a.at || b.version - a.version);
  const baseline = versions[0];
  if (!baseline || typeof baseline.source !== 'string' || !baseline.source.trim() || !Number.isSafeInteger(baseline.version) || baseline.version < 1) return { ok: false, reason: 'No valid source-attributed version entry at or before audit' };
  const items = await listing(books, slug);
  if (new Set(items.map(i => i.key)).size !== items.length) return { ok: false, reason: 'Duplicate keys in fingerprint listing' };
  const rows: { ref: string; row: any }[] = [];
  for (const table of ['production_events', 'gen_attempts']) {
    if (!Array.isArray(log[table]) || log.counts?.[table] !== log[table].length) return { ok: false, reason: `Missing complete ${table} export` };
    for (const row of log[table]) {
      if (row.slug !== slug || !Number.isSafeInteger(row.id) || row.created_at < log.auditAt || row.created_at > log.coverageThrough)
        return { ok: false, reason: `Invalid ${table} export row` };
      rows.push({ ref: `${table}:${row.id}`, row });
    }
  }
  for (const v of document.versions.filter((v: any) => v.at > log.auditAt)) rows.push({ ref: `versions:${v.version}`, row: v });
  if (new Set(rows.map(r => r.ref)).size !== rows.length || !Array.isArray(log.classifications)) return { ok: false, reason: 'Duplicate rows or absent classifications' };
  if (log.classifications.length !== rows.length || new Set(log.classifications.map((x: any) => x.ref)).size !== rows.length)
    return { ok: false, reason: 'Every exported row/version requires exactly one reviewed classification' };
  const imageWrites: any[] = [];
  for (const { ref, row } of rows) {
    const label = log.classifications.find((x: any) => x.ref === ref);
    if (!label || label.rowHash !== revisionHash(row) || !['non-image', 'image-write'].includes(label.kind)) return { ok: false, reason: `Unclassified or changed log row: ${ref}` };
    if (ref.startsWith('gen_attempts:') && ['accepted', 'autofixed', 'edit_accepted'].includes(row.outcome) && label.kind !== 'image-write')
      return { ok: false, reason: `Accepted attempt cannot be classified as a non-image observation: ${ref}` };
    if (label.kind === 'image-write') imageWrites.push(label);
  }
  // Text-only plan-edit exceptions (CG approved for Penny, 2026-11-04): a
  // plan-JSON-only edit with no image bytes may adjust the fingerprint
  // comparison for exactly the touched keys, but only when its BEFORE
  // bytes are archived under the book and hash-verify here against the
  // pinned digest. The strict rule otherwise does not move: an exception
  // that cannot verify fails the whole proof, never just itself.
  const textOnlyExceptions: any[] = [];
  const adjustedSizes = new Map(items.map(i => [i.key, i.size]));
  let adjustedBytes = items.reduce((n, x) => n + x.size, 0);
  for (const ex of (log.exceptions ?? []).filter((x: any) => x?.kind === 'text-only-plan-edit')) {
    const fail = (why: string) => ({ ok: false, reason: `Text-only plan edit exception does not verify: ${why}` });
    if (textOnlyExceptions.length >= 4) return fail('too many exceptions');
    if (typeof ex.key !== 'string' || !new RegExp(`^books/${slug}/plans/S[1-9][0-9]*\\.json$`).test(ex.key)) return fail('key is not a plan JSON');
    if (!adjustedSizes.has(ex.key) || textOnlyExceptions.some(e => e.key === ex.key)) return fail(`duplicate or unknown key ${ex.key}`);
    if (!/^[a-f0-9]{64}$/.test(ex.beforeSha256 ?? '') || !Number.isSafeInteger(ex.beforeBytes) || ex.beforeBytes < 0) return fail('before state is not pinned');
    if (typeof ex.archiveKey !== 'string' || !ex.archiveKey.startsWith(`books/${slug}/`) || ex.archiveKey.includes('..')) return fail('archive key outside the book');
    if (ex.ref !== undefined && ex.ref !== null) {
      const label = log.classifications.find((x: any) => x.ref === ex.ref);
      const found = rows.find(r => r.ref === ex.ref);
      if (!label || !found || label.kind !== 'non-image' || label.rowHash !== revisionHash(found.row)) return fail('ref is not a classified non-image row');
    }
    const archived = await read(books, ex.archiveKey);
    if (!archived || bytesHash(archived.bytes) !== ex.beforeSha256 || archived.bytes.length !== ex.beforeBytes) return fail(`archived before bytes do not match for ${ex.key}`);
    adjustedBytes += ex.beforeBytes - adjustedSizes.get(ex.key)!;
    adjustedSizes.set(ex.key, ex.beforeBytes);
    textOnlyExceptions.push({ key: ex.key, ref: ex.ref ?? null, beforeSha256: ex.beforeSha256, beforeBytes: ex.beforeBytes, archiveKey: ex.archiveKey });
  }
  const fingerprint = fingerprintOf(items);
  const fpMatches = baseline.fingerprint === fingerprintOf(items.map(i => ({ ...i, size: adjustedSizes.get(i.key)! }))) && baseline.files === items.length && baseline.bytes === adjustedBytes;
  return { ok: fpMatches, logOk: true, reason: fpMatches
      ? (textOnlyExceptions.length ? `Approved continuity rule: matching file-set fingerprint after ${textOnlyExceptions.length} verified text-only plan edit exception(s), plus operator-attested closed write log` : 'Approved continuity rule: matching file-set fingerprint plus operator-attested closed write log')
      : 'Current file-set fingerprint differs from pre-audit entry',
    fingerprint, baseline, currentFileSet: items, versionsSha256: bytesHash(versionsObject.bytes), log, imageWrites, textOnlyExceptions };
}

export async function planAdoption(books: any, slug: string, evidence: AdoptionEvidence) {
  if (slug === 'iwillteach') throw new Error('Tilda is parked/report-only by explicit policy');
  const inventory = await readPlanInventory(books, slug);
  const targets: { key: string; role: string }[] = [];
  for (const name of ['cover.jpg', 'cover-titled.jpg', 'back-cover-color.jpg', 'back-cover-line.jpg', 'picture-book.pdf', 'coloring-book.pdf', 'picture-book-color.pdf']) {
    const key = `books/${slug}/${name}`; if (await books.head(key)) targets.push({ key, role: name });
  }
  const captured = await captureBookRevision(books, slug, targets, inventory);
  const bible = decode(inventory.sources.find(s => s.role === 'bible')!.bytes);
  const plans = new Map(inventory.sources.filter(s => s.role === 'plan').map(s => [s.key, decode(s.bytes)]));
  const sources = Object.fromEntries(Object.entries(evidence).filter(([, value]) => value !== undefined).map(([role, raw]) => [role, { sha256: bytesHash(new TextEncoder().encode(raw!)), raw }]));
  const errors: string[] = [];
  const records: Record<string, any> = {};
  for (const role of ['inventory', 'line', 'color'] as const) {
    const raw = evidence[role]; if (!raw) continue;
    const local = JSON.parse(raw);
    const key = `books/${slug}/audit/${role === 'inventory' ? 'inventory' : `cast-audit-${role}`}.json`;
    const remote = await read(books, key);
    if (!remote || bytesHash(remote.bytes) !== sources[role].sha256 || local?.slug !== slug || (role !== 'inventory' && local.edition !== role)) errors.push(`Local/R2 ${role} evidence missing, changed or for another book`);
    else records[role] = local;
  }
  // Audit supplement (RGM amendment, 2026-11-04): a judgment inventory
  // built from a partial key set can undercount the book (Wells: keyed
  // on plan imageKey, 73 of 90 pages) and pages outside that key set
  // have no audit rows at all. A supplement may restate the four count
  // fields and supply rows for pages the audit never recorded, under
  // the same discipline as the pairing supplement: it lives in the
  // book's own audit prefix (the local copy must byte-match the R2
  // object), its counts are accepted only when they equal the counts
  // derived from the live plans exactly, and a row naming a page the
  // audit DID record is an evidence error, never an override.
  const auditSup: { counts?: any; lineRows: Map<string, any> } = { lineRows: new Map() };
  let auditSupCountsUsed = false;
  if (evidence.auditSupplement) {
    try {
      const parsed = JSON.parse(evidence.auditSupplement);
      if (parsed?.schema !== 'adoption-audit-supplement/v1' || parsed?.slug !== slug) throw new Error('shape');
      const remote = await read(books, `books/${slug}/audit/audit-supplement.json`);
      if (!remote || bytesHash(remote.bytes) !== sources.auditSupplement.sha256) throw new Error('shape');
      if (parsed.counts !== undefined) {
        const c = parsed.counts;
        if (!Number.isSafeInteger(c?.planned_pages) || !Number.isSafeInteger(c?.planned_story_pages) || !Number.isSafeInteger(c?.line_images) ||
          !Array.isArray(c?.chapters_found) || !c.chapters_found.every((x: any) => typeof x === 'string')) throw new Error('shape');
        auditSup.counts = c;
      }
      if (parsed.lineRows !== undefined) {
        if (!Array.isArray(parsed.lineRows)) throw new Error('shape');
        for (const row of parsed.lineRows) {
          const id = `${row?.page}|${row?.key}`;
          if (!row?.page || typeof row?.key !== 'string' || !row.key.startsWith(`books/${slug}/`) || auditSup.lineRows.has(id)) throw new Error('shape');
          if ((records.line?.results ?? []).some((r: any) => r.page === row.page && r.key === row.key)) throw new Error(`supplement names a recorded row: ${id}`);
          auditSup.lineRows.set(id, row);
        }
      }
    } catch (e) { errors.push(e instanceof Error && e.message.startsWith('supplement names') ? `Audit supplement overrides recorded evidence: ${e.message}` : 'Invalid audit supplement'); auditSup.counts = undefined; auditSup.lineRows.clear(); }
  }
  const count = records.inventory;
  const chapters = inventory.sources.filter(s => s.role === 'plan').length;
  const derivedCounts = { planned_pages: inventory.pages.length, planned_story_pages: inventory.pages.filter(p => p.kind === 'story').length,
    chapters_found: Array.from({ length: chapters }, (_, i) => `S${i + 1}`), line_images: inventory.pages.length };
  const countsMatch = (c: any) => !!c && c.planned_pages === derivedCounts.planned_pages && c.planned_story_pages === derivedCounts.planned_story_pages &&
    JSON.stringify(c.chapters_found) === JSON.stringify(derivedCounts.chapters_found) && c.line_images === derivedCounts.line_images;
  if (!countsMatch(count)) {
    if (auditSup.counts && countsMatch(auditSup.counts)) auditSupCountsUsed = true;
    else errors.push('Current inventory/counts do not match judgment-run evidence');
  }
  const qa = JSON.parse(evidence.bookQa);
  if ((qa?.slug ?? qa?.book_slug) !== slug || !qa?.source || !(Number.isFinite(qa?.measured_at) && qa?.measured_at > 0)) errors.push('Missing or invalid book_qa measurement export');
  const continuity = await continuityProof(books, slug, evidence.continuity);
  if (continuity.logOk && continuity.imageWrites?.length) {
    const unexplained: string[] = [];
    for (const write of continuity.imageWrites) {
      if (!Array.isArray(write.keys) || !write.keys.length) { unexplained.push(write.ref); continue; }
      for (const key of write.keys) {
        const current = typeof key === 'string' && key.startsWith(`books/${slug}/`) && !key.includes('..') ? await read(books, key) : null;
        const named = continuity.log.exceptions?.find((x: any) => x.key === key && (x.ref === write.ref || x.relatedRefs?.includes(write.ref)));
        if (!named || !current || !await driftFixBinding(books, slug, key, bytesHash(current.bytes), continuity)) unexplained.push(key);
      }
    }
    if (unexplained.length) { continuity.ok = false; continuity.logOk = false; continuity.reason = `Unexplained post-audit image writes: ${unexplained.join(', ')}`; }
  }
  const editions = await editionBindings(books, slug, evidence.editions);
  if (editions.error) errors.push(editions.error);
  // Color pairing supplement (RGM amendment, 2026-11-04): the preserved
  // judgment-run color audits predate line-hash pairing, so their rows
  // carry no lineSha256. A supplement may fill that one field, but only
  // as an index: every entry must hash-match BOTH captured artifacts
  // (the color twin and the exact line page it claims to twin) at the
  // pairing check below, so it can never pair a twin to the wrong line
  // page on the operator's word alone. It never overrides a pairing the
  // audit itself recorded.
  const pairing = new Map<string, any>();
  if (evidence.colorPairing) {
    try {
      const parsed = JSON.parse(evidence.colorPairing);
      if (parsed?.schema !== 'adoption-color-pairing/v1' || parsed?.slug !== slug || !Array.isArray(parsed.rows)) throw new Error('shape');
      for (const row of parsed.rows) {
        const id = `${row?.page}|${row?.key}`;
        if (!row?.page || typeof row?.key !== 'string' || !/^[a-f0-9]{64}$/.test(row?.colorSha256 ?? '') || !/^[a-f0-9]{64}$/.test(row?.lineSha256 ?? '') || typeof row?.lineKey !== 'string' || pairing.has(id)) throw new Error('shape');
        pairing.set(id, row);
      }
    } catch { errors.push('Invalid color pairing supplement'); pairing.clear(); }
  }
  const pages: PageDecision[] = [];
  for (const ref of inventory.pages) {
    const plan = plans.get(ref.planKey); const pg = ref.kind === 'finale' ? plan.finale : plan.pages[ref.page];
    const pageLabel = `S${ref.chapter}${ref.kind === 'finale' ? ' finale' : `p${ref.page}`}`;
    const revision = pageSourceRevision(bible, plan, pg);
    const lineArtifact = captured.manifest.artifacts.find(a => a.key === ref.lineKey)!;
    let lineRowFromSupplement = false;
    async function match(role: 'line' | 'color', key: string, sha256: string, size: number): Promise<Decision> {
      if (errors.length || slug === 'iwillteach') return denied(slug === 'iwillteach' ? 'Tilda is parked/report-only by policy' : errors.join('; '));
      let matches = (records[role]?.results ?? []).filter((row: any) => row.page === pageLabel && row.key === key);
      if (matches.length === 0 && role === 'line') {
        // The audit never recorded this page: a verified supplement
        // row may stand in for it (parse-time checks guarantee it
        // names no recorded pair and byte-matches the R2 supplement).
        const sup = auditSup.lineRows.get(`${pageLabel}|${key}`);
        if (sup) { matches = [sup]; lineRowFromSupplement = true; }
      }
      if (matches.length !== 1) return denied(`No unique ${role} audit inventory row for ${pageLabel}`);
      const row = matches[0];
      if (row.sha256 && (row.sha256 !== sha256 || (row.bytes !== undefined && row.bytes !== size))) return denied('Historical digest/size conflicts with current bytes');
      if (row.sha256 === sha256) return { status: 'eligible', reason: 'Current bytes match artifact digest in preserved audit', tier: 'byte-exact-audit', evidence: { source: role, page: pageLabel, sourceHash: sources[role].sha256 } };
      const edition = editions.bindings.get(key);
      if (edition) {
        if (edition.sha256 !== sha256 || edition.bytes !== size) return denied('Edition hash/size conflicts with current artifact');
        return { status: 'eligible', tier: 'byte-exact-edition-chain', reason: 'Current bytes match latest pre-audit artifact in verified editions chain', evidence: edition };
      }
      const drift = await driftFixBinding(books, slug, key, sha256, continuity);
      if (drift) return { status: 'eligible', tier: drift.tier, reason: 'Current bytes match enumerated accepted attempt with post-fix QC replay', evidence: drift };
      if (continuity.ok) {
        return { status: 'eligible', reason: continuity.reason, tier: 'fingerprint-and-closed-log', evidence: { fingerprint: continuity.fingerprint, version: continuity.baseline.version, versionsSha256: continuity.versionsSha256, source: role, sourceHash: sources[role].sha256 } };
      }
      return denied(continuity.reason);
    }
    let line = await match('line', ref.lineKey, lineArtifact.sha256, lineArtifact.bytes);
    if (lineRowFromSupplement && line.status === 'eligible') line.evidence = { ...(line.evidence as Record<string, unknown>), auditSupplement: 'adoption-audit-supplement/v1' };
    const lineIdentity = { revision, sha256: lineArtifact.sha256 };
    if (pg.lineIdentity) line = revisionHash(pg.lineIdentity) !== revisionHash(lineIdentity) ? denied('Existing line provenance conflicts; not a legacy blank identity') : { status: 'unchanged', reason: 'Existing line identity already matches; no adoption claim or write' };
    if (line.status === 'eligible') { if (pg.lineIdentity) line.status = 'unchanged'; else pg.lineIdentity = lineIdentity; }
    if (line.status !== 'reported') line.identity = lineIdentity;
    let color = denied('No current color pointer/twin to adopt');
    if (ref.colorKey && line.status !== 'reported') {
      const artifact = captured.manifest.artifacts.find(a => a.key === ref.colorKey)!;
      color = await match('color', ref.colorKey, artifact.sha256, artifact.bytes);
      const row = (records.color?.results ?? []).find((r: any) => r.page === pageLabel && r.key === ref.colorKey);
      if (row && typeof row.lineSha256 !== 'string') {
        // The audit recorded no pairing: the supplement may complete it,
        // hash-verified against both captured artifacts. A pairing the
        // audit DID record (matching or not) is never overridden.
        const sup = pairing.get(`${pageLabel}|${ref.colorKey}`);
        if (sup && sup.colorSha256 === artifact.sha256 && sup.lineSha256 === lineArtifact.sha256 && sup.lineKey === ref.lineKey) {
          if (color.status === 'eligible') color.evidence = { ...(color.evidence as Record<string, unknown>), colorPairing: { lineKey: sup.lineKey, supplement: 'adoption-color-pairing/v1' } };
        } else color = denied('Color twin has no verified binding to this current line hash');
      } else if (row?.lineSha256 !== lineArtifact.sha256) color = denied('Color twin has no verified binding to this current line hash');
      const identity = { revision, lineSha256: lineArtifact.sha256, sha256: artifact.sha256 };
      if (pg.colorIdentity) color = revisionHash(pg.colorIdentity) !== revisionHash(identity) ? denied('Existing color provenance conflicts; not a legacy blank identity') : { status: 'unchanged', reason: 'Existing color identity already matches; no adoption claim or write' };
      if (color.status === 'eligible') { if (pg.colorIdentity) color.status = 'unchanged'; else pg.colorIdentity = identity; }
      if (color.status !== 'reported') color.identity = identity;
    }
    pages.push({ id: ref.id, line, color });
  }
  const patches = inventory.sources.filter(s => s.role === 'plan').flatMap(source => {
    const next = plans.get(source.key);
    if (revisionHash(decode(source.bytes)) === revisionHash(next)) return [];
    const body = JSON.stringify(next, null, 1);
    return [{ key: source.key, etag: source.etag, before: new TextDecoder().decode(source.bytes), body,
      originalBase64: Buffer.from(source.bytes).toString('base64'), beforeSha256: bytesHash(source.bytes), afterSha256: bytesHash(new TextEncoder().encode(body)) }];
  });
  const evidenceHeads: { key: string; etag: string }[] = [];
  for (const role of ['inventory', 'line', 'color'] as const) if (evidence[role]) {
    const key = `books/${slug}/audit/${role === 'inventory' ? 'inventory' : `cast-audit-${role}`}.json`;
    const h = await books.head(key); if (h?.etag) evidenceHeads.push({ key, etag: h.etag });
  }
  if (evidence.continuity) { const key = `books/${slug}/versions.json`; const h = await books.head(key); if (h?.etag) evidenceHeads.push({ key, etag: h.etag }); }
  const proof = await adoptionCounts(books, slug, bible, inventory.pages, count?.pdf_pages, pages.filter(p => p.color.status !== 'reported').length);
  const payload = { schema: 'legacy-adoption/v1', slug, manifest: captured.manifest, observations: [...captured.observations, ...evidenceHeads],
    sources, continuity, targets, proof, errors, pages, patches, legacyPdfCounts: count?.pdf_pages ?? {}, canApply: patches.length > 0 && errors.length === 0 && slug !== 'iwillteach',
    ...(evidence.auditSupplement ? { auditSupplement: { countsCorrected: auditSupCountsUsed, lineRowsSupplied: auditSup.lineRows.size } } : {}) };
  return { ...payload, fingerprint: revisionHash(payload) };
}
export type AdoptionReport = Awaited<ReturnType<typeof planAdoption>>;

export async function applyAdoption(books: any, report: AdoptionReport, reviewedFingerprint: string, log: (entry: any) => Promise<void>) {
  const { fingerprint, ...payload } = report;
  if (!report.canApply || !report.patches.length || fingerprint !== reviewedFingerprint || revisionHash(payload) !== fingerprint) throw new Error('A matching eligible reviewed dry-run is required');
  const freshEvidence: AdoptionEvidence = { inventory: report.sources.inventory.raw, line: report.sources.line.raw, bookQa: report.sources.bookQa.raw,
    color: report.sources.color?.raw, continuity: report.sources.continuity?.raw, editions: report.sources.editions?.raw, colorPairing: report.sources.colorPairing?.raw, auditSupplement: report.sources.auditSupplement?.raw };
  const fresh = await planAdoption(books, report.slug, freshEvidence);
  if (fresh.fingerprint !== fingerprint) throw new Error('Live bytes or evidence changed after dry-run');
  await assertRevisionUnchanged(books, report.observations);
  await log({ event: 'intent', at: new Date().toISOString(), fingerprint, originalPlans: report.patches.map(p => ({ key: p.key, body: p.before, base64: p.originalBase64, sha256: p.beforeSha256 })), report });
  try {
    for (const patch of report.patches) {
      if (!new RegExp(`^books/${report.slug}/plans/S[1-9][0-9]*\\.json$`).test(patch.key)) throw new Error('Only plan JSON writes are authorized');
      const saved = await books.put(patch.key, patch.body, { httpMetadata: { contentType: 'application/json' }, onlyIf: { etagMatches: patch.etag } });
      if (!saved) throw new Error(`Plan changed before conditional write: ${patch.key}`);
      const verified = await read(books, patch.key);
      if (!verified || bytesHash(verified.bytes) !== patch.afterSha256) throw new Error(`Plan write unconfirmed: ${patch.key}`);
      await log({ event: 'plan-stamped', at: new Date().toISOString(), key: patch.key, sha256: patch.afterSha256, pages: report.pages.filter(p => report.manifest.pages.find(r => r.id === p.id)?.planKey === patch.key) });
    }
    const after = await captureBookRevision(books, report.slug, report.targets);
    for (const old of report.manifest.artifacts.filter(a => a.role !== 'plan')) if (after.manifest.artifacts.find(a => a.key === old.key)?.sha256 !== old.sha256) throw new Error(`Non-plan artifact changed during adoption: ${old.key}`);
    await log({ event: 'completed', at: new Date().toISOString(), manifest: after.manifest });
    return after;
  } catch (error) {
    await log({ event: 'failed-or-unconfirmed', at: new Date().toISOString(), error: error instanceof Error ? error.message : 'Unknown failure' });
    throw error;
  }
}
