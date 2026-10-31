// The canonical deliverables of a finished book (CG, 2026-10-31):
// one list that the readiness page shows as the book's directory
// and the bundle download packs into the ZIP. File names inside
// the ZIP are the short deliverable names; the storage key is
// where the file actually lives.

export interface Deliverable {
  /** Name inside the bundle / on the readiness page. */
  name: string;
  /** R2 key where the file lives. */
  key: string;
  /** What the file is, in one plain line. */
  what: string;
}

export function deliverableList(book: any, slug: string): Deliverable[] {
  const list: Deliverable[] = [];
  if (book.picture_book_key)
    list.push({ name: "picture-book.pdf", key: String(book.picture_book_key), what: "Storybook PDF (line art edition)" });
  if (book.coloring_book_key)
    list.push({ name: "coloring-book.pdf", key: String(book.coloring_book_key), what: "Coloring book PDF" });
  if (book.color_book_key)
    list.push({ name: "color-storybook.pdf", key: String(book.color_book_key), what: "Storybook PDF (full color edition)" });
  if (book.epub_key)
    list.push({ name: "book.epub", key: String(book.epub_key), what: "EPUB ebook" });
  if (book.audiobook_key)
    list.push({ name: "audiobook.m4b", key: String(book.audiobook_key), what: "Audiobook (unstamped master; buyers get stamped copies)" });
  list.push({ name: "cover.jpg", key: `books/${slug}/cover-titled.jpg`, what: "Finished titled cover" });
  list.push({ name: "back-cover.jpg", key: `books/${slug}/back-cover-color.jpg`, what: "Painted back cover art" });
  list.push({ name: "marketing-manifest.json", key: `books/${slug}/marketing/manifest.json`, what: "Marketing kit manifest (what marketing pulls)" });
  return list;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
