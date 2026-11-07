// Renders the branded HTML part for an outbox row at send time.
//
// The outbox stores subject + plain text only (that text is unchanged and
// remains the email's plain-text part). For the HTML part we re-derive the
// same structured model the text was built from (lib/orders.ts model
// builders) and render the matching React Email template. Kinds with no
// dedicated model render their stored text in the branded SimpleEmail
// shell (see renderFallbackHtml), so no email goes out as bare text.

import { createElement } from "react";
import { render } from "@react-email/render";
import {
  buildConfirmationEmailModel,
  buildPhysicalUpdateEmailModel,
  loadBooksForOrder,
  parseItems,
  itemQty,
  pricedOrderLines,
  resolveClubBlock,
  type DBLike,
} from "./orders";
import {
  buildClubFollowupModel,
  getOrCreateUnsubscribeToken,
  CLUB_FOLLOWUP_KIND,
} from "./marketing";
import { isClubCycleEmailKind, loadClubCycleEmailModel } from "./club-emails";
import { isDelayEmailKind, loadDelayEmailModel } from "./delay-emails";
import { isReleaseKind, loadReleaseEmailModel } from "./releases";
import { loadPrintParcelEmailModel } from "./print-fulfillment";
import OrderConfirmationEmail from "../../emails/OrderConfirmationEmail";
import OwnerOrderEmail, { type OwnerOrderEmailModel } from "../../emails/OwnerOrderEmail";
import PrintParcelEmail from "../../emails/PrintParcelEmail";
import SimpleEmail, { type SimpleEmailModel } from "../../emails/SimpleEmail";
import PhysicalUpdateEmail from "../../emails/PhysicalUpdateEmail";
import ClubFollowupEmail from "../../emails/ClubFollowupEmail";
import ClubCycleEmail from "../../emails/ClubCycleEmail";
import DelayEmail from "../../emails/DelayEmail";
import ReleaseEmail from "../../emails/ReleaseEmail";
import WelcomeOnboardingEmail from "../../emails/WelcomeOnboardingEmail";
import BirthdayGiftEmail from "../../emails/BirthdayGiftEmail";

