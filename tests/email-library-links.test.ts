// Email download-link policy tests (CG, 2026-10-31): emailed links
// are auth-backed. The confirmation names the buyer's books and
// links only at the account library; the delivery token never
// appears in the email; the legacy token endpoint redirects into
// the library and serves no bytes. Run with:
// bun tests/email-library-links.test.ts
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { render } from "@react-email/render";
import { buildConfirmationEmailModel, buildConfirmationEmail } from "../src/lib/orders";
import OrderConfirmationEmail from "../emails/OrderConfirmationEmail";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else {
    failures += 1;
    console.error("FAIL:", label);
  }
}

const SITE = "https://bigbrainshelf.com";
const book: any = {
  slug: "mastery",
  title: "Mira the Heron and the Still Water",
  price: 899,
  price_print: 2000,
  picture_book_key: "books/mastery/picture.pdf",
  coloring_book_key: "books/mastery/coloring.pdf",
  epub_key: "books/mastery/book.epub",
  color_book_key: null,
  audiobook_key: "books/mastery/audio.m4b",
};

const guestOrder: any = {
  id: "ord-guest",
  user_id: "guest:abc",
  email: "guest@example.com",
  items: JSON.stringify([{ slug: "mastery", format: "digital", qty: 1 }]),
  book_slugs: JSON.stringify(["mastery"]),
  amount: 899,
  shipping_cents: 0,
  delivery_token: "SECRET_TOKEN_SHOULD_NEVER_SHIP",
};
const memberOrder: any = { ...guestOrder, id: "ord-member", user_id: "user-123" };

const gm = buildConfirmationEmailModel(SITE, guestOrder, [book]);
assert(gm.downloads.length === 1 && gm.downloads[0].title === book.title, "model lists the bought book once");
assert(
  gm.downloads.every((d) => d.links.every((l) => l.url === `${SITE}/account`)),
  "every download entry links only at the account library"
);
assert(gm.guest === true, "a guest-keyed order reads as a guest");

const mm = buildConfirmationEmailModel(SITE, memberOrder, [book]);
assert(mm.guest === false, "an account order does not read as a guest");

const text = buildConfirmationEmail(SITE, guestOrder, [book]).text;
assert(!text.includes("SECRET_TOKEN_SHOULD_NEVER_SHIP"), "plain text never carries the delivery token");
assert(!text.includes("/api/order-download"), "plain text carries no bearer download path");
assert(text.includes("Your books are in your library"), "plain text names the library");
assert(text.includes("one-click sign-in link"), "guest plain text points at the sign-in link email");

const memberText = buildConfirmationEmail(SITE, memberOrder, [book]).text;
assert(!memberText.includes("one-click sign-in link"), "member plain text skips the guest sign-in note");

const html = await render(createElement(OrderConfirmationEmail, { model: gm, site: SITE }));
assert(html.includes("Your books are in your library"), "HTML names the library section");
assert(!html.includes("SECRET_TOKEN_SHOULD_NEVER_SHIP") && !html.includes("/api/order-download"), "HTML carries no token and no bearer path");
assert(html.includes("one-click sign-in link"), "guest HTML points at the sign-in link email");

const route = readFileSync(new URL("../src/pages/api/order-download.ts", import.meta.url), "utf8");
assert(route.includes('Location: "/account"'), "legacy route redirects to the library");
assert(!route.includes("BOOKS.get") && !route.includes("stampPdfForBuyer") && !route.includes("serveStampedM4b"), "legacy route serves no bytes");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
