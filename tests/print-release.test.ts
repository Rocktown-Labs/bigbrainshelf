import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { releaseBucket, seedPrintReleases } from './helpers/release-fixture';
import { releasedPrintable, recordPrintReleaseItem, verifyPrintReleaseItem, openPrintReleaseFile } from '../src/lib/print-release';
import { captureApprovalRevision } from '../src/lib/approval-identity';
import { fixture as identityFixture, identityDatabase } from './helpers/identity-fixture';

async function setup() {
  const raw = new Database(':memory:');
  const db: any = { prepare(sql: string) { let values: any[] = []; const stmt = { bind(...v: any[]) { values = v; return stmt; }, first: async () => raw.query(sql).get(...values), all: async () => ({ results: raw.query(sql).all(...values) }), run: async () => raw.query(sql).run(...values) }; return stmt; } };
  const objects = new Map<string, Uint8Array>(); const books = releaseBucket(objects);
  await seedPrintReleases(raw,db,books,objects);
  const slug = 'mira-the-heron-and-the-still-water';
  const p = await releasedPrintable(db,books,slug,'story');
  const item = { id: 'item-one', slug, kind: 'story', interiorKey: p.interiorKey, coverKey: p.coverKey, podPackageId: p.podPackageId, interiorPages: p.interiorPages, personalized: false };
  return { raw, db, objects, books, p, item };
}

test('a print item resolves frozen masters and keeps its release after head or registry edits', async () => {
  const f = await setup(); await recordPrintReleaseItem(f.db,f.item.id,f.p,null);
  f.raw.exec("UPDATE printables SET interior_key = 'books/live-change.pdf', interior_pages = 999; DELETE FROM artifact_release_heads;");
  expect((await verifyPrintReleaseItem(f.db,f.books,f.item)).interiorKey).toBe(f.p.interiorKey);
});

test('unbound legacy jobs, changed masters, changed recipe and cross-item derivatives fail closed', async () => {
  for (const fault of ['legacy', 'master', 'recipe', 'derivative']) {
    const f = await setup();
    if (fault !== 'legacy') await recordPrintReleaseItem(f.db,f.item.id,f.p,null);
    if (fault === 'master') f.objects.set(f.p.coverKey,new TextEncoder().encode('tamper'));
    if (fault === 'recipe') f.item.podPackageId = 'different-package';
    if (fault === 'derivative') { f.item.interiorKey = `books/${f.item.slug}/print/personalized/another-item.pdf`; f.item.personalized = true; }
    await expect(verifyPrintReleaseItem(f.db,f.books,f.item)).rejects.toThrow();
  }
});

test('personalized print files remain mutable with explicit frozen-master lineage', async () => {
  const f = await setup(); const derivative = `books/${f.item.slug}/print/personalized/${f.item.id}.pdf`;
  await recordPrintReleaseItem(f.db,f.item.id,f.p,derivative);
  f.item.interiorKey = derivative; f.item.interiorPages++; f.item.personalized = true;
  f.raw.query('INSERT INTO print_job_items (id,job_id,external_id,slug,kind,interior_key,cover_key,pod_package_id,interior_pages,personalized,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(f.item.id,'job-one','external-one',f.item.slug,f.item.kind,derivative,f.item.coverKey,f.item.podPackageId,f.item.interiorPages,1,0,0);
  const token = { jobId: 'job-one', jobItemId: f.item.id, r2Key: derivative };
  for (const text of ['NAME ONE', 'NAME TWO']) {
    f.objects.set(derivative,new TextEncoder().encode(text));
    expect(new TextDecoder().decode(await (await openPrintReleaseFile(f.db,f.books,token)).arrayBuffer())).toBe(text);
  }
  await expect(openPrintReleaseFile(f.db,f.books,{...token,r2Key:'books/other.pdf'})).rejects.toThrow();
});

test('registered print bytes and recipe changes invalidate the approval revision', async () => {
  const f = identityFixture(); const { db, raw } = identityDatabase();
  raw.exec('CREATE TABLE printables (slug TEXT,kind TEXT,pod_package_id TEXT,interior_pages INTEGER,interior_key TEXT,cover_key TEXT,validation_status TEXT)');
  const before = await captureApprovalRevision(db,f.bucket,'test');
  f.put('books/test/print/interior.pdf','PRINT'); f.put('books/test/print/cover.pdf','COVER');
  raw.exec("INSERT INTO printables VALUES ('test','story','package',43,'books/test/print/interior.pdf','books/test/print/cover.pdf','NORMALIZED')");
  const added = await captureApprovalRevision(db,f.bucket,'test');
  expect(added.manifest.revision).not.toBe(before.manifest.revision);
  expect(added.manifest.printables?.[0].interiorPages).toBe(43);
  f.put('books/test/print/interior.pdf','OTHER');
  const edited = await captureApprovalRevision(db,f.bucket,'test');
  expect(edited.manifest.revision).not.toBe(added.manifest.revision);
  raw.exec("UPDATE printables SET pod_package_id='new-package'");
  expect((await captureApprovalRevision(db,f.bucket,'test')).manifest.revision).not.toBe(edited.manifest.revision);
});
