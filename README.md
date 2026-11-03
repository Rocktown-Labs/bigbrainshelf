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
  `bun tests/<file>.test.ts`.
- `factory/` — the shared source for the kidsbook-factory Worker,
  including book building, colorizing, repair, page fixes, and PDF
  assembly.
- `factory-ops/` — the audit and operations tools, architecture reviews,
  and dated evidence runs, including the Nov 2-3, 2026 judgment run.

## Working in this repo

- Agents: read `AGENTS.md` and `docs/agent-access.md` first. Repository
  access is granted per GitHub identity, vendor GitHub App, or machine
  key; work happens on agent branches through pull requests.
- Build: `bun run build` (also prepares the worker entry), then
  deploy with `python3 deploy.py` (Workers Assets flow; it does
  not build for you).
- Dev server runs in background mode: `astro dev --background`.
- Secrets live in the worker's secret store (set through the
  Cloudflare API), never in this repo. `.env*` and `.dev.vars*`
  are gitignored; do not commit credentials.
- Two standing baselines in `tests/` fail for pre-existing i18n
  reasons (`cart-resolution`, `home-filters`); everything else
  passes and must keep passing.

## Direction

This becomes a monorepo. Other agents are joining for security
audits, a dedicated API, and the mobile app. Keep new surface
area in `src/lib/` where the API and the app can share it, and
keep the buyer-facing rules (prices in `src/lib/offers.ts`,
public book URLs by public slug) in one place.
