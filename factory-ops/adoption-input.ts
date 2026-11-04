import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { bytesHash } from '../packages/core/src/assembly-identity';
import type { AdoptionEvidence } from './adoption';

/** Pin exact existing evidence files. This hashes evidence documents, not historical art. */
export function loadEvidenceIndex(file: string, slug: string) {
  const bytes = new Uint8Array(readFileSync(file)); const index = JSON.parse(new TextDecoder().decode(bytes));
  if (index.schema !== 'adoption-input/v1' || index.slug !== slug) throw new Error('Invalid/wrong-book evidence index');
  const raw: Record<string, string> = {};
  for (const role of ['inventory', 'line', 'color', 'bookQa', 'continuity', 'editions']) {
    const entry = index.sources?.[role];
    if (!entry) { if (['inventory', 'line', 'bookQa'].includes(role)) throw new Error(`Missing ${role} evidence source`); continue; }
    if (typeof entry.file !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`Invalid pinned ${role} source`);
    const source = new Uint8Array(readFileSync(resolve(dirname(file), entry.file)));
    if (bytesHash(source) !== entry.sha256) throw new Error(`Evidence file changed: ${role}`);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(source); JSON.parse(content); raw[role] = content;
  }
  const evidence: AdoptionEvidence = { inventory: raw.inventory, line: raw.line, bookQa: raw.bookQa, color: raw.color, continuity: raw.continuity, editions: raw.editions };
  return { evidence, index, indexSha256: bytesHash(bytes) };
}
