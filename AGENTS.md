## Multi-agent access and coordination

This private repository is the shared source of truth for the Big Brain
Shelf storefront, factory, and factory evidence. Agents work from a clone
of `Rocktown-Labs/bigbrainshelf` after CG grants that agent's GitHub
identity, GitHub App, or machine key access to this repository. See
`docs/agent-access.md` for the access models and owner steps.

- Pull the latest `main` before starting and check for overlapping work.
- Use a branch named `agent/<agent-name>/<short-task>` and open a pull
  request. Do not push directly to `main`; CG and RGM are the integrators
  unless CG names another integrator for a task.
- Keep changes scoped to the assigned surface. Read the nearest nested
  `AGENTS.md` before working in `factory/` or `factory-ops/`.
- `factory/` is the shared factory source. Reconcile it with the deployed
  factory before deployment work, and commit every factory change here.
- Files under `factory-ops/audits/` are evidence. Do not rewrite a prior
  run; add a new dated run folder for new measurements.
- Never commit credentials, private keys, `.env*`, `.dev.vars*`, generated
  `dist/`, or `node_modules/`. Repository access does not grant access to
  Cloudflare, Stripe, R2, D1, customer data, or any production secret.
- Do not deploy, publish, spend, or contact anyone unless the task from CG
  explicitly authorizes that action.

## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Design

Read `DESIGN.md` before touching any customer-facing page, especially
anything under `src/pages/account/`. The non-negotiables:

- The account hub is pages joined by view transitions (dashboard ->
  library -> book overview -> reader), never one stacked mega page.
- The frame is the store top bar plus a sidebar with the admin shell's
  mechanics (grouped nav, family switcher inside, user popover in the
  foot); /account is a dashboard (Welcome, stat cards, actions, shelf
  preview) and the full shelf lives at /account/library.
- The reader is the QC reader (`/read/[slug]` pattern): flip or scroll,
  color default, rendered inside the same sidebar frame. Do not build
  a second reader or player.
- Every list ships an empty state with one clear call to action.
- Customer copy: no em dashes, public book titles only (never internal
  slugs), one call to action per email, and every email kind needs a
  styled render branch in `src/lib/email-render.ts`.
- Club promises: first box ships within a few days of joining
  (`CLUB_PROCESSING_DAYS`), never same-day.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
- Astro build does NOT render auth-gated (prerender=false) pages, so a frontmatter ReferenceError in a shared component ships silently and blanks every signed-in page while signed-out checks (302s) and the build stay green (CustomerShell audioCount, 2026-11-01: ~10 min of blank account pages). After ANY CustomerShell/AdminShell change, a signed-in smoke check of a page that uses it is mandatory before calling it done, and nav/template identifiers must be pinned against the props destructure in tests.
