import { normalizeBible } from './bible-normalization';
import { sha256Hex } from './sha256';
import { captureBookRevision, readPlanInventory, revisionHash, type RevisionPage, type BookRevision, type RevisionArtifact } from './book-revision';

export const bytesHash = (bytes: Uint8Array) => sha256Hex(bytes);
const stateFields = new Set(['imageKey', 'imageColorKey', 'held', 'heldReason', 'colorHeld', 'colorHeldReason', 'lineIdentity', 'colorIdentity']);
/** Derived from existing source. Runtime state must not make this self-referential. */
export function pageSourceRevision(bible: any, plan: any, page: any): string {
  return revisionHash({ bible: normalizeBible(bible), chapterTitle: plan.storyTitle ?? null,
    page: Object.fromEntries(Object.entries(page).filter(([key]) => !stateFields.has(key))) });
}
export function stampLine(bible: any, plan: any, page: any, bytes: Uint8Array) {
  page.lineIdentity = { revision: pageSourceRevision(bible, plan, page), sha256: bytesHash(bytes) };
}
export function stampColor(bible: any, plan: any, page: any, line: Uint8Array, color: Uint8Array) {
  page.colorIdentity = { revision: pageSourceRevision(bible, plan, page), lineSha256: bytesHash(line), sha256: bytesHash(color) };
  delete page.colorHeld; delete page.colorHeldReason;
}
export function holdColor(page: any, reason: string) { page.colorHeld = true; page.colorHeldReason = reason; }

/** Shared with colorize's skip check; adoption never invokes generation. */
export function colorIdentityCurrent(bible: any, plan: any, page: any, lineSha256: string, colorSha256: string) {
  const revision = pageSourceRevision(bible, plan, page);
  return !page.held && !page.colorHeld && page.lineIdentity?.revision === revision && page.lineIdentity?.sha256 === lineSha256
    && page.colorIdentity?.revision === revision && page.colorIdentity?.lineSha256 === lineSha256 && page.colorIdentity?.sha256 === colorSha256;
}

export interface VerifiedAssemblyInput {
  inventory: Awaited<ReturnType<typeof readPlanInventory>>;
  manifest: BookRevision;
  observations: { key: string; etag: string }[];
}

/** Reuse a byte-verified revision, never a client-provided assertion. All object
 * versions are still checked by the approval writer before recording a mark. */
function assemblyInputFromRevision(verified: VerifiedAssemblyInput, slug: string, targets: { key: string; role: string }[]) {
  const { revision, ...payload } = verified.manifest;
  if (verified.manifest.slug !== slug || revisionHash(payload) !== revision || revisionHash(verified.inventory.pages) !== revisionHash(verified.manifest.pages))
    throw new Error('Captured revision does not match assembly inventory');
  const artifacts = new Map<string, RevisionArtifact>();
  for (const source of verified.inventory.sources) {
    const original = verified.manifest.artifacts.find(a => a.key === source.key);
    if (!original || original.sha256 !== bytesHash(source.bytes) || original.bytes !== source.bytes.length)
      throw new Error(`Source changed since capture: ${source.key}`);
    artifacts.set(source.key, { ...original, role: source.role });
  }
  for (const target of [...verified.inventory.pages.flatMap(p => [
    { key: p.lineKey, role: 'line-art' }, ...(p.colorKey ? [{ key: p.colorKey, role: 'color-art' }] : [])
  ]), ...targets]) {
    if (artifacts.has(target.key)) continue;
    const original = verified.manifest.artifacts.find(a => a.key === target.key);
    if (!original || !original.bytes || !verified.observations.some(o => o.key === target.key && o.etag))
      throw new Error(`Artifact is not byte-verified in captured revision: ${target.key}`);
    artifacts.set(target.key, { ...original, role: target.role });
  }
  const input = { schema: 'book-revision/v1' as const, slug, pages: verified.inventory.pages,
    artifacts: [...artifacts.values()].sort((a, b) => a.key.localeCompare(b.key)) };
  return { manifest: { ...input, revision: revisionHash(input) }, observations: verified.observations.filter(o => artifacts.has(o.key)) };
}

export async function prepareAssembly(books: any, slug: string, edition: 'line' | 'color', verified?: VerifiedAssemblyInput) {
  const inventory = verified?.inventory ?? await readPlanInventory(books, slug);
  const bible = JSON.parse(new TextDecoder().decode(inventory.sources[0].bytes));
  const plans = new Map(inventory.sources.filter(s => s.role === 'plan').map(s => [s.key, JSON.parse(new TextDecoder().decode(s.bytes))]));
  for (const [key, plan] of plans) if (!plan.finale) throw new Error(`Required chapter finale missing: ${key}`);
  const targets = [];
  for (const file of ['cover.jpg', 'cover-titled.jpg', 'back-cover-color.jpg', 'back-cover-line.jpg']) {
    const key = `books/${slug}/${file}`;
    if (await books.head(key)) targets.push({ key, role: file });
    else if (file !== 'cover-titled.jpg') throw new Error(`Required assembly artifact missing: ${key}`);
  }
  const captured = verified ? assemblyInputFromRevision(verified, slug, targets) : await captureBookRevision(books, slug, targets, inventory);
  const entries = inventory.pages.map(ref => {
    const plan = plans.get(ref.planKey);
    const page = ref.kind === 'finale' ? plan.finale : plan.pages[ref.page];
    const revision = pageSourceRevision(bible, plan, page);
    if (page.held) throw new Error(`${ref.id}: held line page blocks assembly (${page.heldReason ?? "review required"})`);
    const line = captured.manifest.artifacts.find(a => a.key === ref.lineKey)!;
    if (page.lineIdentity?.revision !== revision || page.lineIdentity?.sha256 !== line.sha256)
      throw new Error(`${ref.id}: stale or unverifiable line artifact revision`);
    if (edition === 'color') {
      if (page.colorHeld) throw new Error(`${ref.id}: color-held page blocks assembly (${page.colorHeldReason ?? "review required"})`);
      const color = captured.manifest.artifacts.find(a => a.key === ref.colorKey);
      if (!color || page.colorIdentity?.revision !== revision || page.colorIdentity?.sha256 !== color.sha256 || page.colorIdentity?.lineSha256 !== line.sha256)
        throw new Error(`${ref.id}: missing, stale or unverifiable color twin`);
    }
    return { ref, page };
  });
  return { ...captured, slug, edition, bible, entries,
    toc: [...plans.values()].map((plan, i) => plan.storyTitle ?? `S${i + 1}`) };
}
export type AssemblySnapshot = Awaited<ReturnType<typeof prepareAssembly>>;
export async function loadAssemblyPage(books: any, snapshot: AssemblySnapshot, entry: { ref: RevisionPage }) {
  const key = snapshot.edition === 'color' ? entry.ref.colorKey : entry.ref.lineKey;
  const artifact = snapshot.manifest.artifacts.find(a => a.key === key);
  const obj = key && await books.get(key);
  if (!obj || !artifact) throw new Error(`${entry.ref.id}: required assembly artifact missing`);
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if (bytesHash(bytes) !== artifact.sha256) throw new Error(`${entry.ref.id}: assembly artifact changed`);
  return bytes;
}
export async function assertAssemblyCurrent(books: any, snapshot: AssemblySnapshot) {
  const latest = await prepareAssembly(books, snapshot.slug, snapshot.edition);
  if (latest.manifest.revision !== snapshot.manifest.revision) throw new Error('Assembly revision changed while building PDF');
}
