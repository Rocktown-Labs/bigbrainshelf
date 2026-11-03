// ------------------------------------------------------- edition manifests
//
// Every assembled edition gets a manifest: the artifact keys, their
// sizes and SHA-256 hashes, and the hash of the previous edition's
// manifest (parent_hash), forming a verifiable chain per book and
// edition kind. Landed 2026-11-01 from the merged factory-scale plan
// (step 7). Manifests live at books/{slug}/editions/{edition}-{ts}.json
// in R2 with a row in D1 editions. Best-effort like all factory
// bookkeeping: a manifest failure never blocks an assembly.

import { emitEvent } from "./events";

export interface EditionArtifact {
  key: string;
  role: string;
}

let tableReady = false;

async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", buf as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function recordEdition(
  env: any,
  slug: string,
  edition: string,
  artifacts: EditionArtifact[]
): Promise<{ manifestKey: string; hash: string; parentHash: string | null } | null> {
  try {
    if (!tableReady) {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS editions (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT, edition TEXT, manifest_key TEXT, hash TEXT, parent_hash TEXT, created_at INTEGER)"
      ).run();
      tableReady = true;
    }
    const parent: any = await env.DB.prepare(
      "SELECT hash FROM editions WHERE slug=? AND edition=? ORDER BY id DESC LIMIT 1"
    )
      .bind(slug, edition)
      .first();
    const parentHash: string | null = parent?.hash ?? null;

    const entries: any[] = [];
    for (const a of [...artifacts].sort((x, y) => x.key.localeCompare(y.key))) {
      const obj = await env.BOOKS.get(a.key);
      if (!obj) {
        entries.push({ key: a.key, role: a.role, missing: true });
        continue;
      }
      const bytes = await obj.arrayBuffer();
      entries.push({ key: a.key, role: a.role, bytes: bytes.byteLength, sha256: await sha256Hex(bytes) });
    }

    const ts = Math.floor(Date.now() / 1000);
    const manifest = { slug, edition, created_at: ts, parent_hash: parentHash, artifacts: entries };
    const manifestJson = JSON.stringify(manifest, null, 1);
    const hash = await sha256Hex(manifestJson);
    const manifestKey = `books/${slug}/editions/${edition}-${ts}.json`;
    await env.BOOKS.put(manifestKey, manifestJson, {
      httpMetadata: { contentType: "application/json" },
    });
    await env.DB.prepare(
      "INSERT INTO editions (slug, edition, manifest_key, hash, parent_hash, created_at) VALUES (?,?,?,?,?,?)"
    )
      .bind(slug, edition, manifestKey, hash, parentHash, ts)
      .run();
    await emitEvent(env, {
      slug,
      kind: "edition",
      event: "edition_recorded",
      detail: { edition, manifestKey, hash, parentHash, artifacts: entries.length },
    });
    return { manifestKey, hash, parentHash };
  } catch (e) {
    console.log(`recordEdition failed for ${slug}/${edition}: ${String((e as any)?.message ?? e)}`);
    return null;
  }
}

// The standard artifact set for a book's base (line) edition and its
// color edition, used by the backfill route.
export function standardArtifacts(slug: string, edition: string): EditionArtifact[] {
  if (edition === "color") {
    return [{ key: `books/${slug}/picture-book-color.pdf`, role: "color_picture_book_pdf" }];
  }
  return [
    { key: `books/${slug}/picture-book.pdf`, role: "picture_book_pdf" },
    { key: `books/${slug}/coloring-book.pdf`, role: "coloring_book_pdf" },
    { key: `books/${slug}/cover.jpg`, role: "cover" },
  ];
}
