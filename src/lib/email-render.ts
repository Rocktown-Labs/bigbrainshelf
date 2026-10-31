// Renders the branded HTML part for an outbox row at send time.
//
// The outbox stores subject + plain text only (that text is unchanged and
// remains the email's plain-text part). For the HTML part we re-derive the
// same structured model the text was built from (lib/orders.ts model
// builders) and render the matching React Email template. Returns null
// for any kind or order we cannot model, in which case the send falls
// back to plain text only, exactly as before templates existed.

import { createElement } from "react";
import { render } from "@react-email/render";
import {
  buildConfirmationEmailModel,
  buildPhysicalUpdateEmailModel,
  loadBooksForOrder,
  orderFormatLabel,
  parseItems,
  itemQty,
  resolveClubBlock,
  type DBLike,
} from "./orders";
import {
  AUDIO_PRICE_CENTS,
  GIFT_SET_PRICE_CENTS,
  STANDARD_DIGITAL_PRICE_CENTS,
  STANDARD_PRINT_PRICE_CENTS,
} from "./offers";
import {
  buildClubFollowupModel,
  getOrCreateUnsubscribeToken,
  CLUB_FOLLOWUP_KIND,
} from "./marketing";
import { isClubCycleEmailKind, loadClubCycleEmailModel } from "./club-emails";
import { isReleaseKind, loadReleaseEmailModel } from "./releases";
import OrderConfirmationEmail from "../../emails/OrderConfirmationEmail";
import OwnerOrderEmail, { type OwnerOrderEmailModel } from "../../emails/OwnerOrderEmail";
import SimpleEmail, { type SimpleEmailModel } from "../../emails/SimpleEmail";
import PhysicalUpdateEmail from "../../emails/PhysicalUpdateEmail";
import ClubFollowupEmail from "../../emails/ClubFollowupEmail";
import ClubCycleEmail from "../../emails/ClubCycleEmail";
import ReleaseEmail from "../../emails/ReleaseEmail";

