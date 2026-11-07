import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import Stripe from "stripe";
import { getAuth } from "../../lib/auth";
import { getOrCreatePendingOrder, attachStripeSession, normalizeFormat, isPhysicalFormat, checkoutItemPrice, enqueueConfirmation, itemQty, lineQty, type CartItem } from "../../lib/orders";
import { getDigitalEntitlements } from "../../lib/library";
import {
  normalizeShipDestination,
  quoteShippingWithRetry,
  storeCheckoutQuote,
  missingAddressFields,
  isAddressInvalidError,
  type LabelQuote,
} from "../../lib/shippo";
import {
  shippingQuoteFingerprint,
  storeShippingQuote,
  loadShippingQuote,
  storeOrderShippingQuoteDetail,
} from "../../lib/shipping-quotes";
import { luluConfigured, normalizeLuluAddress, LULU_LIMITS } from "../../lib/lulu";
import { resolveInternalSlug } from "../../lib/public-slugs";
import { normalizePromoCode, validatePromo, reservePromo, repriceLineItemsWithDiscount } from "../../lib/promo";


// POST /api/checkout { items: [{slug, format}], guest_id? } -> { url }
// (Legacy { slugs: string[] } is still accepted and treated as digital.)
// Prices are read from D1, never from the client.
//
// Who may check out (CG, 2026-10-28): one-time purchases are open to
// GUESTS as well as signed-in customers. Subscriptions stay
// account-only (that gate lives in /api/club/checkout, not here).
// The difference a session makes:
// - Entitlements: the audio-upgrade credit is read from the account's
//   entitlement layer, so it applies ONLY with a session. A guest
//   always pays full price; nothing in the request body can change
//   that (the pricing call below receives an empty ownership map).
// - Identity: a signed-in order keys to the user id. A guest order
//   keys to "guest:<id>", where <id> is the browser's stable guest id
//   (localStorage) when it arrives in a sane shape, else a fresh
//   random id for this request. The guest id is only a dedupe key
//   for the pending order, never a credential: delivery runs through
//   the per-order delivery_token links (email + the /order page).
// - Email: Stripe collects the guest's email on its own page; the
//   webhook completion copies it onto the order (completeOrder),
//   which is what the confirmation email and downloads key off.
// - Landing: signed-in buyers return to /account; guests return to
//   /order?token=<delivery_token>, which shows the order and its
//   download links without any account.
//
// Physical items (printed / giftset): shipping is PASS-THROUGH at the
// real carrier rate (CG, 2026-10-28). The buyer enters the destination
// on the checkout page BEFORE paying; the hub quotes Shippo server-side
// for the cart's combined parcels, picks the cheapest qualifying
// USPS/UPS rate, and shows carrier, service and the exact amount
// before payment. Two calls run this:
//   { action: "quote", items, address }  -> the quote alone, no order;
//      the quote is stored server-side and its id rides the response.
//   { items, address, quote_id }         -> reuses the stored preview
//      quote when it is fresh and matches this buyer, cart and ZIP
//      (a fresh re-quote could pick a different cheapest rate and
//      charge more than the buyer confirmed; that mismatch shipped
//      once, $6.28 shown vs $6.36 charged, and is the bug the stored
//      quote fixes). Falls back to a fresh quote when there is no
//      usable stored one. Stores the quote and address on the
//      pending order and creates the Stripe session carrying that
//      exact amount as a fixed shipping option.
// A client-sent shipping amount is never read, in either call. If
// Shippo cannot quote (after one retry), a physical checkout fails
// with a plain try-again error rather than guessing a fee; digital
// carts never touch the quote path and keep working.
//
// Lulu lane (slice 2): while the provider flag names Lulu and its
// credentials are present (luluConfigured), a physical cart quotes
// from Lulu's cost calculation instead: the registry's POD package
// and page count per physical unit, the buyer's exact address AND
// phone (Lulu refuses the call without a phone), level MAIL. The
// charge is Lulu's shipping total including tax plus a $2/order
// fulfilment fee, rounded up to the whole dollar like every other
// shipping charge here. Lulu quotes are fingerprinted under their
// provider and the full normalized address, so they can never be
// confused with a Shippo quote. Any gap in the lane (a physical
// line with no registered printable, or a failed Lulu call) fails
// closed back to the Shippo quote above; with the lane off, the
// Shippo path runs exactly as it always has. Physical carts collect
// a delivery phone on both paths: the print lane's job build needs
// one on the order, and the field is part of the address step now.
// A physical line may also carry a dedicationName, stored on the
// order's items JSON for the print lane to personalize from.
//
// Stripe Tax: automatic_tax is enabled ONLY when the TAX_ENABLED worker
// env value is "1"/"true". Stripe rejects sessions outright when Tax is
// not activated on the account, so the flag stays off until CG has
// activated Stripe Tax and added his tax registration in the dashboard.
const GUEST_ID_RE = /^[A-Za-z0-9-]{16,80}$/;

