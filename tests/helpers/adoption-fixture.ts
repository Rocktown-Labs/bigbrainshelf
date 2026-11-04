import { fixture } from './identity-fixture';
import { bytesHash } from '../../packages/core/src/assembly-identity';
export function legacy() {
  const f = fixture();
  for (const p of [...f.plan.pages, f.plan.finale]) { delete p.lineIdentity; delete p.colorIdentity; }
  f.save();
  const rows = [0, 1].map((i) => ({ page: i ? 'S1 finale' : 'S1p0', key: `books/test/images/S1-${i ? 'finale' : 'page-0'}.jpg`, sha256: bytesHash(new TextEncoder().encode('LINE')), bytes: 4 }));
  const inventory = { slug: 'test', chapters_found: ['S1'], planned_pages: 2, planned_story_pages: 1, line_images: 2, color_images: 2, pdf_pages: {} };
  const line = { slug: 'test', edition: 'line', results: rows };
  const color = { slug: 'test', edition: 'color', results: rows.map(r => ({ ...r, key: r.key.replace('/images/', '/images-color/'), bytes: 5, sha256: bytesHash(new TextEncoder().encode('COLOR')), lineSha256: r.sha256 })) };
  const evidence = { inventory: JSON.stringify(inventory), line: JSON.stringify(line), color: JSON.stringify(color), bookQa: JSON.stringify({ slug: 'test', measured_at: 1, source: 'offline fixture', line_purity: 0 }) };
  for (const [role, value] of Object.entries(evidence)) if (role !== 'bookQa') f.put(`books/test/audit/${role === 'inventory' ? 'inventory' : `cast-audit-${role}`}.json`, value);
  const writes: string[] = [];
  const bucket: any = { ...f.bucket, put: async (key: string, bytes: any, opts: any) => {
    if (f.values.get(key)?.version !== opts.onlyIf.etagMatches) return null;
    writes.push(key); f.put(key, bytes); return { etag: f.values.get(key)!.version };
  } };
  const journal: any[] = [];
  return { ...f, bucket, evidence, writes, journal, log: async (event: any) => { journal.push(event); } };
}
