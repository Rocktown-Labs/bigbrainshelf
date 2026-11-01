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
- Dashboard -> library -> tap a book -> book overview -> tap Read /
  Listen / Print -> the reader or a small chooser.
- A way back is always one tap away.
- Do not stack the shelf, the reader, the player, and the settings into
  a single scrolling page. If a feature needs room, it gets a route.

## The frame: store top bar plus a sidebar, like /admin

(Corrected by CG 2026-11-01: the sidebar pattern was never the
problem, its execution was. /account uses the same mechanics as
/admin, in customer dress.)

- The store top bar (logo, search, cart, account menu) renders above
  everything inside /account, so search and the cart never leave.
  Buying from inside /account adds to the same cart and checks out
  the same way.
- Under it, a fixed sidebar with the admin shell's mechanics: grouped
  nav, the family switcher (who is reading: parent or a kid) inside
  the sidebar, and the user popover in the foot. On phones the
  sidebar becomes a drawer, and a bottom tab bar carries the main
  sections.
- The reader (/read/[slug]) renders inside the same frame.

## The dashboard (/account)

- /account is a dashboard, not the shelf: "Welcome, {first name}",
  stat cards a parent acts on (books on the shelf, audiobooks, club
  and its next box, readers), action buttons (Continue reading, make
  your picks, browse, finish setup), a Continue Reading panel, and
  a shelf preview.
- The preview shows one board (4 books) and a View all that goes to
  the library. The library is its own page, never the home.

## The Library (/account/library)

- It looks like a shelf: rows of book covers resting on shelf boards,
  the way the promo videos show it. Four covers per board, every book
  on the page. (The dashboard preview shows one board and a View all
  that lands here.)
- Covers stand in their composed 3:4 portrait shape, never cropped
  into squares: a cropped cover clips its own title.
- As the screen narrows the boards reflow to 2 by 2. It always reads as
  a shelf, never as a data grid.
- A cover shows a slim progress bar or percent for a book in
  progress, plus the small format access circles at the top-left
  (green book = digital, red headphones = audio, navy pill = club),
  the same color language as the storefront (CG, 2026-11-01: he
  asked for the icons here explicitly). Nothing else competes with
  the art.
- The sidebar nav is short on purpose (simplified 2026-11-01):
  Dashboard and My Library up top, then Family, Give $10 Get $10,
  Book & Audio Club, Orders & Receipts, My Reviews, Settings. The
  Listening Shelf has no nav item; listening lives inside My
  Library and the book overview. The desktop sidebar collapses to
  an icon rail (persisted per browser).
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
- Box picking is the Shelf: two box slots on top, a shelf of covers
  on a wooden plank below. Tap a book and it goes in the box; tap a
  filled slot to swap it back to Surprise. Books the family owns or
  already has coming sit dimmed unless the second-copy toggle is on.
  (CG picked Shelf from the HTML prototype over a cover grid,
  2026-11-01.)
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
