import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import { getReleaseAnnouncementStatus } from '../../../lib/releases';

// Release announcement status for the admin Books page. Gated by the
// middleware's admin session like every /api/admin route.
//
// GET -> { releases: [{ slug, title, publishedAt, publishedLabel,
//          club: { queued, sent, suppressed },
//          public: { queued, sent, suppressed } }] }
// One entry per published book that carries a published_at stamp,
// newest first. Counts come from the email outbox rows the publish
// action enqueued (dedupe_key release:{slug}:{wave}:{email}).
export const GET: APIRoute = async () => {
  const e = env as any;
  const releases = await getReleaseAnnouncementStatus(e.DB);
  return Response.json({ releases });
};
