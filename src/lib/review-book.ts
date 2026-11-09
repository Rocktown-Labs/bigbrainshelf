import { approvedPages, approvalTargets, captureApprovalRevision } from './approval-identity';
import { adminMediaUrl } from './media';
import { colorEditionComplete, getSignoffStates } from './qc-signoffs';

/** QC renders the same plan inventory and bytes that its approval will bind. */
export async function readReviewBook(db: any, books: any, slug: string, captured?: Awaited<ReturnType<typeof captureApprovalRevision>>) {
  const snapshot = captured ?? await captureApprovalRevision(db, books, slug);
  const { manifest, inventory } = snapshot;
  const image = (key: string | null) => {
    const artifact = manifest.artifacts.find(a => a.key === key);
    return artifact ? `${adminMediaUrl(key)}&sha256=${artifact.sha256}` : '';
  };
  const chapters = inventory.sources.filter(s => s.role === 'plan').map((s, index) => {
    const plan = JSON.parse(new TextDecoder().decode(s.bytes));
    return { num: index + 1, title: plan.storyTitle ?? `S${index + 1}`,
      pages: manifest.pages.filter(p => p.chapter === index + 1).map(ref => {
        const pg = ref.kind === 'finale' ? plan.finale : plan.pages[ref.page];
        return { text: pg.storyText, image: image(ref.lineKey), imageColor: image(ref.colorKey), imagePrompt: pg.imagePrompt ?? '',
          character: pg.character ?? '', concept: pg.concept ?? '', finale: ref.kind === 'finale' };
      }) };
  });
  return { slug, revision: manifest.revision, totalPages: manifest.pages.length, chapters,
    cover: image(`books/${slug}/cover-titled.jpg`) || image(`books/${slug}/cover.jpg`),
    backCoverColor: image(`books/${slug}/back-cover-color.jpg`), backCoverLine: image(`books/${slug}/back-cover-line.jpg`) };
}

/** One captured version backs the pages, marks and sign-offs in a QC load. */
export async function readReviewSession(db: any, books: any, slug: string) {
  const snapshot = await captureApprovalRevision(db, books, slug);
  const [review, rows, signoffs] = await Promise.all([
    readReviewBook(db, books, slug, snapshot),
    approvedPages(db, snapshot.manifest, true),
    getSignoffStates(db, slug, snapshot.manifest.revision, colorEditionComplete(snapshot.manifest)),
  ]);
  const approvals = approvalTargets(snapshot.manifest).map(p => ({ chapterNum: p.chapter, pageIndex: p.page,
    approved: rows.some((r: any) => r.chapter_num === p.chapter && r.page_index === p.page) }));
  return { ...review, approvals, signoffs };
}