// The branch of last resort (CG, 2026-11-03): every email kind needs a
// styled render (hub AGENTS.md). A kind whose dedicated branch is
// missing, or whose model cannot be loaded, renders its stored plain
// text inside the branded SimpleEmail shell instead of going out as
// bare text. New kinds are styled by construction until they earn a
// dedicated template.
async function renderFallbackHtml(row: {
  subject?: string | null;
  body_text?: string | null;
}): Promise<string | null> {
  const paragraphs = String(row.body_text || "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paragraphs.length) return null;
  const model: SimpleEmailModel = {
    preview: String(row.subject || "Big Brain Shelf"),
    heading: String(row.subject || "Big Brain Shelf"),
    paragraphs,
  };
  return await render(createElement(SimpleEmail, { model }));
}

export async function renderOutboxEmailHtml(
  db: DBLike,
  site: string,
  row: { order_id?: string | null; kind: string; to_email?: string; club_box_id?: string | null; dedupe_key?: string | null; subject?: string | null; body_text?: string | null; created_at?: number | null }
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
  if (row.kind === "admin_digest") {
    // The daily admin urgency digest (lib/admin-digest.ts): no order,
    // renders from its stored text in the branded shell. The digest
    // text is line-structured (intro line, "- item" lines, then the
    // dashboard line), so each line becomes its own paragraph and the
    // dashboard URL becomes the email's one button.
    const text = String(row.body_text || "");
    const url = (text.match(/https?:\/\/\S+/) || [])[0] || `${site.replace(/\/$/, "")}/admin`;
    const paragraphs = text
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !s.includes(url))
      .map((s) => s.replace(/^Details are on the admin dashboard:?$/, "").trim())
      .filter(Boolean)
      .map((s) => (s.startsWith("- ") ? s.slice(2) : s));
    const model: SimpleEmailModel = {
      preview: String(row.subject || "Big Brain Shelf admin digest"),
      heading: String(row.subject || "Big Brain Shelf admin digest"),
      paragraphs,
      button: { label: "Open the admin dashboard", href: url },
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
  if (isDelayEmailKind(row.kind)) {
    // Running-late apologies: the order kind models from its order,
    // the club box kind from its box (club rows carry no order_id,
    // so this branch must sit before the order gate below).
    const model = await loadDelayEmailModel(db, site, row);
    if (!model) return await renderFallbackHtml(row);
    return await render(createElement(DelayEmail, { model }));
  }
  if (row.kind === "print_shipped" || row.kind === "print_delivered") {
    // Lulu parcel mail: modeled from the shipment (the outbox
    // dedupe key carries the shipment id), not from an order. Rows
    // carry no order_id by design (per-parcel kinds would collapse
    // on the (order_id, kind) index), so this branch must also sit
    // before the order gate below.
    const model = await loadPrintParcelEmailModel(db, site, row);
    if (!model) return await renderFallbackHtml(row);
    return await render(createElement(PrintParcelEmail, { model }));
  }
  if (row.kind === CLUB_FOLLOWUP_KIND) {
    // Marketing follow-up: no order model needed; the unsubscribe token
    // is the same stable one the plain text was enqueued with.
    const token = await getOrCreateUnsubscribeToken(db, String(row.to_email || ""));
    const model = buildClubFollowupModel(site, token);
    return await render(createElement(ClubFollowupEmail, { model }));
  }
  if (row.kind === "birthday_gift") {
    const paragraphs = String(row.body_text || "")
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    return await render(
      createElement(BirthdayGiftEmail, {
        model: {
          preview: String(row.subject || "A birthday surprise from Big Brain Shelf"),
          heading: String(row.subject || "Happy Birthday from Big Brain Shelf"),
          paragraphs,
          giftUrl: `${site.replace(/\/$/, "")}/account?gift=birthday`,
          footnote: "Sent with warm wishes from the Big Brain Shelf cast.",
        },
      }),
    );
  }
  if (row.kind === "family_onboarding") {
    const paragraphs = String(row.body_text || "")
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    return await render(
      createElement(WelcomeOnboardingEmail, {
        model: {
          preview: String(row.subject || "Your family shelf is ready on Big Brain Shelf"),
          heading: String(row.subject || "Your family shelf is ready"),
          paragraphs,
          accountUrl: `${site.replace(/\/$/, "")}/account`,
          footnote: "Reply anytime if you have a question for us.",
        },
      }),
    );
  }
  if (
    row.kind === "club_welcome" || row.kind === "owner_new_subscription" ||
    row.kind === "club_payment_failed" || row.kind === "club_canceled" ||
    row.kind === "club_downgrade_ready" ||
    row.kind === "owner_club_canceled" || row.kind === "owner_new_review" ||
    row.kind === "owner_payment_alert" || row.kind === "completion_upsell"
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
      club_downgrade_ready: { label: "Start The Audio Club", href: `${site}/account/club` },
      owner_new_subscription: { label: "Open the club list", href: `${site}/admin/club` },
      owner_club_canceled: { label: "Open the club list", href: `${site}/admin/club` },
      owner_new_review: { label: "Open the review queue", href: `${site}/admin/reviews` },
      owner_payment_alert: { label: "Open orders", href: `${site}/admin/orders` },
      // The finished-book email carries the review ask ("How was
      // it?"), so its one button is the review. Mid-book mail keeps
      // the clubs button. Keyed on the body so the button always
      // matches what the text actually asks.
      completion_upsell: String(row.body_text || "").includes("How was it?")
        ? { label: "Write a review", href: `${site}/account/reviews` }
        : { label: "See the clubs", href: `${site}/clubs` },
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

  if (!row.order_id) return await renderFallbackHtml(row);
  const order = await db
    .prepare("SELECT * FROM orders WHERE id = ?")
    .bind(row.order_id)
    .first();
  if (!order) return await renderFallbackHtml(row);
  const books = await loadBooksForOrder(db, order);

  if (row.kind === "owner_new_order") {
    // The owner's order summary (CG, 2026-10-31: itemized and
    // styled, not bare text). Line prices come from pricedOrderLines,
    // the same numbers the buyer's receipt shows (quantities and the
    // audio-upgrade credit included).
    const money = (c: number) => `$${(Number(c || 0) / 100).toFixed(2)}`;
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
      lines: pricedOrderLines(order, books).map((l) => ({
        title: l.title,
        formatLabel: l.formatLabel + (l.qty > 1 ? ` ×${l.qty}` : ""),
        price: money(l.lineTotalCents),
      })),
      shipping: Number(order.shipping_cents || 0) > 0 ? money(order.shipping_cents) : null,
      promo:
        order.promo_code && Number(order.promo_discount_cents || 0) > 0
          ? { code: String(order.promo_code), amount: money(order.promo_discount_cents) }
          : null,
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
    if (!model) return await renderFallbackHtml(row);
    return await render(createElement(PhysicalUpdateEmail, { model }));
  }
  return await renderFallbackHtml(row);
}
