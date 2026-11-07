// Every customer-facing outbox kind must render styled HTML, never
// fall through to bare plain text. CG caught completion_upsell arriving
// unstyled on 2026-10-31: the kind had no render branch and no order_id,
// so it fell past the order gate to null. This pins the branch.
import { renderOutboxEmailHtml } from "../src/lib/email-render";

let fails = 0;
function assert(c: unknown, m: string) {
  if (c) console.log("PASS:", m);
  else {
    fails++;
    console.log("FAIL:", m);
  }
}

const db: any = {
  prepare: () => ({
    bind: () => ({
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({}),
    }),
  }),
};
const SITE = "https://bigbrainshelf.com";

const html = await renderOutboxEmailHtml(db, SITE, {
  order_id: null,
  kind: "completion_upsell",
  to_email: "camstewart7@gmail.com",
  subject: "You finished Mira the Heron and the Still Water",
  body_text:
    "Your family finished Mira the Heron and the Still Water. Nice work.\n\nWhen you are ready for the next book, the clubs keep the shelf full:\n\nSee the clubs: https://bigbrainshelf.com/clubs",
});
assert(typeof html === "string" && html.length > 200, "completion_upsell renders styled HTML, not null");
assert(html!.includes("See the clubs"), "completion_upsell without a review ask carries the clubs button");
assert(html!.includes(`${SITE}/clubs`), "completion_upsell button links to /clubs");
assert(html!.includes("You finished Mira the Heron"), "completion_upsell HTML carries the subject heading");

// The finished-book variant carries the review ask ("How was it?",
// CG 2026-11-01): its one button becomes the review link.
const reviewHtml = await renderOutboxEmailHtml(db, SITE, {
  order_id: null,
  kind: "completion_upsell",
  to_email: "camstewart7@gmail.com",
  subject: "You finished Mira the Heron and the Still Water",
  body_text:
    "Your family finished Mira the Heron and the Still Water. Nice work.\n\nHow was it? If Mira the Heron and the Still Water earned its place on your shelf, a short review helps other families find it. It takes about a minute.\n\nWrite a review: https://bigbrainshelf.com/account/reviews",
});
assert(reviewHtml!.includes("Write a review"), "finished email with the review ask carries the review button");
assert(reviewHtml!.includes(`${SITE}/account/reviews`), "review button links to /account/reviews");
assert(!reviewHtml!.includes(">See the clubs<"), "finished email with the review ask has no second button");

// The admin digest (added 2026-11-02) shipped unstyled on 2026-11-03:
// it had no render branch and no order_id, the same fall-through CG
// caught with completion_upsell. This pins its branch: branded shell,
// each urgency line its own paragraph, the dashboard link as the one
// button, no raw URL paragraph left behind.
const digestHtml = await renderOutboxEmailHtml(db, SITE, {
  order_id: null,
  kind: "admin_digest",
  to_email: "rocktownlabs@gmail.com",
  subject: "Big Brain Shelf: 5 urgent items need attention",
  body_text:
    "Here is what needs attention at Big Brain Shelf today:\n\n- 2 club boxes past the ship date. The oldest was due 2026-10-31, 3 days overdue.\n- 3 page fixes failed. Those pages kept their old art.\n\nDetails are on the admin dashboard: https://bigbrainshelf.com/admin",
});
assert(typeof digestHtml === "string" && digestHtml.length > 200, "admin_digest renders styled HTML, not null");
assert(digestHtml!.includes("Open the admin dashboard"), "admin_digest carries the dashboard button");
assert(digestHtml!.includes(`${SITE}/admin`), "admin_digest button links to /admin");
assert(digestHtml!.includes("2 club boxes past the ship date"), "admin_digest HTML carries the urgency lines");
assert(!digestHtml!.includes("Details are on the admin dashboard:"), "admin_digest leaves no raw dashboard line behind the button");

// The branch of last resort (CG, 2026-11-03): a kind with no branch at
// all still renders inside the branded shell from its stored text, so
// the NEXT new kind cannot ship bare while it waits for a template.
const fallbackHtml = await renderOutboxEmailHtml(db, SITE, {
  order_id: null,
  kind: "some_kind_that_does_not_exist_yet",
  to_email: "camstewart7@gmail.com",
  subject: "A future kind",
  body_text: "First paragraph of a future email.\n\nSecond paragraph.",
});
assert(typeof fallbackHtml === "string" && fallbackHtml.length > 200, "unknown kind falls back to the branded shell, not null");
assert(fallbackHtml!.includes("First paragraph of a future email."), "fallback HTML carries the stored text");

// The Lulu parcel kinds (print_shipped / print_delivered, 2026-11-07)
// model from the shipment the outbox dedupe key names, never from an
// order: their rows carry no order_id by design, so this pins the
// branch sitting before the order gate (the completion_upsell bug
// class). The canned DB answers exactly the three lookups the model
// makes.
const parcelDb: any = {
  prepare: (sql: string) => ({
    bind: () => ({
      first: async () => {
        if (sql.includes("FROM shipments")) {
          return {
            id: "shp-1", job_id: "job-1", job_item_id: "item-1",
            order_id: "ord-1", club_box_id: null,
            tracking_id: "trk-9", tracking_url: "https://track.example/9",
            carrier_name: "USPS", status: "SHIPPED",
          };
        }
        if (sql.includes("FROM print_job_items")) {
          return { id: "item-1", title: "Mira the Heron and the Still Water", kind: "story" };
        }
        if (sql.includes("FROM print_jobs")) {
          return { id: "job-1", order_id: "ord-1", club_box_id: null };
        }
        return null;
      },
      all: async () => ({ results: [] }),
      run: async () => ({}),
    }),
  }),
};
const parcelShippedHtml = await renderOutboxEmailHtml(parcelDb, SITE, {
  order_id: null,
  kind: "print_shipped",
  dedupe_key: "print_shipped:shp-1",
  to_email: "buyer@example.com",
  subject: "Your printed book has shipped",
  body_text: "stored text",
});
assert(typeof parcelShippedHtml === "string" && parcelShippedHtml.length > 200, "print_shipped renders styled HTML, not null");
assert(parcelShippedHtml!.includes("Track your package"), "print_shipped carries the tracking button");
assert(parcelShippedHtml!.includes("https://track.example/9"), "print_shipped button links to the tracking page");
assert(parcelShippedHtml!.includes("Mira the Heron and the Still Water"), "print_shipped names the parcel's book");

const parcelDeliveredHtml = await renderOutboxEmailHtml(parcelDb, SITE, {
  order_id: null,
  kind: "print_delivered",
  dedupe_key: "print_delivered:shp-1",
  to_email: "buyer@example.com",
  subject: "Your printed book has been delivered",
  body_text: "stored text",
});
assert(typeof parcelDeliveredHtml === "string" && parcelDeliveredHtml.length > 200, "print_delivered renders styled HTML, not null");
assert(parcelDeliveredHtml!.includes("Open your library"), "print_delivered carries the library button");
assert(parcelDeliveredHtml!.includes(`${SITE}/account/library`), "print_delivered button links to the library");

console.log(fails ? `\n${fails} FAILURES` : "\nALL PASS");
process.exit(fails ? 1 : 0);
