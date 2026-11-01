import { env } from "cloudflare:workers";
import { betterAuth } from "better-auth";
import { admin, captcha, lastLoginMethod, magicLink, username } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { kyselyAdapter } from "@better-auth/kysely-adapter";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { turnstileEnforced } from "./turnstile";
import {
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_REGEX,
} from "./auth-client";

// Admin addresses live in lib/admins. A better-auth user created
// with an admin address gets the admin role automatically, and
// /auth/land routes admins into /admin after any sign-in.
import { isAdminEmail } from "./admins";
import {
  ensureAuthUserSchema,
  checkUsernameAvailabilityInDb,
  updateUserUsernameInDb,
  getEffectiveSessionWith,
} from "./auth-users";
export {
  ensureAuthUserSchema,
  checkUsernameAvailabilityInDb,
  updateUserUsernameInDb,
} from "./auth-users";
export type { EffectiveUser } from "./auth-users";

// Customer auth for the bigbrainshelf storefront (email + username + password).
// Separate from the hand-rolled admin_session cookie used by /admin,
// though getEffectiveSession bridges both so admins can access /account & /accounts.
export function getAuth() {
  const e = env as any;
  const db = new Kysely({ dialect: new D1Dialect({ database: e.DB }) });
  const plugins: any[] = [
    admin({ defaultRole: "user", adminRoles: ["admin"] }),
    username({
      minUsernameLength: USERNAME_MIN_LENGTH,
      maxUsernameLength: USERNAME_MAX_LENGTH,
      usernameValidator: (u) => USERNAME_REGEX.test(u),
    }),
    // Remembers how the user signed in last (cookie-based) so /login
    // can badge the "Last used" method (CG, 2026-10-31).
    lastLoginMethod(),
    // Passkeys (CG, 2026-10-31): WebAuthn sign-in bound to the real
    // domain; registration lives in the account hub's security
    // section, sign-in on /login. Table self-heals via
    // ensureAuthUserSchema (lib/auth-users).
    passkey({
      rpID: "bigbrainshelf.com",
      rpName: "Big Brain Shelf",
      origin: "https://bigbrainshelf.com",
    }),
  ];
  // Passwordless sign-in (CG, 2026-10-31): guest buyers never
  // made a password, so the way back into their library is a
  // one-click email link. The link rides the store's own outbox
  // (kind "magic_link", rendered in the branded shell) and the
  // outbox is flushed immediately, because a 15-minute link
  // cannot wait for the quarter-hour mail tick. Sign-up through
  // the link stays enabled: a guest's first click creates their
  // account, and their purchases are already waiting, because
  // the library matches orders by email as well as by user id.
  plugins.push(
    magicLink({
      expiresIn: 60 * 15,
      sendMagicLink: async ({ email, url }: { email: string; url: string }) => {
        const { enqueueEmail } = await import("./orders");
        const { flushOutbox } = await import("./email");
        const db = (env as any).DB;
        await enqueueEmail(db, {
          orderId: null,
          kind: "magic_link",
          to: email,
          subject: "Your Big Brain Shelf sign-in link",
          text:
            `Tap below to sign in to Big Brain Shelf and open your library. The link works once and expires in 15 minutes.\n\n` +
            `${url}\n\n` +
            `If you did not ask for this link, you can ignore this email.\n`,
        });
        await flushOutbox(db, env as any, 10).catch(() => {});
      },
    })
  );
  // Turnstile on the credential endpoints, reusing the newsletter
  // form's widget and keys (lib/turnstile). The plugin verifies the
  // x-captcha-response header in its onRequest hook, before the
  // sign-in / sign-up / password-reset handlers run, so a failed
  // check means the credential check never happens. Registered only
  // when both keys are set (turnstileEnforced), so an unkeyed
  // environment behaves exactly as before. Social sign-in is an
  // OAuth redirect flow and is not (and cannot be) gated.
  if (turnstileEnforced(e)) {
    plugins.push(
      captcha({
        provider: "cloudflare-turnstile",
        secretKey: String(e.TURNSTILE_SECRET_KEY).trim(),
        endpoints: [
          "/sign-in/email",
          "/sign-in/username",
          "/sign-up/email",
          "/request-password-reset",
          "/sign-in/magic-link",
        ],
      })
    );
  }
  return betterAuth({
    database: kyselyAdapter(db, { type: "sqlite" }),
    baseURL: e.BETTER_AUTH_URL || "https://bookstore.rocktownlabs.app",
    secret: e.BETTER_AUTH_SECRET,
    user: {
      changeEmail: {
        enabled: true,
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      minPasswordLength: 8,
      // Password resets ride the same outbox as everything else
      // (branded template at render time) and flush immediately:
      // a reset link cannot wait for the quarter-hour tick.
      sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
        const { enqueueEmail } = await import("./orders");
        const { flushOutbox } = await import("./email");
        const db = (env as any).DB;
        await enqueueEmail(db, {
          orderId: null,
          kind: "password_reset",
          to: user.email,
          subject: "Reset your Big Brain Shelf password",
          text:
            `Tap the link below to set a new password for your Big Brain Shelf account. If you did not ask for a reset, you can ignore this email; your password stays the same.\n\n${url}`,
          dedupeKey: null,
        });
        await flushOutbox(db, env as any, 5).catch(() => {});
      },
    },
    socialProviders: {
      google: {
        clientId: e.GOOGLE_CLIENT_ID || "",
        clientSecret: e.GOOGLE_CLIENT_SECRET || "",
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days
      updateAge: 60 * 60 * 24, // refresh the session at most once a day
      cookieCache: { enabled: true, maxAge: 60 * 5 },
    },
    // Rate limiting (CG, 2026-10-31): database storage so limits hold
    // across Workers isolates (table self-heals via lib/auth-users).
    // Built-in strict rules cover the credential endpoints; the
    // custom rules below protect the passwordless + reset flows,
    // which send real email and are the juiciest abuse targets.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      storage: "database",
      customRules: {
        "/sign-in/magic-link": { window: 60, max: 5 },
        "/request-password-reset": { window: 60, max: 5 },
      },
    },
    advanced: {
      cookiePrefix: "bbs",
      ipAddress: {
        // Behind Cloudflare, the client IP is cf-connecting-ip;
        // without this the limiter keys on a shared proxy address.
        ipAddressHeaders: ["cf-connecting-ip"],
      },
    },
    plugins,
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (isAdminEmail(user.email)) {
              return { data: { ...user, role: "admin" } };
            }
            return { data: user };
          },
          // Every new account gets its Stripe customer up front
          // (CG, 2026-10-31), so checkout, clubs, and the admin
          // never mint one ad hoc. Best effort by design: a Stripe
          // hiccup must never block a sign-up; the id lands on the
          // user row and anything that finds it missing can still
          // create one lazily, as checkout does today.
          after: async (user) => {
            try {
              const db = (env as any).DB;
              const secret = String((env as any).STRIPE_SECRET_KEY || "").trim();
              if (!db || !secret || !user?.email) return;
              await db.prepare("ALTER TABLE user ADD COLUMN stripe_customer_id TEXT").run().catch(() => {});
              const existing = await db
                .prepare("SELECT stripe_customer_id FROM user WHERE id = ?")
                .bind(user.id)
                .first()
                .catch(() => null);
              if ((existing as any)?.stripe_customer_id) return;
              const Stripe = (await import("stripe")).default;
              const stripe = new Stripe(secret);
              const customer = await stripe.customers.create({
                email: user.email,
                name: user.name || undefined,
                metadata: { bbs_user_id: String(user.id) },
              });
              await db
                .prepare("UPDATE user SET stripe_customer_id = ? WHERE id = ?")
                .bind(customer.id, user.id)
                .run();
            } catch (err) {
              console.error("stripe customer create failed", (err as any)?.message || err);
            }
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof getAuth>;

/**
 * Resolves the signed-in user across both Better Auth customer sessions and
 * the owner `admin_session` cookie (stored on `locals.user`), so an admin
 * account can seamlessly access `/account` (`/accounts`) as well as `/admin`.
 * The logic lives in lib/auth-users (getEffectiveSessionWith); this wrapper
 * supplies the Workers env DB and the live better-auth session lookup.
 */
export async function getEffectiveSession(
  request: Request,
  locals?: any,
  dbOverride?: any
): Promise<{ user: import("./auth-users").EffectiveUser } | null> {
  const e = env as any;
  return getEffectiveSessionWith(request, locals, dbOverride || e?.DB, async (headers) => {
    try {
      return await getAuth().api.getSession({ headers });
    } catch {
      return null;
    }
  });
}
