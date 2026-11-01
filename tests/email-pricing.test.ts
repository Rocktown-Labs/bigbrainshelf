// Email pricing + layout tests (CG, 2026-10-31 evening): the owner
// notice and the buyer confirmation rendered prices floated inside
// the item paragraph, so Apple Mail dropped each price onto the next
// line or against the wrong row, and the lines did not visibly add
// up to the total. The confirmation also carried no per-line prices
// at all, and neither email honored the audio-upgrade credit (an
// upgrade line priced at the full $8.99 instead of $7.00).
// Fix: one pricedOrderLines helper (quantities, per-book prices,
// upgrade credit) feeding both emails, and table-cell prices in
// both templates. Run with: bun tests/email-pricing.test.ts
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { render } from "@react-email/render";
import {
  pricedOrderLines,
  buildConfirmationEmailModel,
  buildConfirmationEmail,
} from "../src/lib/orders";
import OwnerOrderEmail from "../emails/OwnerOrderEmail";
import OrderConfirmationEmail from "../emails/OrderConfirmationEmail";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else {
    failures += 1;
    console.error("FAIL:", label);
  }
}

const BOOKS: any[] = [
  {
    slug: "mastery",
    title: "Mira the Heron and the Still Water",
    price: 899,
    price_print: 2000,
    picture_book_key: "books/mastery/picture-book.pdf",
    coloring_book_key: "books/mastery/coloring-book.pdf",
    epub_key: "books/mastery/book.epub",
    audiobook_key: "books/mastery/audiobook.m4b",
  },
];
const order = (items: any[], extra: any = {}) => ({
  id: "54f3cff5-0000-0000-0000-000000000000",
  items: JSON.stringify(items),
  amount: 4408,
  shipping_cents: 610,
  quoted_carrier: "UPS",
  quoted_service: "Ground Saver",
  delivery_token: "tok",
  ...extra,
});

// The probe order: 2x digital + 1x printed + $6.10 shipping = $44.08.
const probe = order([
  { slug: "mastery", format: "digital", qty: 2 },
  { slug: "mastery", format: "printed", qty: 1 },
]);
const lines = pricedOrderLines(probe, BOOKS);
assert(lines.length === 2, "probe order groups into 2 priced lines");
const dig = lines.find((l) => l.formatLabel === "digital");
const prn = lines.find((l) => l.formatLabel.startsWith("full color"));
assert(dig?.qty === 2 && dig?.lineTotalCents === 1798, "digital line: qty 2, $17.98");
assert(prn?.qty === 1 && prn?.lineTotalCents === 2000, "printed line: qty 1, $20.00");
assert(
  lines.reduce((s, l) => s + l.lineTotalCents, 0) + 610 === 4408,
  "lines + shipping reconcile to the $44.08 charged"
);

// Quantity multiplies: 3x printed is one $60.00 line, not $20.00.
const three = pricedOrderLines(order([{ slug: "mastery", format: "printed", qty: 3 }]), BOOKS);
assert(three.length === 1 && three[0].qty === 3 && three[0].lineTotalCents === 6000, "3x printed = $60.00 line");

// The audio upgrade: digital line credited the $1.99 audio price.
const up = pricedOrderLines(
  order([{ slug: "mastery", format: "digital", upgrade: "audio-upgrade" }]),
  BOOKS
);
assert(up[0].unitCents === 700 && up[0].lineTotalCents === 700, "audio upgrade line prices at $7.00");
assert(up[0].formatLabel.includes("audiobook credit applied"), "upgrade line says the credit applied");

// Catalog constants for giftset and audio.
const misc = pricedOrderLines(
  order([
    { slug: "mastery", format: "giftset" },
    { slug: "mastery", format: "audio" },
  ]),
  BOOKS
);
assert(misc.find((l) => l.formatLabel.startsWith("gift set"))?.lineTotalCents === 2500, "gift set = $25.00");
assert(misc.find((l) => l.formatLabel === "audiobook only")?.lineTotalCents === 199, "audio only = $1.99");

// Per-book price columns win over the standard constants.
const dear = pricedOrderLines(order([{ slug: "mastery", format: "digital" }]), [
  { ...BOOKS[0], price: 1299 },
]);
assert(dear[0].unitCents === 1299, "per-book digital price column wins");

// The confirmation model carries the same priced lines, and its
// plain-text part itemizes them (stored body_text is the text part).
const model = buildConfirmationEmailModel("https://bigbrainshelf.com", probe, BOOKS);
assert(
  model.items.reduce((s, i) => s + i.lineTotalCents, 0) === 3798,
  "confirmation model lines sum to $37.98 before shipping"
);
const text = buildConfirmationEmail("https://bigbrainshelf.com", probe, BOOKS).text;
assert(text.includes(": $17.98"), "confirmation text prices the digital line");
assert(text.includes(": $20.00"), "confirmation text prices the printed line");
assert(text.includes("Total charged: $44.08"), "confirmation text total unchanged");

// Templates: prices live in table cells, never floated.
const ownerSrc = readFileSync(new URL("../emails/OwnerOrderEmail.tsx", import.meta.url), "utf8");
const confSrc = readFileSync(new URL("../emails/OrderConfirmationEmail.tsx", import.meta.url), "utf8");
assert(!ownerSrc.includes('float: "'), "owner email has no floated price");
assert(!confSrc.includes('float: "'), "confirmation email has no floated price");
assert(ownerSrc.includes("<Column") && confSrc.includes("<Column"), "both templates use table columns for prices");

// Rendered HTML carries the numbers in table markup.
const ownerHtml = await render(
  createElement(OwnerOrderEmail, {
    model: {
      orderShortId: "54F3CFF5",
      total: "$44.08",
      itemCount: 3,
      lines: lines.map((l) => ({
        title: l.title,
        formatLabel: l.formatLabel + (l.qty > 1 ? ` ×${l.qty}` : ""),
        price: `$${(l.lineTotalCents / 100).toFixed(2)}`,
      })),
      shipping: "$6.10",
      buyerEmail: "camstewart7@gmail.com",
      shipName: "Cameron Stewart",
      shipAddress: "2310 W 18th St, Little Rock, AR 72202-5934, US",
      adminUrl: "https://bigbrainshelf.com/admin/orders/x",
    },
  })
);
assert(ownerHtml.includes("<table"), "owner email renders table layout");
assert(ownerHtml.includes("$17.98") && ownerHtml.includes("$20.00"), "owner email renders line totals");
const confHtml = await render(createElement(OrderConfirmationEmail, { model }));
assert(confHtml.includes("$17.98") && confHtml.includes("$44.08"), "confirmation renders lines and total");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