export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const SITE = e.BETTER_AUTH_URL || "https://bigbrainshelf.com";
  const body = await request.json().catch(() => ({}));
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  const user = session?.user ?? null;
  // Order identity: the account id when signed in, else the guest key.
  const guestId = GUEST_ID_RE.test(String(body?.guest_id || ""))
    ? String(body.guest_id)
    : crypto.randomUUID();
  const buyerId = user ? String(user.id) : `guest:${guestId}`;
  const buyerEmail = user ? String(user.email || "") : "";
  const action = String(body?.action || "");
  let wanted: { slug: string; format: string; qty: number; dedicationName?: string }[] = [];
  if (Array.isArray(body.items)) {
    wanted = body.items
      .map((x: any) => {
        const format = normalizeFormat(x?.format);
        // Single-copy formats (digital, audio) clamp to qty 1 here,
        // whatever the client sent: no gifting flow exists, so a
        // second copy could only ever be a double-charge.
        // A dedication name rides physical lines only, trimmed to a
        // sane length; blank means the write-in dedication page.
        const dedication = isPhysicalFormat(format)
          ? String(x?.dedicationName || "").trim().slice(0, 60)
          : "";
        return {
          slug: String(x?.slug || ""),
          format,
          qty: lineQty({ format, qty: x?.qty }),
          ...(dedication ? { dedicationName: dedication } : {}),
        };
      })
      .filter((x: any) => x.slug);
  } else if (Array.isArray(body.slugs)) {
    wanted = body.slugs.map((s: any) => ({ slug: String(s), format: "digital", qty: 1 }));
  }
  const seen = new Set<string>();
  wanted = wanted.filter((x) => {
    const k = x.slug + ":" + x.format;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 20);
  if (!wanted.length) {
    return Response.json({ error: "Your cart is empty." }, { status: 400 });
  }
  // Slug boundary: cart items key on the INTERNAL slug, and everything
  // below (book lookup, entitlements, the order record) resolves
  // against it. An item that arrives wearing a book's PUBLIC slug
  // (title-based, lib/public-slugs.ts) is translated to the internal
  // slug here, so the boundary holds whichever form a client sent.
  // An unresolvable slug passes through untouched and simply matches
  // no book below, exactly as before.
  try {
    const translations = new Map<string, string>();
    for (const s of new Set(wanted.map((x) => x.slug))) {
      const internal = await resolveInternalSlug(e.DB, s);
      if (internal && internal !== s) translations.set(s, internal);
    }
    if (translations.size) {
      // Re-dedupe after translating: an internal and a public form
      // of the same book + format collapse into one line.
      const seen2 = new Set<string>();
      wanted = wanted
        .map((x) => ({ ...x, slug: translations.get(x.slug) || x.slug }))
        .filter((x) => {
          const k = x.slug + ":" + x.format;
          if (seen2.has(k)) return false;
          seen2.add(k);
          return true;
        });
    }
  } catch { /* translation is defensive; raw slugs still resolve as before */ }
  const slugs = [...new Set(wanted.map((x) => x.slug))];
  const placeholders = slugs.map(() => "?").join(",");
  const rows = await e.DB.prepare(
    `SELECT slug, title, price, price_print, picture_book_key, coloring_book_key, audiobook_key FROM books WHERE slug IN (${placeholders}) AND status = 'complete'`
  ).bind(...slugs).all();
  const bySlug: Record<string, any> = {};
  for (const b of (rows.results || []) as any[]) bySlug[b.slug] = b;
  // Audio-published books (CG, 2026-10-29): a book with a cover and
  // an audiobook sells its AUDIO format whatever its book status;
  // its book editions stay unpublished, so the row is marked and the
  // pricing loop below lets only the audio format through for it.
  const missingSlugs = slugs.filter((s) => !bySlug[s]);
  if (missingSlugs.length) {
    const mph = missingSlugs.map(() => "?").join(",");
    const audioRows = await e.DB.prepare(
      `SELECT slug, title, price, price_print, picture_book_key, coloring_book_key, audiobook_key FROM books WHERE slug IN (${mph}) AND cover_key IS NOT NULL AND audiobook_key IS NOT NULL`
    ).bind(...missingSlugs).all();
    for (const b of (audioRows.results || []) as any[]) {
      bySlug[b.slug] = { ...b, audio_only: true };
    }
  }

  // Ownership drives exactly one price adjustment: the audio upgrade
  // credit (an audiobook-only owner unlocking digital pays the digital
  // price minus the audio price). It is computed here from the
  // entitlement layer for the signed-in user; nothing the client sends
  // can create, widen, or move it. Print and gift set never discount.
  // OWNERSHIP means owned (the lock model): the flags handed to the
  // pricer are the entitlement's access flags ANDed with its owned
  // marker, so club membership access, which is never owned, can
  // neither earn the credit nor discount any other purchase, and an
  // audio line always prices at the full audio price, member or not.
  // Guests have no account, so they get an empty entitlement map and
  // every line prices at full: the upgrade credit can never attach
  // to a session-less checkout.
  const entitlements = user
    ? await getDigitalEntitlements(e.DB, {
        id: String(user.id),
        email: String(user.email || ""),
      })
    : new Map<string, { digital: boolean; audio: boolean; owned: boolean }>();

  const lineItems: any[] = [];
  const bought: CartItem[] = [];
  for (const w of wanted) {
    const b = bySlug[w.slug];
    if (!b) continue;
    // An audio-published (not book-published) row sells audio only:
    // its digital, printed, and gift set formats stay refused here
    // even if the row carries stamped prices.
    if (b.audio_only && w.format !== "audio") continue;
    const ent = entitlements.get(w.slug);
    const priced = checkoutItemPrice(b, w.format, {
      digital: ent?.owned === true && ent?.digital === true,
      audio: ent?.owned === true && ent?.audio === true,
    });
    if (!priced) continue;
    const name =
      w.format === "printed"
        ? `${b.title} (Full color printed book)`
        : w.format === "giftset"
          ? `${b.title} (Gift Set: printed storybook + coloring book)`
          : w.format === "audio"
            ? `${b.title} (Audiobook only)`
            : priced.upgrade
              ? `${b.title} (Digital, audiobook credit applied)`
              : `${b.title} (Digital)`;
    if (priced.cents > 0) {
      lineItems.push({
        price_data: {
          currency: "usd",
          unit_amount: priced.cents,
          product_data: {
            name,
            metadata: { slug: b.slug, format: w.format },
          },
        },
        quantity: lineQty(w),
      });
    }
    bought.push(priced.upgrade ? { ...w, upgrade: priced.upgrade } : w);
  }
  if (!bought.length) {
    return Response.json({ error: "Nothing in your cart is available for purchase yet." }, { status: 400 });
  }

  const physical = bought.some((i) => isPhysicalFormat(i.format));
  const itemsTotal = lineItems.reduce((sum, li) => sum + (li.price_data.unit_amount || 0) * (li.quantity || 1), 0);

  // Promo code (lib/promo.ts): validated against the server-priced
  // merchandise subtotal, never a client figure. A code that was
  // sent but does not validate fails the call with the reason, on
  // every action, so the buyer never pays expecting a discount
  // that is not coming. The "promo" action is validation alone
  // (the checkout page's Apply button); the pay call reprices the
  // line items and reserves the redemption against the order.
  const promoCode = normalizePromoCode(body?.promo_code);
  let promoApplied: { code: string; percentOff: number; discountCents: number } | null = null;
  if (promoCode) {
    const v = await validatePromo(e.DB, {
      code: promoCode,
      email: buyerEmail,
      userId: buyerId,
      subtotalCents: itemsTotal,
    }).catch(() => ({ ok: false as const, error: "That code could not be checked. Please try again." }));
    if (!v.ok) {
      return Response.json({ error: v.error || "That code is not a current offer." }, { status: 400 });
    }
    promoApplied = {
      code: promoCode,
      percentOff: Number((v as any).promo?.percent_off || 0),
      discountCents: Number((v as any).discountCents || 0),
    };
  }
  if (action === "promo") {
    if (!promoApplied) {
      return Response.json({ error: "Enter a promo code." }, { status: 400 });
    }
    return Response.json({
      ok: true,
      promo: {
        code: promoApplied.code,
        percent_off: promoApplied.percentOff,
        discount_cents: promoApplied.discountCents,
      },
      items_total: itemsTotal,
      total: itemsTotal - promoApplied.discountCents,
    });
  }
  const promoDiscountCents = promoApplied?.discountCents || 0;

  // --- Shipping: destination in, server-side quote out. The CHARGE
  // is the quoted rate rounded up to the next whole dollar (CG,
  // 2026-11-03); the stored shippo_rate_id still buys the label at
  // the quote's real amount, and the round-up covers the label plus
  // quote-to-purchase drift. The preview stores its quote; the pay
  // call reuses that exact quote through the same rounding, so what
  // the buyer was shown is what the session charges.
  let quote: LabelQuote | null = null;
  let dest: ReturnType<typeof normalizeShipDestination> | null = null;
  let quoteFingerprint = "";
  let quoteDetail: Record<string, any> | null = null;
  let shipPhone = "";
  if (physical) {
    dest = normalizeShipDestination(body?.address);
    if (!dest.name && user) dest.name = String(user.name || "");
    const missing = missingAddressFields(dest.address);
    if (missing.length) {
      return Response.json(
        { error: `Please complete your shipping address (missing: ${missing.join(", ")}).` },
        { status: 400 }
      );
    }
    // A guest's email is not known yet (Stripe collects it at
    // payment); the quote itself does not need one.
    dest.email = buyerEmail;
    // The delivery phone: required for physical carts. The print
    // lane cannot quote or print without one (Lulu 400s both calls
    // on an account with no default phone), and the number is
    // stored on the order for whichever lane fulfils it.
    shipPhone = String(body?.address?.phone ?? body?.phone ?? "").trim();
    if (!shipPhone) {
      return Response.json(
        { error: "Please add a phone number for delivery, so the carrier can reach you about your books." },
        { status: 400 }
      );
    }
    const laneOn = luluConfigured(e);
    // Lulu's field limits, enforced on the Lulu path only: over-long
    // values are the buyer's to fix here rather than silently
    // truncated (the job build's normalization stays as the backstop
    // for orders written any other way).
    if (laneOn) {
      const tooLong = (
        [
          ["Full name", dest.name, LULU_LIMITS.name],
          ["Street address", dest.address.line1, LULU_LIMITS.street],
          ["Street address line 2", dest.address.line2, LULU_LIMITS.street],
          ["City", dest.address.city, LULU_LIMITS.city],
          ["Phone", shipPhone, LULU_LIMITS.phone],
        ] as [string, string, number][]
      ).find(([, v, lim]) => String(v || "").length > lim);
      if (tooLong) {
        return Response.json(
          { error: `${tooLong[0]} is too long for print delivery (over ${tooLong[2]} characters). Please shorten it.` },
          { status: 400 }
        );
      }
    }
    const fpBase = {
      buyerKey: buyerId,
      state: String(dest.address?.state || ""),
      zip: String(dest.address?.postal_code || ""),
      country: String(dest.address?.country || ""),
      items: bought,
    };
    const shippoFingerprint = shippingQuoteFingerprint(fpBase);
    // Lulu prices by exact address, so its fingerprint names the
    // provider and keys on the full normalized address + phone.
    const luluFingerprint = laneOn
      ? shippingQuoteFingerprint({
          ...fpBase,
          provider: "lulu",
          addressKey: (() => {
            const a = normalizeLuluAddress({
              name: dest.name,
              line1: dest.address.line1,
              line2: dest.address.line2,
              city: dest.address.city,
              state: dest.address.state,
              postal_code: dest.address.postal_code,
              country: dest.address.country,
              phone: shipPhone,
            }).address;
            return [a.name, a.street1, a.street2 || "", a.city, a.state_code, a.postcode, a.country_code, a.phone_number || ""].join("|");
          })(),
        })
      : "";
    quoteFingerprint = shippoFingerprint;
    // Pay call with a preview quote id: reuse the buyer's confirmed
    // quote instead of re-quoting into a possibly different rate.
    // A stored quote is looked up under each candidate fingerprint
    // (Lulu first with the lane on): the preview may have failed
    // closed to Shippo, and its quote must still be honored.
    if (action !== "quote" && body?.quote_id) {
      const candidates = laneOn ? [luluFingerprint, shippoFingerprint] : [shippoFingerprint];
      for (const fp of candidates) {
        quote = await loadShippingQuote(e.DB, String(body.quote_id), fp).catch(() => null);
        if (quote) {
          quoteFingerprint = fp;
          if ((quote as any).quoteDetail) quoteDetail = (quote as any).quoteDetail;
          break;
        }
      }
    }
    if (!quote && laneOn) {
      try {
        const { quoteLuluShipping } = await import("../../lib/print-fulfillment");
        const lq = await quoteLuluShipping(e.DB, e, {
          items: bought,
          name: dest.name,
          address: dest.address,
          phone: shipPhone,
        });
        if (lq) {
          quote = lq.quote;
          quoteDetail = { ...lq.detail };
          quoteFingerprint = luluFingerprint;
        }
      } catch (err) {
        // Fail closed to Shippo, never error the checkout for a
        // lane problem (a missing printable returns null above and
        // lands in the same fallback).
        console.error("lulu shipping quote failed, falling back to Shippo:", err);
      }
    }
    if (!quote) try {
      quoteFingerprint = shippoFingerprint;
      quote = await quoteShippingWithRetry(e, dest, bought);
    } catch (err) {
      // An address Shippo validated as undeliverable is the buyer's
      // to fix, not an outage: surface Shippo's explanation as a 400
      // in both the quote preview and the pay call (which re-quotes),
      // instead of the generic try-again 503.
      if (isAddressInvalidError(err)) {
        return Response.json(
          { error: err instanceof Error ? err.message : "That shipping address could not be verified." },
          { status: 400 }
        );
      }
      console.error("checkout shipping quote failed:", err);
      return Response.json(
        { error: "Shipping quote unavailable, please try again." },
        { status: 503 }
      );
    }
  }
  // The shipping charge: the quote rounded up to the next whole
  // dollar (an exact-dollar quote stays as it is). One variable feeds
  // the preview, the total, the Stripe session, and the order row, so
  // preview always equals charged.
  const shippingCents = quote ? Math.ceil(quote.amountCents / 100) * 100 : 0;
  const total = itemsTotal - promoDiscountCents + shippingCents;

  if (action === "quote") {
    // Preview only: no order is created. The quote itself is stored
    // under an id the page carries into the pay call, which reuses
    // it verbatim while it is fresh; a stale or mismatched id falls
    // back to a fresh quote, so an old preview can never set a
    // charge the buyer did not just confirm.
    const quoteId = quote
      ? await storeShippingQuote(e.DB, quote, quoteFingerprint, quoteDetail || undefined).catch(() => null)
      : null;
    return Response.json({
      ok: true,
      physical,
      items_total: itemsTotal,
      ...(promoApplied
        ? { promo: { code: promoApplied.code, percent_off: promoApplied.percentOff, discount_cents: promoApplied.discountCents } }
        : {}),
      shipping: quote
        ? {
            quote_id: quoteId,
            carrier: quote.carrier,
            service: quote.service,
            // The CHARGE (rounded up), not the raw quote: the preview
            // must equal what the session charges.
            amount_cents: shippingCents,
            estimated_days: quote.estimatedDays,
            // Shippo's standardized destination when validation ran
            // (null when it returned no verdict). The checkout page
            // adopts it, so the address the buyer confirms in the
            // shipping step is the deliverable one the order stores.
            validated_address: quote.validatedAddress ?? null,
          }
        : null,
      total,
    });
  }

  // The discount reprices the Stripe lines themselves (the order
  // total already netted it out), so what Stripe charges, what the
  // order records, and what the buyer was shown agree to the cent.
  if (promoApplied && promoDiscountCents > 0) {
    const repriced = repriceLineItemsWithDiscount(lineItems, promoDiscountCents);
    lineItems.length = 0;
    lineItems.push(...repriced);
  }

  // Idempotency: one pending order per (buyer, cart), where the buyer
  // is the account id or the guest key. A double click or a retried
  // request reuses the same pending order, and its id is the Stripe
  // idempotency key, so Stripe hands back the same session too.
  const order = await getOrCreatePendingOrder(e.DB, {
    userId: buyerId,
    email: buyerEmail,
    items: bought,
    amount: total,
  });
  // Where the buyer lands after paying: the account library when
  // signed in; for guests, the tokened order page (the delivery token
  // is minted with the pending order, so the URL is known now; the
  // page shows downloads once the webhook marks the order complete).
  const successUrl = user
    ? `${SITE}/account?checkout=success`
    : `${SITE}/order?token=${encodeURIComponent(String(order.delivery_token || ""))}`;

  if (physical && quote && dest) {
    // The quote, its destination, and the agreed total land on the
    // pending order NOW (before Stripe exists in the flow), so the
    // order always carries what the buyer was quoted; the webhook
    // completion keeps these values and only confirms them.
    await storeCheckoutQuote(e.DB, order.id, { dest, quote, amount: total, phone: shipPhone || undefined, shippingCents });
    // The quote's breakdown, whichever provider produced it: the
    // order forever shows what its shipping charge was made of.
    const detailRecord = quoteDetail
      ? {
          provider: "lulu",
          level: quoteDetail.level,
          currency: quoteDetail.currency,
          shipping_excl_tax_cents: quoteDetail.shippingExclTaxCents,
          shipping_tax_cents: quoteDetail.shippingTaxCents,
          shipping_incl_tax_cents: quoteDetail.shippingInclTaxCents,
          fulfillment_fee_cents: quoteDetail.fulfillmentFeeCents,
          total_cents: shippingCents,
          fingerprint: quoteFingerprint,
        }
      : {
          provider: "shippo",
          carrier: quote.carrier,
          service: quote.service,
          shipping_incl_tax_cents: quote.amountCents,
          fulfillment_fee_cents: 0,
          total_cents: shippingCents,
          fingerprint: quoteFingerprint,
        };
    await storeOrderShippingQuoteDetail(e.DB, order.id, detailRecord).catch((err: any) =>
      console.error("shipping quote detail store failed", err?.message || err)
    );
  }

  if (promoApplied) {
    // Reserve the redemption against this order (the cap counts
    // live reservations, so parallel checkouts cannot oversell the
    // ten spots) and stamp the order for the receipt. A failure
    // here never blocks the purchase: the webhook's grant path
    // recreates the row from the session metadata if it is missing.
    await reservePromo(e.DB, {
      code: promoApplied.code,
      orderId: order.id,
      email: buyerEmail,
      userId: buyerId,
      discountCents: promoDiscountCents,
    }).catch((err: any) => console.error("promo reserve failed", err?.message || err));
  }

  if (total === 0) {
    // Free unlock: every priced line floored at $0 (today that means
    // an audio credit covered a digital price at or under the audio
    // price). Stripe cannot run a $0 payment session, so the pending
    // order completes in place through the same recorded-order path,
    // with its confirmation email, and the buyer lands where a paid
    // checkout lands.
    await e.DB
      .prepare("UPDATE orders SET status = 'complete', stripe_session_id = ? WHERE id = ?")
      .bind(`free:${order.id}`, order.id)
      .run();
    try {
      const done = await e.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(order.id).first();
      if (done) await enqueueConfirmation(e.DB, SITE, done);
    } catch { /* the unlock stands even if the email enqueue fails */ }
    // Lulu lane: the same auto-place a paid completion gets. A $0
    // cart is digital in practice, so this is a guarded no-op unless
    // a physical line ever totals $0; the helper never throws and
    // the cron dispatcher remains the retry path.
    try {
      const done = await e.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(order.id).first();
      if (done) {
        const { autoPlacePrintJobForOrder } = await import("../../lib/print-fulfillment");
        await autoPlacePrintJobForOrder(e.DB, e, done, SITE);
      }
    } catch { /* the unlock stands even if auto-place fails */ }
    return Response.json({ url: successUrl, free: true });
  }
  if (!e.STRIPE_SECRET_KEY) {
    return Response.json({ error: "Checkout is not configured yet." }, { status: 503 });
  }

  const taxEnabled = String(e.TAX_ENABLED || "").toLowerCase() === "1" || String(e.TAX_ENABLED || "").toLowerCase() === "true";
  const sessionParams: any = {
    mode: "payment",
    line_items: lineItems,
    metadata: {
      user_id: buyerId,
      order_id: order.id,
      slugs: bought.map((b) => b.slug).join(","),
      items: JSON.stringify(bought),
      shipping_cents: String(shippingCents),
    },
    success_url: successUrl,
    cancel_url: `${SITE}/checkout?checkout=cancelled`,
  };
  if (promoApplied) sessionParams.metadata.promo_code = promoApplied.code;
  // Signed-in buyers: Stripe pre-fills the account email. Guests:
  // no customer_email is set, so Stripe collects one on its page;
  // the webhook copies it onto the order at completion.
  if (user) sessionParams.customer_email = String(user.email || "");
  if (physical && quote && dest) {
    // The shipping charge rides as a fixed-amount shipping option (not
    // a line item): Stripe then reports it as the session's
    // shipping_cost, keeps it out of the item list the receipt renders,
    // and taxes it as shipping when Tax is on. The display name is the
    // quoted carrier + service, so the buyer sees on Stripe's page
    // exactly what the checkout page quoted them.
    sessionParams.shipping_options = [
      {
        shipping_rate_data: {
          type: "fixed_amount",
          fixed_amount: { amount: shippingCents, currency: "usd" },
          display_name: [quote.carrier, quote.service].filter(Boolean).join(" ") || "Shipping",
        },
      },
    ];
    // The address itself is already collected (checkout page) and stored on
    // the order; it also rides in the metadata so order completion can
    // recover it even if no pending row exists. Stripe is NOT asked to
    // collect a second, possibly different, address.
    sessionParams.metadata.ship_name = dest.name || "";
    sessionParams.metadata.ship_address = JSON.stringify(
      shipPhone ? { ...dest.address, phone: shipPhone } : dest.address
    );
  }
  if (taxEnabled) {
    sessionParams.automatic_tax = { enabled: true };
    // Tax needs an address. Physical carts were once covered by the
    // Stripe-collected shipping address; now that the destination is
    // collected on the checkout page, ask Stripe for the billing address
    // on every cart instead.
    sessionParams.billing_address_collection = "required";
  }

  const stripe = new Stripe(e.STRIPE_SECRET_KEY);
  const checkout = await stripe.checkout.sessions.create(
    sessionParams,
    { idempotencyKey: `checkout_${order.id}` }
  );
  if (checkout.id && checkout.id !== order.stripe_session_id) {
    await attachStripeSession(e.DB, order.id, checkout.id);
  }
  return Response.json({
    url: checkout.url,
    shipping_cents: shippingCents,
    ...(quote ? { carrier: quote.carrier, service: quote.service } : {}),
  });
};
