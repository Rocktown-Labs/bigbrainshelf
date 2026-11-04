/** Dry-run first. Only RGM executes this against live storage after review/merge. */
import { mkdirSync, readFileSync, writeFileSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEvidenceIndex } from './adoption-input';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { planAdoption, applyAdoption } from './adoption';
import { awsBucket } from './adoption-transport';

function append(file: string, entry: unknown) {
  const fd = openSync(file, 'a');
  try {
    const data = Buffer.from(JSON.stringify(entry) + '\n'); let offset = 0;
    while (offset < data.length) { const n = writeSync(fd, data, offset, data.length - offset); if (n <= 0) throw new Error('Incomplete ledger write'); offset += n; }
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    slug: { type: 'string' }, account: { type: 'string' }, bucket: { type: 'string', default: 'kidsbook-factory' },
    evidence: { type: 'string' }, apply: { type: 'boolean', default: false }, review: { type: 'string' },
    'ledger-root': { type: 'string' },
  } });
  if (!values.slug || !values.account || !values.evidence || !/^[a-z0-9][a-z0-9-]*$/.test(values.slug)) throw new Error('--slug, --account and --evidence required');
  if (values.apply && !values.review) throw new Error('--apply requires the previously reviewed dry-run report');
  const { evidence, index, indexSha256 } = loadEvidenceIndex(resolve(values.evidence), values.slug);
  const now = new Date(); const run = `${values.slug}-${randomUUID()}`;
  const directory = join(resolve(values['ledger-root'] ?? `factory-ops/audits/${now.toISOString().slice(0, 10)}-legacy-adoption`), run);
  mkdirSync(resolve(values['ledger-root'] ?? `factory-ops/audits/${now.toISOString().slice(0, 10)}-legacy-adoption`), { recursive: true });
  mkdirSync(directory, { recursive: false }); mkdirSync(join(directory, 'objects'));
  const journal = join(directory, 'adoption.jsonl');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const sha = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  append(journal, { event: 'started', slug: values.slug, at: now.toISOString(), mode: values.apply ? 'apply' : 'dry-run', sourceSha: sha.status === 0 ? sha.stdout.trim() : null, indexSha256 });
  writeFileSync(join(directory, 'evidence-index.json'), JSON.stringify(index, null, 2), { flag: 'wx' });
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2), { flag: 'wx' });
  const books = awsBucket({ slug: values.slug, account: values.account, bucket: values.bucket, directory: join(directory, 'objects') });
  try {
    if (values.apply) {
      const status = spawnSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
      if (sha.status !== 0 || status.status !== 0 || status.stdout.trim()) throw new Error('Apply requires clean reviewed source');
    }
    if (values.slug === 'iwillteach') throw new Error('Tilda is parked at needs_review and report-only by explicit policy');
    const report = await planAdoption(books, values.slug, evidence);
    writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
    append(journal, { event: 'dry-run', at: new Date().toISOString(), report });
    if (values.apply) {
      const reviewed = JSON.parse(readFileSync(resolve(values.review!), 'utf8'));
      if (reviewed.slug !== report.slug || reviewed.fingerprint !== report.fingerprint) throw new Error('Current report differs from the reviewed dry-run; inspect the new report');
      await applyAdoption(books, report, reviewed.fingerprint, async entry => append(journal, entry));
    }
    console.log(JSON.stringify({ slug: report.slug, mode: values.apply ? 'apply' : 'dry-run', directory, fingerprint: report.fingerprint, canApply: report.canApply,
      proof: report.proof.status, pages: report.pages.map(p => ({ id: p.id, line: p.line.status, color: p.color.status, lineTier: p.line.tier, colorTier: p.color.tier })) }, null, 2));
    return report;
  } catch (error) {
    writeFileSync(join(directory, 'report-error.json'), JSON.stringify({ slug: values.slug, canApply: false, mode: 'report-only', reason: error instanceof Error ? error.message : 'Unknown failure' }, null, 2), { flag: 'wx' });
    console.error(`Report retained at ${directory}`);
    append(journal, { event: 'failed-or-reported', at: new Date().toISOString(), reason: error instanceof Error ? error.message : 'Unknown failure' });
    throw error;
  }
}
if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : 'Adoption failed'); process.exitCode = 1; });
