import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { ApprovalIdentityError, captureApprovalRevision, approvedPages, approvalTargets, saveApprovals } from '../../../lib/approval-identity';

export const GET: APIRoute = async ({ url }) => {
  const e = env as any;
  const slug = url.searchParams.get('book_slug') || 'docker';
  try {
    const snapshot = await captureApprovalRevision(e.DB, e.BOOKS, slug);
    const rows = await approvedPages(e.DB, snapshot.manifest, true);
    return Response.json(approvalTargets(snapshot.manifest).map(p => ({ chapterNum: p.chapter, pageIndex: p.page,
      approved: rows.some((r: any) => r.chapter_num === p.chapter && r.page_index === p.page), revision: snapshot.manifest.revision })));
  } catch {
    return Response.json({ error: 'Approval identity is unverified. Reload after the artifacts are available.' }, { status: 409 });
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const e = env as any;
  const b = await request.json().catch(() => ({}));
  let snapshot;
  try { snapshot = await captureApprovalRevision(e.DB, e.BOOKS, String(b.book_slug || '')); }
  catch { return Response.json({ error: 'Book inventory or artifacts could not be verified.' }, { status: 409 }); }
  if (b.revision !== snapshot.manifest.revision) return Response.json({ error: 'Book changed or review identity is missing. Reload and review before approving.' }, { status: 409 });
  if (typeof b.approved !== 'boolean') return Response.json({ error: 'approved must be explicitly true or false' }, { status: 400 });
  const page = approvalTargets(snapshot.manifest).find(p => p.chapter === b.chapterNum && p.page === b.pageIndex);
  if (!page) return Response.json({ error: 'Page is outside the current inventory.' }, { status: 400 });
  try { await saveApprovals(e.DB, e.BOOKS, snapshot, [page], !!b.approved, locals?.user?.id ?? null); }
  catch (error) {
    if (error instanceof ApprovalIdentityError) return Response.json({ error: error.message }, { status: 409 });
    return Response.json({ error: 'Approval could not be confirmed. Reload before retrying.' }, { status: 503 });
  }
  return Response.json({ ok: true, revision: snapshot.manifest.revision });
};
