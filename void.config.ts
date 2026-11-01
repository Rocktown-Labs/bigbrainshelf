import { defineConfig } from 'void/config';

export default defineConfig({
  cloudflare: {
    name: 'bigbrainshelf',
    compatibility_date: '2026-10-16',
    compatibility_flags: ['nodejs_als'],
  },
});
