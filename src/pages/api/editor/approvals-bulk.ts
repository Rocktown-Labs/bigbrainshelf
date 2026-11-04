import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { ApprovalIdentityError, captureApprovalRevision, saveApprovals } from '../../../lib/approval-identity';

export const POST: APIRoute = async ({ request, locals }) => {
  const e = env as any;
  const b = await request.json().catch(() => ({}));
  const slug = String(b.book_slug || '');
  if (!slug) return Response.json({ ok: false, error: 'book_slug required' }, { status: 400 });
  let snapshot;
  try { snapshot = await captureApprovalRevision(e.DB, e.BOOKS, slug); }
  catch {
    return Response.json({ ok: false, code: 'INVENTORY_UNVERIFIED',
      error: 'Book inventory or artifact identity could not be verified. No approvals were changed. Check the book plans and artifacts and retry.' }, { status: 409 });
  }
  if (b.revision !== snapshot.manifest.revision) return Response.json({ ok: false, error: 'Book changed or review identity is missing. Reload and review before approving.' }, { status: 409 });
  if (typeof b.approved !== 'boolean') return Response.json({ ok: false, error: 'approved must be explicitly true or false' }, { status: 400 });
  const approved = b.approved;
  try { await saveApprovals(e.DB, e.BOOKS, snapshot, snapshot.manifest.pages, approved, locals?.user?.id ?? null); }
  catch (error) {
    if (error instanceof ApprovalIdentityError) return Response.json({ ok: false, code: 'ARTIFACT_UNVERIFIED', error: error.message }, { status: 409 });
    return Response.json({ ok: false, code: 'APPROVAL_SAVE_UNCONFIRMED',
      error: 'Approval changes could not be confirmed. Reload the book before retrying.' }, { status: 503 });
  }
  return Response.json({ ok: true, pages: snapshot.manifest.pages.length, approved, revision: snapshot.manifest.revision });
};
