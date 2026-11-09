import { openPrintReleaseFile } from "../../../lib/print-release";
import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { resolvePrintFileToken } from "../../../lib/print-fulfillment";

// GET /api/print-file/{token}
//
// The one door Lulu fetches print files through. The token is the
// credential: an unguessable UUID minted per file when a print job
// is dispatched (lib/print-fulfillment), good for 7 days, mapped to
// exactly one R2 object. Unknown or expired tokens are a plain 404,
// and nothing about the book, the order, or the buyer is in the URL.
// The entitlement-gated buyer download route is never used for this.
export const GET: APIRoute = async ({ params }) => {
  const e = env as any;
  const token = String(params.token || "");
  const resolved = await resolvePrintFileToken(e.DB, token).catch(() => null);
  if (!resolved) return new Response("Not found", { status: 404 });
  const obj = await openPrintReleaseFile(e.DB, e.BOOKS, resolved).catch(() => null);
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/pdf",
      "Cache-Control": "private, no-store",
    },
  });
};
