import { env } from "cloudflare:workers";
import { betterAuth } from "better-auth";
import { admin, captcha, magicLink, username } from "better-auth/plugins";
import { kyselyAdapter } from "@better-auth/kysely-adapter";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { turnstileEnforced } from "./turnstile";
import { ensureOnce } from "./schema-cache";
import {
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_REGEX,
  validateUsernameFormat,
} from "./auth-client";

// Admin addresses live in lib/admins. A better-auth user created
// with an admin address gets the admin role automatically, and
// /auth/land routes admins into /admin after any sign-in.
import { isAdminEmail } from "./admins";

/**
 * Ensures the Better Auth "user" table exists and carries the columns required
 * by the `username` and `admin` plugins (`username`, `displayUsername`, `role`,
 * `banned`, `banReason`, `banExpires`). Runs at most once per D1 isolate.
 */
export async function ensureAuthUserSchema(db: any): Promise<void> {
  if (!db) return;
  await ensureOnce(db, "better_auth_user_username_v1", async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS "user" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "name" TEXT NOT NULL,
          "email" TEXT NOT NULL UNIQUE,
          "emailVerified" INTEGER NOT NULL DEFAULT 0,
          "image" TEXT,
          "username" TEXT UNIQUE,
          "displayUsername" TEXT,
          "role" TEXT DEFAULT 'user',
          "banned" INTEGER DEFAULT 0,
          "banReason" TEXT,
          "banExpires" INTEGER,
          "createdAt" DATE NOT NULL,
          "updatedAt" DATE NOT NULL
        )`
      )
      .bind()
      .run();

    try {
      const info = await db.prepare('PRAGMA table_info("user")').bind().all();
      const cols = new Set(
        ((info?.results || info?.rows || []) as any[]).map((r) => String(r.name))
      );
      const addCol = async (col: string, ddl: string) => {
        if (!cols.has(col)) {
          await db.prepare(`ALTER TABLE "user" ADD COLUMN ${ddl}`).bind().run();
        }
      };
      await addCol("username", "username TEXT");
      await addCol("displayUsername", "displayUsername TEXT");
      await addCol("role", "role TEXT DEFAULT 'user'");
      await addCol("banned", "banned INTEGER DEFAULT 0");
      await addCol("banReason", "banReason TEXT");
      await addCol("banExpires", "banExpires INTEGER");
    } catch {
      // Ignore pragma errors if table is already up to date
    }

    await db
      .prepare(
        'CREATE UNIQUE INDEX IF NOT EXISTS user_username_idx ON "user"(username) WHERE username IS NOT NULL'
      )
      .bind()
      .run()
      .catch(() => {});
  });
}

export async function checkUsernameAvailabilityInDb(
  db: any,
  rawUsername: string,
  excludeUserId?: string | null
): Promise<{
  available: boolean;
  normalized: string;
  displayUsername: string;
  error?: string;
}> {
  const fmt = validateUsernameFormat(rawUsername);
  if (!fmt.valid) {
    return {
      available: false,
      normalized: fmt.normalized,
      displayUsername: fmt.displayUsername,
      error: fmt.error,
    };
  }
  await ensureAuthUserSchema(db);
  const existing = await db
    .prepare('SELECT id FROM "user" WHERE lower(username) = ? LIMIT 1')
    .bind(fmt.normalized)
    .first()
    .catch(() => null);
  if (existing && (!excludeUserId || String(existing.id) !== String(excludeUserId))) {
    return {
      available: false,
      normalized: fmt.normalized,
      displayUsername: fmt.displayUsername,
      error: "That username is already taken.",
    };
  }
  return {
    available: true,
    normalized: fmt.normalized,
    displayUsername: fmt.displayUsername,
  };
}

export async function updateUserUsernameInDb(
  db: any,
  userId: string,
  rawUsername: string | null | undefined,
  rawName?: string | null
): Promise<{
  ok: boolean;
  username: string | null;
  displayUsername: string | null;
  error?: string;
}> {
  await ensureAuthUserSchema(db);
  const trimmed = String(rawUsername ?? "").trim().replace(/^@+/, "");
  if (!trimmed) {
    if (rawName && String(rawName).trim()) {
      await db
        .prepare('UPDATE "user" SET name = ?, updatedAt = ? WHERE id = ?')
        .bind(String(rawName).trim(), new Date().toISOString(), userId)
        .run()
        .catch(() => {});
    }
    const row = await db
      .prepare('SELECT username, displayUsername FROM "user" WHERE id = ?')
      .bind(userId)
      .first()
      .catch(() => null);
    return {
      ok: true,
      username: row?.username ? String(row.username) : null,
      displayUsername: row?.displayUsername ? String(row.displayUsername) : null,
    };
  }

  const check = await checkUsernameAvailabilityInDb(db, trimmed, userId);
  if (!check.available) {
    return {
      ok: false,
      username: null,
      displayUsername: null,
      error: check.error || "Username is not available.",
    };
  }

  const nowIso = new Date().toISOString();
  if (rawName && String(rawName).trim()) {
    await db
      .prepare(
        'UPDATE "user" SET username = ?, displayUsername = ?, name = ?, updatedAt = ? WHERE id = ?'
      )
      .bind(check.normalized, check.displayUsername, String(rawName).trim(), nowIso, userId)
      .run();
  } else {
    await db
      .prepare('UPDATE "user" SET username = ?, displayUsername = ?, updatedAt = ? WHERE id = ?')
      .bind(check.normalized, check.displayUsername, nowIso, userId)
      .run();
  }
  return {
    ok: true,
    username: check.normalized,
    displayUsername: check.displayUsername,
  };
}

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
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof getAuth>;

export interface EffectiveUser {
  id: string;
  email: string;
  name: string;
  username: string | null;
  displayUsername: string | null;
  role: string;
  isAdmin: boolean;
}

/**
 * Resolves the signed-in user across both Better Auth customer sessions and
 * the owner `admin_session` cookie (stored on `locals.user`), so an admin
 * account can seamlessly access `/account` (`/accounts`) as well as `/admin`.
 */
export async function getEffectiveSession(
  request: Request,
  locals?: any,
  dbOverride?: any
): Promise<{ user: EffectiveUser } | null> {
  const e = env as any;
  const db = dbOverride || e?.DB;
  if (db) {
    await ensureAuthUserSchema(db).catch(() => {});
  }

  try {
    const s = await getAuth().api.getSession({ headers: request.headers });
    if (s?.user) {
      const u = s.user as any;
      const email = String(u.email || "").toLowerCase();
      const adminFlag = isAdminEmail(email) || u.role === "admin";
      let usernameVal = u.username ? String(u.username) : null;
      let displayUsernameVal = u.displayUsername ? String(u.displayUsername) : null;
      if (!usernameVal && db) {
        const row = await db
          .prepare('SELECT username, displayUsername, name FROM "user" WHERE id = ? LIMIT 1')
          .bind(u.id)
          .first()
          .catch(() => null);
        if (row?.username) usernameVal = String(row.username);
        if (row?.displayUsername) displayUsernameVal = String(row.displayUsername);
      }
      return {
        user: {
          id: String(u.id),
          email: String(u.email || ""),
          name: String(u.name || email.split("@")[0] || "Reader"),
          username: usernameVal,
          displayUsername: displayUsernameVal || usernameVal,
          role: adminFlag ? "admin" : String(u.role || "user"),
          isAdmin: adminFlag,
        },
      };
    }
  } catch {
    // Fall through to admin_session bridge
  }

  const adminEmail = locals?.user?.email ? String(locals.user.email).toLowerCase() : null;
  if (adminEmail && isAdminEmail(adminEmail)) {
    let userId = `admin_${adminEmail.replace(/[^a-z0-9]/g, "_")}`;
    let name = adminEmail.split("@")[0] || "Admin";
    let usernameVal: string | null = null;
    let displayUsernameVal: string | null = null;

    if (db) {
      try {
        const existing = await db
          .prepare(
            'SELECT id, name, username, displayUsername FROM "user" WHERE lower(email) = ? LIMIT 1'
          )
          .bind(adminEmail)
          .first();
        if (existing) {
          userId = String(existing.id);
          name = String(existing.name || name);
          usernameVal = existing.username ? String(existing.username) : null;
          displayUsernameVal = existing.displayUsername
            ? String(existing.displayUsername)
            : usernameVal;
        } else {
          const nowIso = new Date().toISOString();
          await db
            .prepare(
              `INSERT OR IGNORE INTO "user" ("id", "name", "email", "emailVerified", "role", "createdAt", "updatedAt")
               VALUES (?, ?, ?, 1, 'admin', ?, ?)`
            )
            .bind(userId, name, adminEmail, nowIso, nowIso)
            .run();
        }
      } catch {
        // Ignore if user table is unavailable in synthetic test env
      }
    }

    return {
      user: {
        id: userId,
        email: adminEmail,
        name,
        username: usernameVal,
        displayUsername: displayUsernameVal,
        role: "admin",
        isAdmin: true,
      },
    };
  }

  return null;
}

