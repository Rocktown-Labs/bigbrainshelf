# Big Brain Shelf

<div align="center">
  <h3>Stories, audio, and a growing shelf for curious kids</h3>
  <p>A children's book storefront with audiobooks, family accounts, a reader, clubs, and the publishing tools behind each release.</p>
</div>

[bigbrainshelf.com](https://bigbrainshelf.com)

---

## 1. Executive Summary

**Big Brain Shelf** brings children's books and related experiences together in one place. Families can discover books and audiobooks, shop, join clubs, manage an account library, and read or listen from the site. Store administrators use a private workspace to manage the catalog, orders, editorial readiness, casting, fulfillment, and customer communications.

The production web experience is currently one Astro application deployed to Cloudflare Workers. The repository also contains the source for a separate kidsbook factory Worker. Dedicated API and mobile workspaces are present as the project grows toward a broader monorepo; the current storefront and its API routes remain under `src/`.

## 2. Platform Architecture

```text
                         Big Brain Shelf storefront
                                  Astro
                                    │
              ┌─────────────────────┼────────────────────┐
              ▼                     ▼                    ▼
       Public catalog         Family accounts       Admin workspace
       books, audio, clubs     library, reader       catalog, orders, QC
              └─────────────────────┬────────────────────┘
                                    │
                          Astro API endpoints
                                    │
         ┌──────────────────┬───────┴────────┬─────────────────┐
         ▼                  ▼                ▼                 ▼
   Cloudflare D1       Stripe checkout    Shippo shipping   Email outbox
                                   
           Separate kidsbook-factory Cloudflare Worker
       build · colorize · repair · page fixes · assemble PDFs
```

| Layer | Technologies and responsibilities |
| --- | --- |
| Web | Astro with React components and Tailwind CSS |
| Runtime | Cloudflare Workers using the Astro Cloudflare adapter |
| Database | Cloudflare D1, with Kysely and Drizzle tooling |
| Authentication | Better Auth with a D1 adapter |
| Commerce | Stripe checkout, offers, order handling, and shipping integration through Shippo |
| Email | React Email templates and an order / notification outbox |
| Book production | Separate Cloudflare Worker for book building, colorization, repair, page fixes, and PDF assembly |
| Workspace | Bun scripts, Python build/deploy helpers, and Wrangler configuration for the factory Worker |

Offer and pricing rules live in `src/lib/offers.ts`; public book URLs use public slugs. Keep these buyer-facing rules in shared logic so the storefront, future API, and mobile clients can use the same definitions.

## 3. Product Experiences

### Storefront

- Browse books, audiobooks, book clubs, merchandise, and plans.
- View book and audiobook details, then add eligible items to the cart.
- Complete checkout and return to order and receipt pages.
- Explore the Meet the Cast experience and supporting editorial pages.
- Use the English storefront or the Spanish route where available.

### Family account and reading

- Create and manage an account, complete onboarding, and review account settings.
- Browse the account library and order history.
- Open books in the reader and access audiobook listening pages.
- Manage child profiles and club participation from the account area.

### Store administration

The admin workspace includes tools for:

- Books, Bibles, audiobooks, characters, and cast management.
- Editorial review, publishing readiness, and book revision workflows.
- Orders, fulfillment, customer records, and account support.
- Clubs, reviews, notifications, and operational dashboards.
- Image and media uploads for book and cast materials.

### Book production factory

The separate `factory/` Worker contains the production pipeline shared by authorized operators. Its modules cover book building, colorization, page repair, targeted page fixes, PDF assembly, edition/version handling, and workflow telemetry. `factory-ops/` holds supporting audit and operations utilities; its dated audit folders are evidence records and should be extended rather than rewritten.

## 4. Repository Structure

```text
bigbrainshelf/
├── src/
│   ├── pages/               # Storefront, account, reader, and admin routes
│   ├── pages/api/           # Checkout, publishing, clubs, media, and webhooks
│   ├── lib/                 # Offers, orders, email outbox, readiness, and slugs
│   └── emails/              # Transactional email templates
├── apps/
│   ├── web/                 # Web application workspace
│   ├── api/                 # Dedicated API workspace scaffold
│   └── mobile/              # Mobile application workspace scaffold
├── packages/
│   └── core/                # Shared book, revision, assembly, and provenance logic
├── factory/                 # Kidsbook factory Worker source and design contracts
├── factory-ops/             # Factory audits and operational tools
├── tests/                   # Bun test files
└── scripts/                 # Worker build and repository utilities
```

The `apps/api` and `apps/mobile` directories are part of the monorepo direction; they are not a replacement for the current `src/pages/api/` implementation.

## 5. Local Development

### Prerequisites

- Bun for dependency installation and test execution
- Python 3 for the Worker build and deploy helpers
- Cloudflare credentials only when using deployed Cloudflare resources

Install dependencies and start the storefront:

```bash
bun install
bun run dev
```

The development script runs Astro. When starting the server as a background process, use the repository's background mode:

```bash
astro dev --background
```

Local environment files such as `.env*` and `.dev.vars*` are gitignored. Provider secrets belong in the Worker secret store and must not be committed.

## 6. Build, Test, and Deploy

Build the hub Worker entry before deployment:

```bash
bun run build
python3 deploy.py
```

The deploy helper uses the Cloudflare Workers Assets flow and does not build the application for you. The factory has its own build and deployment workflow under `factory/`; keep its source in this repository and reconcile any deployment workspace changes before a factory deployment.

Tests are plain Bun test files and can be run individually:

```bash
bun tests/<file>.test.ts
```

The repository README currently records two known baseline failures caused by existing i18n behavior: `cart-resolution` and `home-filters`. Keep unrelated tests passing and call out those baselines when reporting test results.

## 7. Shared Code and Release Rules

- Keep reusable offer, pricing, order, publishing, and readiness rules in `src/lib/`.
- Use public book titles in customer-facing copy and public slugs in public URLs; internal identifiers should stay internal.
- Keep factory source changes in `factory/` and commit them here so the repository remains the shared source of truth.
- Treat `factory-ops/audits/` as historical evidence. Add a new dated run for new measurements rather than rewriting an old run.
- Do not commit credentials, `.env*`, `.dev.vars*`, generated `dist/`, or `node_modules/`.

## 8. Useful Links

- [Big Brain Shelf](https://bigbrainshelf.com)
- [Astro documentation](https://docs.astro.build)
- [Repository access guide](docs/agent-access.md)
