import { stampLine, stampColor } from '../../packages/core/src/assembly-identity';
export function fixture() {
  const values = new Map<string, { bytes: Uint8Array; version: string; metadata?: any }>();
  let serial = 0;
  function put(key: string, value: unknown, metadata?: any) { values.set(key, { bytes: value instanceof Uint8Array ? value : new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)), version: String(++serial), metadata }); }
  const bible = { bookTitle: 'Test', conceptLadder: [{}] };
  const plan: any = { storyTitle: 'One', pages: [{ storyText: 'Story', imagePrompt: 'draw' }], finale: { storyText: 'Finale', imagePrompt: 'finale' } };
  for (const [pg, stem] of [[plan.pages[0], 'page-0'], [plan.finale, 'finale']] as const) {
    stampLine(bible, plan, pg, new TextEncoder().encode('LINE'));
    pg.imageColorKey = `books/test/images-color/S1-${stem}.jpg`;
    stampColor(bible, plan, pg, new TextEncoder().encode('LINE'), new TextEncoder().encode('COLOR'));
    put(`books/test/images/S1-${stem}.jpg`, 'LINE'); put(pg.imageColorKey, 'COLOR');
  }
  const save = () => { put('books/test/bible.json', bible); put('books/test/plans/S1.json', plan); };
  save();
  for (const name of ['cover.jpg', 'back-cover-color.jpg', 'back-cover-line.jpg']) put(`books/test/${name}`, 'COVER');
  const bucket = {
    async get(key: string) { const v = values.get(key); return v ? { etag: v.version, arrayBuffer: async () => v.bytes.slice().buffer } : null; },
    async head(key: string) { const v = values.get(key); return v ? { etag: v.version, customMetadata: v.metadata } : null; },
    async list({ prefix }: any) { return { objects: [...values.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false }; },
  };
  return { bible, plan, save, put, values, bucket };
}

import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
export function identityDatabase() {
  const raw = new Database(':memory:');
  raw.exec("CREATE TABLE books (slug TEXT); INSERT INTO books VALUES ('test');");
  raw.exec(readFileSync(new URL('../../db/migrations/0002_artifact_approvals.sql', import.meta.url), 'utf8'));
  const db: any = { prepare(sql: string) { let values: any[] = []; const s = { bind(...args: any[]) { values = args; return s; }, async first() { return raw.query(sql).get(...values); }, async all() { return { results: raw.query(sql).all(...values) }; }, run: async () => raw.query(sql).run(...values), execute: () => raw.query(sql).run(...values) }; return s; }, async batch(statements: any[]) { return raw.transaction(() => statements.map(s => s.execute()))(); } };
  return { raw, db };
}
