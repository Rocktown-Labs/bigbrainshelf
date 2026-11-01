# Big Brain Shelf

The Big Brain Shelf storefront, admin, and factory hub: one Astro +
Cloudflare Workers app today, growing into the monorepo for the
store's web app, dedicated API, and mobile app.

## What's here

- `src/pages/` — the storefront (books, audiobooks, clubs, cart,
  checkout), the buyer account + reader, and the admin (orders,
  books, readiness, casting, fulfillment).
- `src/pages/api/` — checkout (Stripe), shipping (Shippo), the
  editor and publish flow, club scheduling, and webhooks.
- `src/lib/` — the shared logic: offers/pricing, orders + the
  email outbox, publish and delivery readiness, public slugs.
- `emails/` — React Email templates for transactional mail.
- `tests/` — plain bun test files, run per file:
  `bun tests/<file>.test.ts` (family-and-hub needs the runner instead:
  `bun test tests/family-and-hub.test.ts`).

## Working in this repo

- Build: `bun run build` (also prepares the worker entry), then
  deploy with `python3 deploy.py` (Workers Assets flow; it does
  not build for you).
- Dev server runs in background mode: `astro dev --background`.
- Secrets live in the worker's secret store (set through the
  Cloudflare API), never in this repo. `.env*` and `.dev.vars*`
  are gitignored; do not commit credentials.
- Two standing i18n baselines in `tests/` fail for pre-existing
  reasons (`cart-resolution`, `home-filters`); a group of older
  suites also fails on `main` independently of any recent work
  (`cast-erase`, `cast-history`, `cast-lasso`, `cast-lift`,
  `cast-sheet-shape`, `a2-pages`, `admin-operator`, `idempotency`,
  `m4b-stamp`, `media-gating` — checked 2026-11-01). Everything
  else passes and must keep passing.

## Direction

This becomes a monorepo. Other agents are joining for security
audits, a dedicated API, and the mobile app. Keep new surface
area in `src/lib/` where the API and the app can share it, and
keep the buyer-facing rules (prices in `src/lib/offers.ts`,
public book URLs by public slug) in one place.
