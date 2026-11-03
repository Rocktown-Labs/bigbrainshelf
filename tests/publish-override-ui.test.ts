import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const page = readFileSync(new URL('../src/pages/admin/books/[slug]/edit.astro', import.meta.url), 'utf8');
const code = page.slice(page.indexOf('  function doPublish('), page.indexOf('  function escapeHtml('));

async function run(confirm: boolean, reason: string | null) {
  const calls: any[] = [];
  const prompts: string[] = [];
  const alerts: string[] = [];
  const context: any = {
    BOOK_SLUG: 'test', location: { reload() {} }, alert: (s: string) => alerts.push(s),
    window: { confirm: (s: string) => { prompts.push(s); return confirm; }, prompt: () => reason },
    fetch: async (_url: string, options: any) => {
      calls.push(JSON.parse(options.body));
      return calls.length === 1
        ? { ok: false, status: 409, json: async () => ({ gate: 'readiness', verification: 'reviewed-revision', blockers: [{ id: 'audio', detail: 'Unknown audio.' }] }) }
        : { ok: true, status: 200, json: async () => ({ reason: 'Published.', override: { checks: ['audio'], recorded: true } }) };
    },
  };
  runInNewContext(`${code}\ndoPublish();`, context);
  for (let n = 0; n < 20; n++) await Promise.resolve();
  return { calls, prompts, alerts };
}

test('publish exception requires confirmation and a nonempty reason', async () => {
  expect((await run(false, 'Owner choice')).calls).toHaveLength(1);
  expect((await run(true, null)).calls).toHaveLength(1);
  expect((await run(true, ' ')).calls).toHaveLength(1);
});

test('confirmed exception sends only the displayed check IDs and entered reason', async () => {
  const result = await run(true, 'CG accepts unavailable audio');
  expect(result.calls).toEqual([{ book_slug: 'test' }, { book_slug: 'test', publishOverride: {
    reason: 'CG accepts unavailable audio', checks: ['audio'], verification: 'reviewed-revision',
  } }]);
  expect(result.prompts[0]).toContain('audio: Unknown audio.');
  expect(result.alerts[0]).toContain('Publish exceptions recorded: audio');
});
