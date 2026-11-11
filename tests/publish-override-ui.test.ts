import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { TextDecoder, TextEncoder } from 'node:util';

// The publish modal's flow core (src/components/PublishFlow.astro)
// owns the request contract the native-dialog flow used to: a
// readiness refusal surfaces with its blockers, and an exception
// publish requires an explicit decision carrying a nonempty reason
// and exactly the displayed check IDs. These tests run the core
// extracted from the component against a mocked NDJSON endpoint.
const page = readFileSync(new URL('../src/components/PublishFlow.astro', import.meta.url), 'utf8');
const code = page.slice(page.indexOf('function createPublishFlow'), page.indexOf('// __PUBLISH_FLOW_CORE_END__'));

function streamOf(text: string, splitAt?: number) {
  const bytes = new TextEncoder().encode(text);
  const chunks = splitAt === undefined ? [bytes] : [bytes.slice(0, splitAt), bytes.slice(splitAt)];
  let i = 0;
  return { getReader: () => ({ read: async () => i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined } }) };
}

const ndjson = (events: unknown[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n';
const refusal = { type: 'result', status: 409, body: { ok: false, gate: 'readiness', verification: 'reviewed-revision', reason: 'audio: Unknown audio.', blockers: [{ id: 'audio', detail: 'Unknown audio.' }] } };

async function run(responses: string[], opts: any) {
  const calls: any[] = [];
  let n = 0;
  const context: any = {
    TextDecoder,
    fetchImpl: async (_url: string, init: any) => {
      calls.push(JSON.parse(init.body));
      const text = responses[Math.min(n++, responses.length - 1)];
      return { status: 200, body: streamOf(text, 17) };
    },
  };
  runInNewContext(`${code}\n;globalThis.__done = (async () => {
    const flow = createPublishFlow(fetchImpl);
    const events = [];
    await flow.run(${JSON.stringify(opts)}, (e) => events.push(e));
    return events;
  })();`, context);
  const events = await context.__done;
  return { calls, events };
}

test('a plain publish streams steps and ends at the refusal with its blockers', async () => {
  const { calls, events } = await run([ndjson([
    { type: 'step', step: 'gate-check', state: 'start' },
    refusal,
  ])], { slug: 'test' });
  expect(calls).toEqual([{ book_slug: 'test', stream: true }]);
  expect(events[0]).toEqual({ kind: 'step', step: 'gate-check', state: 'start', copied: undefined, total: undefined });
  const last = events[events.length - 1];
  expect(last.kind).toBe('refused');
  expect(last.body.blockers).toEqual([{ id: 'audio', detail: 'Unknown audio.' }]);
  expect(last.body.verification).toBe('reviewed-revision');
});

test('a publish exception requires a nonempty reason and named checks before any request', async () => {
  const blank = await run([ndjson([refusal])], { slug: 'test', override: { reason: ' ', checks: ['audio'], verification: 'reviewed-revision' } });
  expect(blank.calls).toHaveLength(0);
  expect(blank.events[0].kind).toBe('error');
  const noChecks = await run([ndjson([refusal])], { slug: 'test', override: { reason: 'Owner choice', checks: [], verification: 'reviewed-revision' } });
  expect(noChecks.calls).toHaveLength(0);
});

test('a confirmed exception sends only the displayed check IDs and the entered reason', async () => {
  const success = { type: 'result', status: 200, body: { ok: true, reason: 'Published.', publicSlug: 'test-book', override: { checks: ['audio'], recorded: true } } };
  const { calls, events } = await run([ndjson([
    { type: 'step', step: 'artifact-copy', state: 'progress', copied: 2, total: 5 },
    success,
  ])], { slug: 'test', override: { reason: 'CG accepts unavailable audio', checks: ['audio'], verification: 'reviewed-revision' } });
  expect(calls).toEqual([{ book_slug: 'test', stream: true, publishOverride: {
    reason: 'CG accepts unavailable audio', checks: ['audio'], verification: 'reviewed-revision',
  } }]);
  expect(events[0]).toEqual({ kind: 'step', step: 'artifact-copy', state: 'progress', copied: 2, total: 5 });
  const last = events[events.length - 1];
  expect(last.kind).toBe('published');
  expect(last.body.publicSlug).toBe('test-book');
});

test('no native dialogs remain anywhere in the publish path', () => {
  const readiness = readFileSync(new URL('../src/pages/admin/books/[slug]/readiness.astro', import.meta.url), 'utf8');
  const publishBlock = readiness.slice(readiness.indexOf('var pb = document.getElementById("publish-btn")'));
  expect(publishBlock).toContain('window.openPublishFlow');
  expect(publishBlock).not.toContain('window.confirm');
  const edit = readFileSync(new URL('../src/pages/admin/books/[slug]/edit.astro', import.meta.url), 'utf8');
  const doPublish = edit.slice(edit.indexOf('function doPublish('), edit.indexOf('function escapeHtml('));
  expect(doPublish).not.toContain('window.confirm');
  expect(doPublish).not.toContain('window.prompt');
  expect(doPublish).not.toContain('alert(');
  expect(doPublish).toContain('openPublishFlow');
  expect(page).not.toContain('window.confirm(');
  expect(page).not.toContain('window.prompt(');
  expect(page).not.toContain('alert(');
});
