// Packing: the shared fulfillment model for store orders and club
// boxes (admin redesign S4, 2026-11-03). One packing shelf ("What do
// we pack and ship?") lists everything awaiting fulfillment, and one
// fulfillment view serves both kinds of parcel. This module owns the
// pack checklist lines (what goes in the box, with covers and book
// codes), the tick math, and the queue query.
//
// Pack state itself is stored on the parcel's own row as pack_json
// (orders: lib/orders.ts setOrderPack; boxes: lib/club-cycles.ts
// setClubBoxPack) in the shape { "<line key>": true }, plus the
// reserved key PACK_LABEL_KEY for the printed-label confirmation.
import { loadBooksByAnySlug, orderPickList, PACK_LABEL_KEY, type OrderItemGroup } from "./orders";
import { ensureClubCycleTables } from "./club-cycles";
import { coverDerivative, MEDIA_PUBLIC } from "./derivatives";
import { bookCodeForTitle } from "./catalog";
import { chicagoDateString } from "./offers";

export { PACK_LABEL_KEY };

export interface PackLine {
  key: string; // stable tick key, persisted in pack_json
  label: string; // what the operator reads on the line
  detail: string; // format / role line under the label
  qty: number;
  cover: string | null;
  code: string | null; // book packing code (lib/catalog), null for extras
}

// One checklist from a store order's pick-list groups. Physical lines
// only: digital and audio never enter a box. A gift set is TWO
// physical pieces (the printed storybook and its printed coloring
// book), so it packs as two lines. Line keys derive from the book
// CODE (title-derived, stable across renames), never the internal
// slug; an unresolvable book keys off its neutral title.
export function packLinesForGroups(groups: OrderItemGroup[]): PackLine[] {
  const lines: PackLine[] = [];
  for (const g of groups) {
    const base = g.code || g.title;
    if (g.format === "printed") {
      lines.push({
        key: `${base}|printed`,
        label: g.title,
        detail: "Printed book",
        qty: g.count,
        cover: g.cover,
        code: g.code,
      });
    } else if (g.format === "giftset") {
      lines.push({
        key: `${base}|giftset:story`,
        label: g.title,
        detail: "Gift set: printed storybook",
        qty: g.count,
        cover: g.cover,
        code: g.code,
      });
      lines.push({
        key: `${base}|giftset:coloring`,
        label: g.title,
        detail: "Gift set: printed coloring book",
        qty: g.count,
        cover: g.cover,
        code: g.code,
      });
    }
  }
  return lines;
}

// A club box's contents are complete when BOTH slots have a resolved
// book: slot 1 (the club book, shipped as a gift set) and slot 2 (the
// second printed storybook). A box short of that starts its
// fulfillment view at the pick step instead of the pack step.
export function boxContentsComplete(box: any): boolean {
  return Boolean(
    box &&
      (box.resolved_book_slug || box.selected_book_slug) &&
      (box.second_resolved_book_slug || box.second_selected_book_slug)
  );
}

function boxSlug(box: any, slot: 1 | 2): string {
  if (slot === 1) return String(box.resolved_book_slug || box.selected_book_slug || "");
  return String(box.second_resolved_book_slug || box.second_selected_book_slug || "");
}

function coverFor(book: any): string | null {
  if (!book) return null;
  return (
    coverDerivative(String(book.slug), "card", book.cover_key) ||
    (book.cover_key ? MEDIA_PUBLIC + book.cover_key : null)
  );
}

