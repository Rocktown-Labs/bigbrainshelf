import { test, expect, mock } from 'bun:test';
import { fixture } from './helpers/identity-fixture';
let failure: 'gateway' | 'exception' | 'cap' = 'gateway';
const forbidden = () => { throw new Error('Paid transport is forbidden in offline tests'); };
mock.module('cloudflare:workers', () => ({ WorkflowEntrypoint: class { env: any; }, WorkflowStep: class {} }));
mock.module('../factory/src/bookbuild', () => ({
  r2GetJson: async (b: any, key: string) => { const o = await b.get(key); return o && JSON.parse(new TextDecoder().decode(await o.arrayBuffer())); },
  r2GetBytes: async (b: any, key: string) => { const o = await b.get(key); return o && new Uint8Array(await o.arrayBuffer()); },
  r2Put: async (b: any, key: string, data: any) => b.put(key, data),
  r2ListAll: async (b: any, prefix: string) => (await b.list({ prefix })).objects.map((o: any) => o.key),
  logGenEvents: async () => {}, logGenAttempt: async () => {}, beginRun: async () => {},
  castForPage: () => [], castTextOf: () => '', castListOf: () => [],
  loadPageRefs: async () => ({ refs: [], cropUsed: [], cropMissed: [] }),
  spendCapHit: async () => 0, MAX_ROLLS: 2, castGateVerdict: forbidden, heldPages: forbidden, rebuildEditorChapters: async () => {},
}));
mock.module('../factory/src/gateway', () => ({ gatewayConfigured: () => { if (failure === 'exception') throw new Error('gateway broke'); return failure === 'cap'; }, generateGatewayImageMetered: forbidden, colorizeExtra: () => '' }));
mock.module('../factory/src/budget', () => ({ budgetGate: forbidden }));
mock.module('../factory/src/ai', () => ({ qcColorImage: forbidden, qcColorImageDetailed: forbidden }));
mock.module('../factory/src/events', () => ({ emitEvent: async () => {} }));
mock.module('../factory/src/editions', () => ({ recordEdition: async () => {} }));
mock.module('../factory/src/visualpass', () => ({ runVisualPass: async () => ({ defects: [], checked: 2 }) }));
mock.module('../factory/src/versioning', () => ({ snapshotIfChanged: async () => {} }));
mock.module('../factory/src/matter', () => ({ composeMatter: forbidden }));
const { ColorizeWorkflow } = await import('../factory/src/colorize');

test.each(['gateway', 'exception', 'cap'] as const)('failed color generation (%s) holds without installing an edition', async mode => {
  failure = mode;
  const f = fixture(); const writes: string[] = [];
  const bucket: any = { ...f.bucket, async put(key: string, value: any) { writes.push(key); f.put(key, value); } };
  const instance: any = new ColorizeWorkflow({} as any, {} as any);
  instance.env = { BOOKS: bucket, DB: { prepare() { return { bind() { return { run: async () => ({}) }; } }; } } };
  const step: any = { do: async (_name: string, ...args: any[]) => args.at(-1)() };
  await expect(instance.run({ payload: { slug: 'test', force: true }, instanceId: 'offline', timestamp: new Date(0) } as any, step)).rejects.toThrow();
  const plan = JSON.parse(new TextDecoder().decode(f.values.get('books/test/plans/S1.json')!.bytes));
  expect(plan.pages[0].colorHeld).toBe(true);
  if (mode !== 'exception') expect(plan.finale.colorHeld).toBe(true);
  expect(writes.some(key => key.endsWith('.pdf'))).toBe(false);
});
