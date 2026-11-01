// Admin sidebar model (pass 4, 2026-10-29): the grouped navigation
// for the shadcn-pattern collapsible sidebar, and the editor-route
// rule. Kept as data + a pure matcher so the shell component stays
// markup-only and the behavior is unit-testable.
//
// Groups follow the owner's grouping: Overview, Catalog, Commerce,
// Media, with Sign out pinned at the bottom of the rail (rendered by
// the shell, not listed here).

export interface AdminNavItem {
  href: string;
  label: string;
  icon: string; // key into the shell's icon set
}
export interface AdminNavGroup {
  label: string;
  items: AdminNavItem[];
}

export const ADMIN_NAV: AdminNavGroup[] = [
  {
    label: "Overview",
    items: [{ href: "/admin", label: "Dashboard", icon: "dashboard" }],
  },
  {
    label: "Catalog",
    items: [
      { href: "/admin/books", label: "Books", icon: "book" },
      { href: "/admin/audiobooks", label: "Audiobooks", icon: "audio" },
      { href: "/admin/bibles", label: "Bibles", icon: "scroll" },
      { href: "/admin/characters", label: "Characters", icon: "characters" },
      { href: "/admin/cast-gemini", label: "Casting", icon: "casting" },
    ],
  },
  {
    label: "Commerce",
    items: [
      { href: "/admin/orders", label: "Orders", icon: "orders" },
      { href: "/admin/club", label: "Club", icon: "club" },
      { href: "/admin/revops", label: "RevOps & Scale", icon: "dashboard" },
      { href: "/admin/reviews", label: "Reviews", icon: "reviews" },
      { href: "/admin/users", label: "Users", icon: "users" },
    ],
  },
  {
    label: "Media",
    items: [
      { href: "/admin/video", label: "Video", icon: "video" },
      { href: "/", label: "Storefront", icon: "store" },
    ],
  },
];

// Immersive, full-width editing surfaces: the sidebar starts
// collapsed to the icon rail on these routes so the editor gets the
// width. The toggle still expands it there; everywhere else the
// sidebar starts from the owner's persisted preference.
const EDITOR_PATTERNS: RegExp[] = [
  /^\/admin\/books\/[^/]+/, // book QC hub, editor, crops, story review
  /^\/admin\/characters\/[^/]+/, // character editor, cast crop editor
  /^\/admin\/cast\/?$/, // cast studio
  /^\/admin\/cast-gemini\/?$/, // casting studio
];

export function isEditorRoute(pathname: string): boolean {
  const p = String(pathname || "");
  return EDITOR_PATTERNS.some((re) => re.test(p));
}
