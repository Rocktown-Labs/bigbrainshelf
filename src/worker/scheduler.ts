// Cloudflare `scheduled` handler for the hub worker (Book Club V2).
//
// This module is bundled on its own by scripts/prepare-worker-entry.mjs
// into dist/server/club-scheduler.mjs, and the generated
// dist/server/worker.mjs wraps the Astro entry's fetch handler with
// this scheduled handler. Bundling the scheduler separately keeps the
// scheduled bundle's module graph exactly what the tests exercise:
// src/lib/club-scheduler.ts and its imports, nothing from Astro.

import { runScheduledWork } from "../lib/club-scheduler";

export async function handleScheduled(env: any): Promise<void> {
  const summary = await runScheduledWork(env.DB, env);
  console.log("scheduled work done", JSON.stringify(summary));
}