// One checklist from a club box, given the books its slots resolve to
// (keyed by the slug recorded on the box). Contents per the locked-box
// email members already receive: the club book as the full gift set
// (storybook + coloring book), a second printed storybook, and a
// sticker sheet.
export function packLinesForBox(box: any, books: Map<string, any>): PackLine[] {
  const lines: PackLine[] = [];
  const s1 = boxSlug(box, 1);
  const s2 = boxSlug(box, 2);
  const b1 = s1 ? books.get(s1) : null;
  const b2 = s2 ? books.get(s2) : null;
  if (b1) {
    lines.push({
      key: "slot1:story",
      label: String(b1.title || ""),
      detail: "Club book: printed storybook (gift set)",
      qty: 1,
      cover: coverFor(b1),
      code: bookCodeForTitle(String(b1.title || "")),
    });
    lines.push({
      key: "slot1:coloring",
      label: String(b1.title || ""),
      detail: "Club book: printed coloring book (gift set)",
      qty: 1,
      cover: coverFor(b1),
      code: bookCodeForTitle(String(b1.title || "")),
    });
  }
  if (b2) {
    lines.push({
      key: "slot2:story",
      label: String(b2.title || ""),
      detail: "Second book: printed storybook",
      qty: 1,
      cover: coverFor(b2),
      code: bookCodeForTitle(String(b2.title || "")),
    });
  }
  lines.push({
    key: "extras:stickers",
    label: "Sticker sheet",
    detail: "In every club box",
    qty: 1,
    cover: null,
    code: null,
  });
  return lines;
}

// Tick math for a checklist. `complete` requires every line ticked;
// the label confirmation is tracked separately (it gates with the
// lines at the ship step, and it is not a box line).
export function packProgress(
  lines: PackLine[],
  state: Record<string, boolean> | null | undefined
): { total: number; done: number; complete: boolean; labelPrinted: boolean } {
  const s = state || {};
  const done = lines.filter((l) => s[l.key]).length;
  return {
    total: lines.length,
    done,
    complete: lines.length > 0 && done === lines.length,
    labelPrinted: Boolean(s[PACK_LABEL_KEY]),
  };
}

// ---------------------------------------------------------------------------
// The completed list: parcels whose fulfillment is DONE (shipped or
// delivered), newest first. The packing queue above is work waiting
// only; finished parcels live here instead, so the shelf never mixes
// the two (CG's report, 2026-11-03). The orders page renders this as
// a collapsed "Completed" section; the dashboard strip shows the
// waiting queue only.

export async function getCompletedParcels(db: any, limit = 20): Promise<PackingItem[]> {
  const items: PackingItem[] = [];
  try {
    const { results } = await db
      .prepare(
        `SELECT id, created_at, physical_status, items, book_slugs FROM orders
         WHERE status = 'complete' AND physical_status IN ('shipped', 'delivered')
         ORDER BY created_at DESC LIMIT ?`
      )
      .bind(limit)
      .all();
    const rows = (results || []) as any[];
    if (rows.length) {
      const picks = await orderPickList(db, rows);
      for (const o of rows) {
        const lines = packLinesForGroups(picks.get(String(o.id)) || []);
        if (!lines.length) continue; // a digital-only order has no parcel to complete
        items.push({
          kind: "order",
          id: String(o.id),
          ref: "#" + String(o.id).slice(0, 8).toUpperCase(),
          href: `/admin/orders/${o.id}`,
          cover: lines[0].cover,
          lines: lines.length,
          stage: String(o.physical_status) === "delivered" ? "Delivered" : "Shipped",
          needsPick: false,
          when: Number(o.created_at || 0),
        });
      }
    }
  } catch { /* the completed list is additive; the page works without it */ }
  try {
    await ensureClubCycleTables(db);
    const { results } = await db
      .prepare(
        `SELECT b.* FROM club_cycle_boxes b
         WHERE b.status IN ('shipped', 'delivered')
         ORDER BY b.ship_date DESC LIMIT ?`
      )
      .bind(limit)
      .all();
    const boxes = (results || []) as any[];
    if (boxes.length) {
      const slugs = boxes.flatMap((b) => [boxSlug(b, 1), boxSlug(b, 2)]).filter(Boolean);
      const books = await loadBooksByAnySlug(db, slugs, "slug, title, cover_key, public_slug");
      for (const b of boxes) {
        const lines = packLinesForBox(b, books);
        const stamp = Number(b.delivered_at || b.shipped_at || 0);
        items.push({
          kind: "box",
          id: String(b.id),
          ref: "Club box",
          href: `/admin/orders/box/${b.id}`,
          cover: lines.length ? lines[0].cover : null,
          lines: lines.length,
          stage: String(b.status) === "delivered" ? "Delivered" : "Shipped",
          needsPick: false,
          when: stamp || Math.floor(Date.parse(String(b.ship_date || "")) / 1000) || 0,
        });
      }
    }
  } catch { /* boxes are additive to the completed list */ }
  items.sort((a, b) => b.when - a.when);
  return items.slice(0, limit);
}

