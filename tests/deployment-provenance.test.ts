import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
test('sealed deployment artifacts reject stale or modified source and bundles offline', () => {
  const result = spawnSync('python3', ['tests/deployment_provenance_test.py'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8',
  });
  expect(result.stdout + result.stderr).toContain('OK');
  expect(result.status).toBe(0);
});
