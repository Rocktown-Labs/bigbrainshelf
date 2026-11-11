import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { captureApprovalRevision } from '../../../lib/approval-identity';
import { assessColorEdition, getSignoffStates, recordSignoff, type SignoffKind } from '../../../lib/qc-signoffs';

// QC sign-offs: GET returns the two sign-off states for the revision
// the QC viewer loaded; POST records one attestation against that
// exact revision (a stale tab gets a 409, the approvals rule). The
// color sign-off refuses to record while the color edition is
// incomplete OR out of date: sign-off order is review the lines,
// colorize, then review the color, so there must be a complete,
// current color edition to have read.

export const GET: APIRoute = async ({ url }) => {
  const e = env as any;
  const slug = url.searchParams.get('book_slug') || '';
  try {
    const snapshot = await captureApprovalRevision(e.DB, e.BOOKS, slug);
    const states = await getSignoffStates(e.DB, slug, snapshot.manifest.revision, assessColorEdition(snapshot.manifest));
    return Response.json({ revision: snapshot.manifest.revision, ...states });
  } catch {
    return Response.json({ error: 'Sign-off identity is unverified. Reload after the artifacts are available.' }, { status: 409 });
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const e = env as any;
  const b = await request.json().catch(() => ({}));
  const kind = String(b.kind || '') as SignoffKind;
  if (kind !== 'story' && kind !== 'color') return Response.json({ error: 'kind must be story or color' }, { status: 400 });
  let snapshot;
  try { snapshot = await captureApprovalRevision(e.DB, e.BOOKS, String(b.book_slug || '')); }
  catch { return Response.json({ error: 'Book inventory or artifacts could not be verified.' }, { status: 409 }); }
  if (b.revision !== snapshot.manifest.revision) return Response.json({ error: 'Book changed or review identity is missing. Reload and review before signing off.' }, { status: 409 });
  if (kind === 'color') {
    const edition = assessColorEdition(snapshot.manifest);
    if (edition.state === 'incomplete')
      return Response.json({ error: 'The color edition is incomplete, so the full color sign-off is not available yet.' }, { status: 409 });
    if (edition.state === 'stale')
      return Response.json({ error: 'The color edition is out of date: some color pages are older than the line pages they were colored from. Re-run colorize so every color page is current, then sign off.' }, { status: 409 });
    if (edition.state === 'unknown')
      return Response.json({ error: 'The color edition could not be verified as current, so the full color sign-off is not available yet.' }, { status: 409 });
  }
  try { await recordSignoff(e.DB, snapshot.manifest.slug, kind, snapshot.manifest.revision, locals?.user?.id ?? null); }
  catch { return Response.json({ error: 'Sign-off could not be recorded. Reload before retrying.' }, { status: 503 }); }
  const states = await getSignoffStates(e.DB, snapshot.manifest.slug, snapshot.manifest.revision, assessColorEdition(snapshot.manifest));
  return Response.json({ ok: true, revision: snapshot.manifest.revision, ...states });
};
