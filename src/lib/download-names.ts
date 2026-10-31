// The base name a downloaded file carries on the buyer's device,
// forever. It is built from the book's PUBLIC slug (title-derived),
// or from the title itself when no public slug exists yet. It must
// NEVER be the internal slug: that slug names the source material the
// story was adapted from, and a customer keeps the file forever.
export function downloadBaseName(book: {
  public_slug?: string | null;
  title?: string | null;
}): string {
  const p = String(book?.public_slug || "").trim();
  if (p) return p;
  const t = String(book?.title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return t || "big-brain-shelf-book";
}
