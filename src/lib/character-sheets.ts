// Shared resolution for character sheet art, used by the character
// detail page (/admin/characters/[id]) and the gated sheet download
// route (/api/admin/character-sheet).
//
// The factory stores approved sheets in the shared R2 bucket (BOOKS):
//   color sheet: characters/{nameKey}.png      (registry column jpg_key)
//   line sheet:  characters/line/{nameKey}.png (registry column line_jpg_key)
// Unapproved studio sheets sit at characters/pending[-line]/{slug}-{nameKey}.png
// and never reach the characters registry until approved.

export function nameKey(name: string): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type SheetKind = "color" | "line";

export interface SheetInfo {
  kind: SheetKind;
  key: string;
  exists: boolean;
  size: number;
  pendingExists: boolean;
}

function cleanKey(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export async function resolveCharacterSheets(e: any, row: any): Promise<Record<SheetKind, SheetInfo>> {
  const nk = nameKey(row?.name ?? "");
  const slug = cleanKey(row?.book_slug);
  const defs: { kind: SheetKind; key: string; pendingKey: string }[] = [
    {
      kind: "color",
      key: cleanKey(row?.jpg_key) || `characters/${nk}.png`,
      pendingKey: slug ? `characters/pending/${slug}-${nk}.png` : "",
    },
    {
      kind: "line",
      key: cleanKey(row?.line_jpg_key) || `characters/line/${nk}.png`,
      pendingKey: slug ? `characters/pending-line/${slug}-${nk}.png` : "",
    },
  ];
  const out = {} as Record<SheetKind, SheetInfo>;
  for (const d of defs) {
    let exists = false;
    let size = 0;
    try {
      const head = await e.BOOKS.head(d.key);
      if (head) {
        exists = true;
        size = Number(head.size ?? 0);
      }
    } catch { /* missing bucket entry reads as no sheet */ }
    let pendingExists = false;
    if (!exists && d.pendingKey) {
      try {
        pendingExists = !!(await e.BOOKS.head(d.pendingKey));
      } catch { /* ignore */ }
    }
    out[d.kind] = { kind: d.kind, key: d.key, exists, size, pendingExists };
  }
  return out;
}

export function sheetFilename(name: string, kind: SheetKind, key: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(key);
  const ext = m ? m[1].toLowerCase() : "png";
  return `${nameKey(name)}-sheet-${kind}.${ext}`;
}

export function contentTypeForKey(key: string, fallback?: string): string {
  if (fallback) return fallback;
  const m = /\.([a-z0-9]+)$/i.exec(key);
  const ext = m ? m[1].toLowerCase() : "";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "svg") return "image/svg+xml";
  return "application/octet-stream";
}
