// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://bigbrainshelf.com',
  adapter: cloudflare(),
  // React is used only for the React Email templates under emails/
  // (rendered to HTML strings at send time by src/lib/email-render.ts).
  integrations: [react()],
  output: 'server',
  // i18n seams (Phase 0): Astro's built-in routing is the foundation
  // for localized editions. prefixDefaultLocale: false keeps every
  // existing English URL exactly where it is today; the other locales
  // exist as routing space (plus the dark /es proof route) until
  // translated editions land in Phase 2. Locale data lives in
  // src/lib/i18n.ts; do not hand-roll locale paths elsewhere.
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'es', 'pt', 'fr', 'de', 'it', 'nl'],
    routing: {
      prefixDefaultLocale: false,
    },
  },
  // Prefetch per the Astro prefetch guide: on pages that carry the
  // ClientRouter (the storefront shells), every link is prefetched
  // with the hover strategy (a desktop hover or a mobile touch both
  // start it), so the destination HTML is already local when the tap
  // lands and a view transition never waits on the network. API
  // routes are never <a> links, and the admin shell does not use the
  // router, so nothing authenticated is prefetched.
  prefetch: { prefetchAll: true, defaultStrategy: 'hover' },
  vite: {
    // Tailwind compiles src/styles/global.css at build time. The store
    // used to load the @tailwindcss/browser runtime from a CDN, whose
    // generated styles did not survive Astro view-transition page swaps
    // (pages rendered unstyled until a hard refresh).
    plugins: [tailwindcss()],
  },
});
