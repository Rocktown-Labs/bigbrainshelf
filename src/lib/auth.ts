import { env } from "cloudflare:workers";
import { betterAuth } from "better-auth";
import { admin, captcha, magicLink } from "better-auth/plugins";
import { kyselyAdapter } from "@better-auth/kysely-adapter";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { turnstileEnforced } from "./turnstile";

// Admin addresses live in lib/admins. A better-auth user created
// with an admin address gets the admin role automatically, and
// /auth/land routes admins into /admin after any sign-in.
import { isAdminEmail } from "./admins";

// Customer auth for the bigbrainshelf storefront (email + password).
// Separate from the hand-rolled admin_session cookie used by /admin.
export function getAuth() {
  const e = env as any;
  const db = new Kysely({ dialect: new D1Dialect({ database: e.DB }) });
  const plugins: any[] = [admin({ defaultRole: "user", adminRoles: ["admin"] })];
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
        endpoints: ["/sign-in/email", "/sign-up/email", "/request-password-reset"],
      })
    );
  }
  return betterAuth({
    database: kyselyAdapter(db, { type: "sqlite" }),
    baseURL: e.BETTER_AUTH_URL || "https://bookstore.rocktownlabs.app",
    secret: e.BETTER_AUTH_SECRET,
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
      cookieCache: { enabled: true, maxAge: 60 * 5 },
    },
    advanced: {
      cookiePrefix: "bbs",
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