export async function renderOutboxEmailHtml(
  db: DBLike,
  site: string,
  row: { order_id?: string | null; kind: string; to_email?: string; club_box_id?: string | null; dedupe_key?: string | null; subject?: string | null; body_text?: string | null }
): Promise<string | null> {
  if (row.kind === "magic_link") {
    // Passwordless sign-in: pull the one-time URL out of the
    // stored text and give it a real button.
    const text = String(row.body_text || "");
    const url = (text.match(/https?:\/\/\S+/) || [])[0] || "";
    const paragraphs = text
      .split(/\n\n+/)
      .map((s) => s.replace(url, "").trim())
      .filter(Boolean);
    const model: SimpleEmailModel = {
      preview: "Your Big Brain Shelf sign-in link",
      heading: "Your sign-in link",
      paragraphs,
      button: url ? { label: "Sign in and open your library", href: url } : null,
      footnote: url ? `Or paste this link into your browser: ${url}` : null,
    };
    return await render(createElement(SimpleEmail, { model }));
  }
  if (row.kind === "password_reset") {
    // Same shape as the sign-in link: URL out of the stored text,
    // real button in the branded shell.
    const text = String(row.body_text || "");
    const url = (text.match(/https?:\/\/\S+/) || [])[0] || "";
    const paragraphs = text
      .split(/\n\n+/)
      .map((s) => s.replace(url, "").trim())
      .filter(Boolean);
    const model: SimpleEmailModel = {
      preview: "Reset your Big Brain Shelf password",
      heading: "Reset your password",
      paragraphs,
      button: url ? { label: "Set a new password", href: url } : null,
      footnote: url ? `Or paste this link into your browser: ${url}` : null,
    };
    return await render(createElement(SimpleEmail, { model }));
  }
  if (row.kind === "contact_form") {
    // The forward to the owner, in the branded shell: the stored
    // plain text becomes the paragraphs.
    const paragraphs = String(row.body_text || "").split(/\n\n+/).map((s) => s.trim()).filter(Boolean);
    const model: SimpleEmailModel = {
      preview: String(row.subject || "New contact form message"),
      heading: "New contact form message",
      paragraphs,
      footnote: "Reply to this email and your answer goes straight to the sender.",
    };
    return await render(createElement(SimpleEmail, { model }));
  }
  if (isReleaseKind(row.kind)) {
    // Release announcements: modeled from the book (the slug rides in
    // the dedupe_key), not from an order.
    const model = await loadReleaseEmailModel(db, site, row);
    if (!model) return null;
    return await render(createElement(ReleaseEmail, { model }));
  }
  if (isClubCycleEmailKind(row.kind)) {
    // Book Club cycle mail: modeled from the cycle box, not an order.
    const model = await loadClubCycleEmailModel(db, site, row);
    if (!model) return null;
    return await render(createElement(ClubCycleEmail, { model }));
  }
  if (row.kind === CLUB_FOLLOWUP_KIND) {
    // Marketing follow-up: no order model needed; the unsubscribe token
    // is the same stable one the plain text was enqueued with.
    const token = await getOrCreateUnsubscribeToken(db, String(row.to_email || ""));
    const model = buildClubFollowupModel(site, token);
    return await render(createElement(ClubFollowupEmail, { model }));
  }
  if (
    row.kind === "club_welcome" || row.kind === "owner_new_subscription" ||
    row.kind === "club_payment_failed" || row.kind === "club_canceled" ||
    row.kind === "owner_club_canceled" || row.kind === "owner_new_review" ||
    row.kind === "owner_payment_alert"
  ) {
    // Club + owner-notice mail carries no order; it renders from
    // its stored text and must be handled BEFORE the order gate
    // below, or it falls through to plain text (the bug CG caught
    // 2026-10-31).
    const paragraphs = String(row.body_text || "")
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    const buttons: Record<string, { label: string; href: string }> = {
      club_welcome: { label: "Open your library", href: `${site}/account` },
      club_payment_failed: { label: "Update your payment method", href: `${site}/account` },
      club_canceled: { label: "See the clubs", href: `${site}/clubs` },
      owner_new_subscription: { label: "Open the club list", href: `${site}/admin/club` },
      owner_club_canceled: { label: "Open the club list", href: `${site}/admin/club` },
      owner_new_review: { label: "Open the review queue", href: `${site}/admin/reviews` },
      owner_payment_alert: { label: "Open orders", href: `${site}/admin/orders` },
    };
    return await render(
      createElement(SimpleEmail, {
        model: {
          preview: row.subject,
          heading: row.subject,
          paragraphs,
          button: buttons[row.kind],
        },
      }),
    );
  }

  if (!row.order_id) return null;
  const order = await db
    .prepare("SELECT * FROM orders WHERE id = ?")
    .bind(row.order_id)
    .first();
  if (!order) return null;
  const books = await loadBooksForOrder(db, order);

  if (row.kind === "owner_new_order") {
    // The owner's order summary (CG, 2026-10-31: itemized and
    // styled, not bare text). Prices are the catalog prices by
    // format, the same ones checkout charges.
    const money = (c: number) => `$${(Number(c || 0) / 100).toFixed(2)}`;
    const priceFor = (format: string) =>
      format === "printed" ? STANDARD_PRINT_PRICE_CENTS
      : format === "giftset" ? GIFT_SET_PRICE_CENTS
      : format === "audio" ? AUDIO_PRICE_CENTS
      : STANDARD_DIGITAL_PRICE_CENTS;
    const titleBySlug = new Map(books.map((b: any) => [b.slug, b.title]));
    const items = parseItems(order);
    let shipAddress: string | null = null;
    try {
      const a = JSON.parse(String(order.ship_address || "null"));
      if (a) {
        const cityLine = [a.city, a.state, a.postal_code || a.zip].filter(Boolean).join(", ").replace(/, ([^,]+)$/, " $1");
        shipAddress = [a.line1, a.line2, cityLine, a.country].filter(Boolean).join(", ") || null;
      }
    } catch { /* no address renders as a digital order */ }
    const model: OwnerOrderEmailModel = {
      orderShortId: String(order.id || "").slice(0, 8).toUpperCase(),
      total: money(order.amount),
      itemCount: items.reduce((sum, it) => sum + itemQty(it), 0),
      lines: items.map((it) => ({
        title: titleBySlug.get(it.slug) || "Book",
        formatLabel: orderFormatLabel(it.format) + (itemQty(it) > 1 ? ` ×${itemQty(it)}` : ""),
        price: money(priceFor(it.format) * itemQty(it)),
      })),
      shipping: Number(order.shipping_cents || 0) > 0 ? money(order.shipping_cents) : null,
      buyerEmail: String(order.email || ""),
      shipName: order.ship_name ? String(order.ship_name) : null,
      shipAddress,
      adminUrl: `${site}/admin/orders/${order.id}`,
    };
    return await render(createElement(OwnerOrderEmail, { model }));
  }
  if (row.kind === "order_confirmation") {
    const club = await resolveClubBlock(db, site, order);
    const model = buildConfirmationEmailModel(site, order, books, club);
    return await render(createElement(OrderConfirmationEmail, { model }));
  }
  if (row.kind.startsWith("physical_update_")) {
    const status = row.kind.slice("physical_update_".length);
    const model = buildPhysicalUpdateEmailModel(order, books, status);
    if (!model) return null;
    return await render(createElement(PhysicalUpdateEmail, { model }));
  }
  return null;
}
