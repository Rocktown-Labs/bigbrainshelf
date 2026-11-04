import { test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

test('every PDF production call lives behind the shared assembly validation boundary', () => {
  const root = new URL('../factory/src/', import.meta.url);
  const callers = readdirSync(root).filter(f => f.endsWith('.ts') && f !== 'pdf.ts')
    .filter(f => /\b(?:buildPictureBook|buildColoringBook)\s*\(/.test(readFileSync(new URL(f, root), 'utf8')));
  expect(callers).toEqual(['assembly.ts']);
  for (const file of ['bookbuild.ts', 'regen.ts', 'repair.ts', 'colorize.ts']) {
    expect(readFileSync(new URL(file, root), 'utf8')).toContain('assembleVerifiedPdf');
  }
  const legacy = readFileSync(new URL('workflow.ts', root), 'utf8');
  expect(legacy).toContain('Legacy chapter workflow cannot verify');
});
