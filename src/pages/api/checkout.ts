import { env } from "cloudflare:workers";
import type { APIRoute } from 'astro';
import Stripe from "stripe";
import { getAuth } from "../../lib/auth";
import { getOrCreatePendingOrder, attachStripeSession, normalizeFormat, isPhysicalFormat, checkoutItemPrice, enqueueConfirmation, itemQty, type CartItem } from "../../lib/orders";
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
} from "../../lib/shipping-quotes";
import { resolveInternalSlug } from "../../lib/public-slugs";


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
  let wanted: { slug: string; format: string; qty: number }[] = [];
  if (Array.isArray(body.items)) {
    wanted = body.items
      .map((x: any) => ({ slug: String(x?.slug || ""), format: normalizeFormat(x?.format), qty: itemQty(x) }))
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
        quantity: itemQty(w),
      });
    }
    bought.push(priced.upgrade ? { ...w, upgrade: priced.upgrade } : w);
  }
  if (!bought.length) {
    return Response.json({ error: "Nothing in your cart is available for purchase yet." }, { status: 400 });
  }

  const physical = bought.some((i) => isPhysicalFormat(i.format));
  const itemsTotal = lineItems.reduce((sum, li) => sum + (li.price_data.unit_amount || 0) * (li.quantity || 1), 0);

  // --- Pass-through shipping: destination in, server-side quote out.
  // The preview stores its quote; the pay call reuses that exact
  // quote (same code path AND same numbers), so what the buyer was
  // shown is what the session charges.
  let quote: LabelQuote | null = null;
  let dest: ReturnType<typeof normalizeShipDestination> | null = null;
  let quoteFingerprint = "";
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
    quoteFingerprint = shippingQuoteFingerprint({
      buyerKey: buyerId,
      state: String(dest.address?.state || ""),
      zip: String(dest.address?.postal_code || ""),
      country: String(dest.address?.country || ""),
      items: bought,
    });
    // Pay call with a preview quote id: reuse the buyer's confirmed
    // quote instead of re-quoting into a possibly different rate.
    if (action !== "quote" && body?.quote_id) {
      quote = await loadShippingQuote(e.DB, String(body.quote_id), quoteFingerprint).catch(() => null);
    }
    if (!quote) try {
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
  const shippingCents = quote?.amountCents ?? 0;
  const total = itemsTotal + shippingCents;

  if (action === "quote") {
    // Preview only: no order is created. The quote itself is stored
    // under an id the page carries into the pay call, which reuses
    // it verbatim while it is fresh; a stale or mismatched id falls
    // back to a fresh quote, so an old preview can never set a
    // charge the buyer did not just confirm.
    const quoteId = quote
      ? await storeShippingQuote(e.DB, quote, quoteFingerprint).catch(() => null)
      : null;
    return Response.json({
      ok: true,
      physical,
      items_total: itemsTotal,
      shipping: quote
        ? {
            quote_id: quoteId,
            carrier: quote.carrier,
            service: quote.service,
            amount_cents: quote.amountCents,
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
    await storeCheckoutQuote(e.DB, order.id, { dest, quote, amount: total });
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
    sessionParams.metadata.ship_address = JSON.stringify(dest.address);
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
