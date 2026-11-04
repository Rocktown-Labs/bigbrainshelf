import { createSha256, digestHex, sha256Hex } from './sha256';

/** Shared by the hub and factory. This is derived evidence, never authored state. */
export interface RevisionPage {
  id: string;
  chapter: number;
  page: number; // viewer index; the finale follows the ordinary pages
  kind: 'story' | 'finale';
  planKey: string;
  lineKey: string;
  colorKey: string | null;
}
export interface RevisionArtifact {
  key: string;
  role: string;
  bytes: number;
  sha256: string;
}
export interface BookRevision {
  schema: 'book-revision/v1';
  slug: string;
  pages: RevisionPage[];
  artifacts: RevisionArtifact[];
  revision: string;
}

function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function revisionHash(value: unknown): string {
  return sha256Hex(new TextEncoder().encode(canonical(value)));
}

export async function readPlanInventory(books: any, slug: string): Promise<{
  pages: RevisionPage[];
  sources: { key: string; role: string; bytes: Uint8Array; etag: string }[];
}> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error('Invalid book identifier.');
  const prefix = `books/${slug}/`;
  const sources: { key: string; role: string; bytes: Uint8Array; etag: string }[] = [];
  async function readJson(key: string, role: string) {
    const obj = await books.get(key);
    if (!obj) throw new Error(`Required source missing: ${key}`);
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const data = JSON.parse(new TextDecoder().decode(bytes));
    sources.push({ key, role, bytes, etag: obj.etag });
    return data;
  }
  const bible = await readJson(`${prefix}bible.json`, 'bible');
  if (!Array.isArray(bible?.conceptLadder) || !bible.conceptLadder.length)
    throw new Error('A nonempty bible chapter inventory is required.');
  const expected = bible.conceptLadder.map((_: unknown, i: number) => `${prefix}plans/S${i + 1}.json`);
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await books.list({ prefix: `${prefix}plans/`, cursor });
    for (const obj of result.objects) if (/\/S\d+\.json$/.test(obj.key)) found.push(obj.key);
    if (result.truncated && (!result.cursor || result.cursor === cursor)) throw new Error('Invalid plan pagination.');
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);
  if (found.length !== expected.length || expected.some((key: string) => !found.includes(key)))
    throw new Error('Stored chapter plans do not match the bible chapter inventory.');
  const pages: RevisionPage[] = [];
  for (const [index, planKey] of expected.entries()) {
    const plan = await readJson(planKey, 'plan');
    if (!Array.isArray(plan?.pages) || !plan.pages.length) throw new Error(`Empty or invalid plan: ${planKey}`);
    const entries: { pg: any; i: number; kind: RevisionPage['kind'] }[] =
      plan.pages.map((pg: any, i: number) => ({ pg, i, kind: 'story' }));
    if (plan.finale == null) throw new Error(`Required chapter finale missing: ${planKey}`);
    if (plan.finale != null) entries.push({ pg: plan.finale, i: plan.pages.length, kind: 'finale' });
    for (const { pg, i, kind } of entries) {
      if (!pg || typeof pg.storyText !== 'string' || !pg.storyText.trim())
        throw new Error(`Missing story text: ${planKey} page ${i}`);
      const stem = `S${index + 1}-${kind === 'finale' ? 'finale' : `page-${i}`}.jpg`;
      const lineKey = pg.imageKey ?? `${prefix}images/${stem}`;
      const colorKey = pg.imageColorKey ?? null;
      for (const key of [lineKey, colorKey].filter(Boolean)) {
        if (typeof key !== 'string' || !key.startsWith(prefix) || key.includes('..'))
          throw new Error(`Invalid artifact key in ${planKey}`);
      }
      pages.push({ id: `S${index + 1}:${kind === 'finale' ? 'finale' : i}`, chapter: index + 1,
        page: i, kind, planKey, lineKey, colorKey });
    }
  }
  return { pages, sources };
}

/** Streaming hash avoids buffering an entire audiobook/PDF in the Worker. */
async function hashObject(obj: any): Promise<{ bytes: number; sha256: string }> {
  const hash = createSha256();
  let bytes = 0;
  if (obj.body) {
    const reader = obj.body.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        hash.update(chunk.value);
      }
    } finally { reader.releaseLock(); }
  } else {
    const data = new Uint8Array(await obj.arrayBuffer());
    bytes = data.byteLength;
    hash.update(data);
  }
  if (!bytes) throw new Error('Empty revision artifact.');
  return { bytes, sha256: digestHex(hash.digest()) };
}

export async function captureBookRevision(
  books: any, slug: string, deliverables: { key: string; role: string }[],
  providedInventory?: Awaited<ReturnType<typeof readPlanInventory>>
): Promise<{ manifest: BookRevision; observations: { key: string; etag: string }[] }> {
  const inventory = providedInventory ?? await readPlanInventory(books, slug);
  const artifacts = new Map<string, RevisionArtifact>();
  const observations: { key: string; etag: string }[] = [];
  for (const source of inventory.sources) {
    if (!source.etag) throw new Error(`Source version unavailable: ${source.key}`);
    artifacts.set(source.key, { key: source.key, role: source.role, bytes: source.bytes.length,
      sha256: sha256Hex(source.bytes) });
    observations.push({ key: source.key, etag: source.etag });
  }
  const targets = [...inventory.pages.flatMap(p => [
    { key: p.lineKey, role: 'line-art' }, ...(p.colorKey ? [{ key: p.colorKey, role: 'color-art' }] : [])
  ]), ...deliverables];
  for (const target of targets) {
    if (!target.key.startsWith(`books/${slug}/`) || target.key.includes('..')) throw new Error('Artifact outside book namespace.');
    if (artifacts.has(target.key)) continue;
    const obj = await books.get(target.key);
    if (!obj || !obj.etag) throw new Error(`Required artifact missing or unversioned: ${target.key}`);
    artifacts.set(target.key, { ...target, ...await hashObject(obj) });
    observations.push({ key: target.key, etag: obj.etag });
  }
  const payload = { schema: 'book-revision/v1' as const, slug, pages: inventory.pages,
    artifacts: [...artifacts.values()].sort((a, b) => a.key.localeCompare(b.key)) };
  return { manifest: { ...payload, revision: revisionHash(payload) }, observations };
}

/** Detects changes during capture/checking. Atomic release pointers come in the assembly slice. */
export async function assertRevisionUnchanged(books: any, observations: { key: string; etag: string }[]) {
  for (const seen of observations) {
    const current = await books.head(seen.key);
    if (!current || current.etag !== seen.etag) throw new Error(`Artifact changed during verification: ${seen.key}`);
  }
}