// ---------------------------------------------------------------------------
// The packing queue: everything awaiting fulfillment, store orders and
// club boxes together, oldest first within each kind. Digital-only
// orders never appear (their pick list has no physical lines).

export interface PackingItem {
  kind: "order" | "box";
  id: string; // order id, or club box id
  ref: string; // short display id ("#6D55C66C" style for orders)
  href: string; // the unified fulfillment view
  cover: string | null; // first pack line's cover
  lines: number; // pack line count
  stage: string; // short stage label
  needsPick: boolean; // club box whose contents are not set yet
  when: number; // sort key (created / ship date), oldest first
}

const ORDER_STAGE_LABEL: Record<string, string> = {
  preorder_received: "Received",
  in_print: "In print",
  packed: "Packed",
};

export async function getPackingQueue(db: any): Promise<PackingItem[]> {
  const items: PackingItem[] = [];
  // Store orders: complete orders with a live physical stage.
  try {
    const { results } = await db
      .prepare(
        `SELECT id, created_at, physical_status, items, book_slugs FROM orders
         WHERE status = 'complete' AND physical_status IN ('preorder_received', 'in_print', 'packed')
         ORDER BY created_at ASC LIMIT 50`
      )
      .bind()
      .all();
    const rows = (results || []) as any[];
    if (rows.length) {
      const picks = await orderPickList(db, rows);
      for (const o of rows) {
        const lines = packLinesForGroups(picks.get(String(o.id)) || []);
        if (!lines.length) continue; // digital-only: never on the shelf
        items.push({
          kind: "order",
          id: String(o.id),
          ref: "#" + String(o.id).slice(0, 8).toUpperCase(),
          href: `/admin/orders/${o.id}`,
          cover: lines[0].cover,
          lines: lines.length,
          stage: ORDER_STAGE_LABEL[String(o.physical_status)] || "To pack",
          needsPick: false,
          when: Number(o.created_at || 0),
        });
      }
    }
  } catch { /* the shelf degrades to boxes only rather than failing the page */ }
  // Club boxes: the same set the club API calls boxesToPack (a box
  // needing attention on any date, or a due box in a packable state).
  try {
    await ensureClubCycleTables(db);
    const today = chicagoDateString();
    const { results } = await db
      .prepare(
        `SELECT b.*, s.name AS member_name FROM club_cycle_boxes b
         LEFT JOIN club_signups s ON s.id = b.signup_id
         WHERE b.status = 'needs_attention'
            OR (b.ship_date <= ? AND b.status IN ('awaiting_selection', 'locked', 'preparing'))
         ORDER BY b.ship_date ASC LIMIT 50`
      )
      .bind(today)
      .all();
    const boxes = (results || []) as any[];
    if (boxes.length) {
      const slugs = boxes.flatMap((b) => [boxSlug(b, 1), boxSlug(b, 2)]).filter(Boolean);
      const books = await loadBooksByAnySlug(db, slugs, "slug, title, cover_key, public_slug");
      for (const b of boxes) {
        const complete = boxContentsComplete(b);
        const lines = complete ? packLinesForBox(b, books) : [];
        items.push({
          kind: "box",
          id: String(b.id),
          ref: "Club box",
          href: `/admin/orders/box/${b.id}`,
          cover: lines.length ? lines[0].cover : null,
          lines: lines.length,
          stage:
            b.status === "needs_attention"
              ? "Needs a pick"
              : b.status === "preparing"
                ? "Packing"
                : complete
                  ? "Print label"
                  : "Pick books",
          needsPick: !complete,
          when: Date.parse(String(b.ship_date || "")) || Number(b.created_at || 0),
        });
      }
    }
  } catch { /* boxes are additive to the shelf */ }
  items.sort((a, b) => a.when - b.when);
  return items;
}
