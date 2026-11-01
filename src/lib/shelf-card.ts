// Reusable shelf card HTML renderer for storefront book grids.

const R2_PUBLIC = "https://media.bigbrainshelf.com/";

export function escShelfHtml(s: unknown): string {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) =>
      (({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] as string)
  );
}

export function formatShelfPriceText(cents: unknown): string {
  return "$" + (Number(cents || 0) / 100).toFixed(2);
}

export const SHELF_BADGE_ICONS = {
  story:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="shrink-0"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  coloring:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="shrink-0"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
  audio:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="shrink-0"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>',
};

export function renderShelfBadgeRowHtml(b: any): string {
  const badges: { icon: string; name: string; cls: string }[] = [];
  if (b.has_picture_book)
    badges.push({
      icon: SHELF_BADGE_ICONS.story,
      name: "Story book",
      cls: "bg-green-100 text-green-800",
    });
  if (b.has_coloring_book)
    badges.push({
      icon: SHELF_BADGE_ICONS.coloring,
      name: "Coloring book",
      cls: "bg-amber-100 text-amber-800",
    });
  if (b.has_audiobook)
    badges.push({
      icon: SHELF_BADGE_ICONS.audio,
      name: "Audiobook",
      cls: "bg-red-100 text-red-800",
    });
  return (
    '<div class="flex flex-wrap items-center content-start gap-1.5 mt-1.5 min-h-[30px] lg:min-h-[20px]" role="list" aria-label="What this book includes">' +
    badges
      .map(
        (bd) =>
          '<span role="listitem" title="' +
          bd.name +
          '" aria-label="' +
          bd.name +
          '" class="inline-flex items-center justify-center rounded-full p-1.5 ' +
          bd.cls +
          '">' +
          bd.icon +
          "</span>"
      )
      .join("") +
    "</div>"
  );
}

export function renderShelfCardHtml(b: any, priority = false): string {
  const cover = b.cover_card || (b.cover_key ? R2_PUBLIC + b.cover_key : "");
  const priceHtml =
    Number(b.price || 0) > 0
      ? '<span class="font-semibold">' +
        escShelfHtml(formatShelfPriceText(b.price)) +
        "</span>" +
        ' <span class="text-stone-500 font-normal">digital</span>' +
        (Number(b.price_print || 0) > 0
          ? ' <span class="text-stone-300">·</span> <span class="font-semibold">' +
            escShelfHtml(formatShelfPriceText(b.price_print)) +
            '</span> <span class="text-stone-500 font-normal">printed</span>'
          : "")
      : '<span class="text-stone-400">Coming soon</span>';
  const searchText = ((b.title || "") + " " + (b.description || "")).toLowerCase();
  return (
    '<a href="' +
    escShelfHtml(b.href || "/books/" + b.slug) +
    '" data-topic="' +
    escShelfHtml(b.topic || "tech") +
    '" data-search="' +
    escShelfHtml(searchText) +
    '" class="group block relative">' +
    '<div class="relative w-full aspect-[3/4] bg-stone-100 transition duration-200 group-hover:-translate-y-1 group-hover:shadow-[0_16px_28px_-14px_rgba(0,0,0,0.35)]" style="view-transition-name: book-cover-' +
    escShelfHtml(b.slug) +
    '" role="img" aria-label="' +
    escShelfHtml(b.title) +
    ' cover">' +
    '<span aria-hidden="true" class="absolute inset-0 z-10 pointer-events-none" style="box-shadow: inset 12px 0 18px -11px rgba(0,0,0,.5), inset -1px 0 2px rgba(0,0,0,.12), inset 0 0 0 1px rgba(0,0,0,.07)"></span>' +
    (cover
      ? '<img src="' +
        escShelfHtml(cover) +
        '" alt="" aria-hidden="true" loading="' +
        (priority ? "eager" : "lazy") +
        '"' +
        (priority ? ' fetchpriority="high"' : "") +
        ' class="absolute inset-0 w-full h-full object-cover" />' +
        '<img src="/just-buy-it.webp" alt="" aria-hidden="true" class="absolute inset-0 z-20 w-full h-full opacity-0" />'
      : "") +
    "</div>" +
    renderShelfBadgeRowHtml(b) +
    '<h3 class="mt-2 lg:mt-3 text-[15px] font-semibold leading-snug">' +
    escShelfHtml(b.title) +
    "</h3>" +
    '<p class="text-sm mt-0.5">' +
    priceHtml +
    "</p></a>"
  );
}
