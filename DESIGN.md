# Big Brain Shelf design rules

Read this before building or changing any customer-facing page. It exists
because the customer hub drifted into one giant page with a media player
bolted on (CG's review, 2026-10-31). The storefront home page is the bar:
if a page feels heavier than the home page, it is wrong.

## The feeling

The account area is a family's bookshelf, not a dashboard. Warm, quiet,
and simple enough that a parent gets it at a glance and a kid can wander
it safely. Mobile native first: design for a phone in one hand, then let
it breathe on desktop.

## Navigation model: clicks and transitions, never one mega page

- Every step is its own page, joined by Astro view transitions, the same
  way clicking a book on the storefront feels.
- Shelf -> tap a book -> book overview -> tap Read / Listen / Print ->
  the reader or a small chooser. Two taps from the shelf to reading.
- A way back to the shelf is always one tap away.
- Do not stack the shelf, the reader, the player, and the settings into
  a single scrolling page. If a feature needs room, it gets a route.

## The top bar never leaves

Inside /account the store's top bar stays: logo, search, and cart, plus
the family switcher at the top left (who is reading: parent or a kid).
Customers can search and buy without ever leaving the account area;
buying from inside /account adds to the same cart and checks out the
same way.

## The Shelf (/account)

- It looks like a shelf: rows of book covers resting on shelf boards,
  the way the promo videos show it. Four covers per board, two boards
  (8 books) before a "View more" takes you to the full shelf page.
- As the screen narrows the boards reflow to 2 by 2. It always reads as
  a shelf, never as a data grid.
- A cover shows at most one quiet marker: a slim progress bar or percent
  for a book in progress. Nothing else competes with the art.
- Empty shelf: one friendly line and one button to the store. No
  placeholder boxes, no grey skeletons pretending to be books.

## The book overview (/account/book/[slug])

- Mirrors the top half of the store book page: cover, title, the topic,
  a short about, and the cast. Same components where possible.
- Three calm actions: Read, Listen, Print. Download is present but
  quiet, a text link, not a fourth big button.
- Read defaults to the full-color edition with read-along audio.
  Print opens a small chooser: Coloring, Storybook, Full Color.
- Progress lives here: how far through the book, per chapter if cheap,
  and a Continue button that resumes where they left off.
- If the family does not own the book (club access or not yet bought),
  the same page carries the buy options inline. Never bounce a customer
  out to the storefront to purchase.

## The reader

- The reader is the QC reader: flip pages or scroll, color by default,
  with the read-along player docked. It was already good; do not invent
  a second reader.
- Full screen is a tap away. Nothing else lives on the reader page.

## Onboarding (/onboarding)

- A signed-in account that has not finished setup goes to /onboarding
  first (an isOnboarded check in the account layout), including guests
  who bought and then claimed their account.
- Three short steps: (1) pick a @username or keep the email, (2) kid or
  no kid, an honest skip, (3) for each child: name, date of birth,
  optional @handle, reading limits, topics they love. Finish lands on
  the shelf.
- Everything onboarding collects is editable later in Settings. Nothing
  collected is trapped in the wizard.

## Clubs inside the account

- /account/club manages the membership: plan, next box, picks, upgrade
  or downgrade, billing portal. Plain language, no dark patterns.
- The Audio Club has its own home in the account: a condensed listening
  shelf of what the membership opens. Joining or activating lands THERE,
  never back on the public join page. Putting a club book on your shelf
  is one tap; membership gives reading and listening, downloads stay
  with books the family owns.
- First box honesty: boxes are printed and packed to order. Public copy
  promises the first box ships within a few days of joining (see
  CLUB_PROCESSING_DAYS), never the same day. The cycle and picks still
  anchor to the join date.

## Orders, Reviews, Settings

- Orders: a clean history list. Date, books, total, status, receipt.
  Nothing else.
- Reviews: the family's reviews and the ones they can still write.
- Settings: sign-in and security, the family profile and kids (the same
  fields as onboarding), club billing links. Toggles, not forms buried
  in wizards.

## Empty states

Every list and page ships its empty state in the same change: one line
that says what belongs here, and one button that starts it. An empty
state with no way forward is a bug.

## Copy and email rules

- No em dashes in customer copy. Short sentences and periods.
- Names, never slugs: a book is always its public title anywhere a
  human can read, admin included.
- One call to action per email. Every customer email renders in the
  styled layout; a kind without a render branch is a bug (the
  completion_upsell lesson, 2026-10-31).
- Progress numbers in email must match what the account shows. If the
  UI cannot show it, the email does not claim it.

## Queued delight: name in the book

Digital editions are generated per family, so a child's first name can
live inside their copy of a book (a dedication page at the front).
Nobody expects it; that is the point. Build it after the hub cleanup,
behind the same per-buyer stamping the downloads already use.
