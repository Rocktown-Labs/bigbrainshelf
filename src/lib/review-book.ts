import { captureApprovalRevision } from './approval-identity';
import { adminMediaUrl } from './media';

/** QC renders the same plan inventory and bytes that its approval will bind. */
export async function readReviewBook(db: any, books: any, slug: string) {
  const snapshot = await captureApprovalRevision(db, books, slug);
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
