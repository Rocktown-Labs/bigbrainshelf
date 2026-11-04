// Explicitly synthetic. Never imports or invokes a production transport.
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { legacy } from '../../../tests/helpers/adoption-fixture';
import { planAdoption, applyAdoption } from '../../adoption';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const sourceSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const directory = fileURLToPath(new URL(`offline-fixture-${randomUUID()}/`, import.meta.url));
mkdirSync(directory);
const fd = openSync(join(directory, 'adoption.jsonl'), 'wx');
const log = async (entry: any) => {
  writeSync(fd, JSON.stringify({ environment: 'offline-fixture', notProduction: true, sourceSha, slug: 'test', ...entry }) + '\n'); fsyncSync(fd);
};
try {
  const f = legacy(); const report = await planAdoption(f.bucket, 'test', f.evidence);
  await log({ event: 'dry-run', at: new Date().toISOString(), report });
  await applyAdoption(f.bucket, report, report.fingerprint, log);
  console.log(directory);
} finally { closeSync(fd); }
