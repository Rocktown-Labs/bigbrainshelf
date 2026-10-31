import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { resolveBookForPublicRoute, publicSlugFor } from "../../../../../lib/public-slugs";
import { deliverableList } from "../../../../../lib/deliverables";
import { buildStoredZip, type ZipEntry } from "../../../../../lib/zip-store";

// GET /api/admin/books/{slug}/bundle
// The book's full deliverables as one ZIP (CG, 2026-10-31): the
// same canonical list the readiness page shows. Missing files
// are skipped, never faked; an empty book 404s. Admin-gated by
// the middleware like every /api/admin route.
export const GET: APIRoute = async ({ params }) => {
  const e = env as any;
  const param = String(params.slug || "");
  const resolved = await resolveBookForPublicRoute(e.DB, param).catch(() => null);
  if (!resolved) return new Response("book not found", { status: 404 });
  const book = resolved.book as any;
  const slug = String(book.slug);

  const entries: ZipEntry[] = [];
  for (const d of deliverableList(book, slug)) {
    const obj = await e.BOOKS.get(d.key).catch(() => null);
    if (!obj) continue;
    entries.push({ name: d.name, data: new Uint8Array(await obj.arrayBuffer()) });
  }
  if (!entries.length) return new Response("no deliverables yet", { status: 404 });

  const zip = buildStoredZip(entries);
  return new Response(zip.buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${publicSlugFor(book)}-bundle.zip"`,
      "Content-Length": String(zip.length),
    },
  });
};
