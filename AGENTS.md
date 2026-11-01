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
