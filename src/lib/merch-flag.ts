// Merch visibility flag (CG, 2026-11-07): the /merch route stays
// dark until the art-print lane (Prodigi) is ready to sell. The
// placeholder products in src/data/merch.ts are not a live offer,
// so the route 404s and the routes bar drops its Merch entry while
// the flag is off. Set the MERCH_ENABLED worker secret/var to
// "true" to bring the route back; nothing else changes.
import { env } from "cloudflare:workers";

export function merchEnabled(): boolean {
  try {
    return String((env as any).MERCH_ENABLED || "").trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}
