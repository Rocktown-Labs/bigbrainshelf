import { ensureOnce } from "./schema-cache";
import { validateUsernameFormat } from "./auth-client";
import { isAdminEmail } from "./admins";

// Database-side auth helpers, split out of lib/auth so they stay
// importable outside the Workers runtime (lib/auth imports
// cloudflare:workers at module level, which the repo's plain Bun
// test runner cannot load). lib/auth re-exports everything here and
// wraps getEffectiveSessionWith with the live env + getAuth session
// lookup, so runtime callers keep the exact same behavior.

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

  // Passkey plugin table (added 2026-10-31 with the passkey plugin in
  // lib/auth). Mirrors @better-auth/passkey's schema for this version:
  // aaguid is the field name (not aauthGuid).
  await ensureOnce(db, "better_auth_passkey_v1", async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS "passkey" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "name" TEXT,
          "publicKey" TEXT NOT NULL,
          "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
          "credentialID" TEXT NOT NULL,
          "counter" INTEGER NOT NULL,
          "deviceType" TEXT NOT NULL,
          "backedUp" INTEGER NOT NULL,
          "transports" TEXT,
          "createdAt" DATE,
          "aaguid" TEXT
        )`
      )
      .bind()
      .run();
    await db
      .prepare('CREATE INDEX IF NOT EXISTS passkey_userId_idx ON "passkey"("userId")')
      .bind()
      .run()
      .catch(() => {});
    await db
      .prepare('CREATE INDEX IF NOT EXISTS passkey_credentialID_idx ON "passkey"("credentialID")')
      .bind()
      .run()
      .catch(() => {});
  });

  // Rate-limit table for better-auth's database storage (added
  // 2026-10-31). Keys are endpoint + IP; lastRequest is epoch ms.
  await ensureOnce(db, "better_auth_ratelimit_v1", async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS "rateLimit" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "key" TEXT NOT NULL,
          "count" INTEGER NOT NULL,
          "lastRequest" INTEGER NOT NULL
        )`
      )
      .bind()
      .run();
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

export interface EffectiveUser {
  id: string;
  email: string;
  name: string;
  username: string | null;
  displayUsername: string | null;
  role: string;
  isAdmin: boolean;
  /**
   * Whether Better Auth has verified this session's email
   * (magic-link + Google set it; password accounts verify via the
   * sign-up email). Callers that key entitlements, club rows, or
   * admin recognition on the email must check this
   * (SECURITY-FINDINGS F1/F2).
   */
  emailVerified: boolean;
}

/**
 * Resolves the signed-in user across both Better Auth customer sessions and
 * the owner `admin_session` cookie (stored on `locals.user`), so an admin
 * account can seamlessly access `/account` (`/accounts`) as well as `/admin`.
 */
export async function getEffectiveSessionWith(
  request: Request,
  locals: any,
  db: any,
  getSession: ((headers: Headers) => Promise<any>) | null
): Promise<{ user: EffectiveUser } | null> {
  if (db) {
    await ensureAuthUserSchema(db).catch(() => {});
  }

  try {
    const s = getSession ? await getSession(request.headers) : null;
    if (s?.user) {
      const u = s.user as any;
      const email = String(u.email || "").toLowerCase();
      const emailVerified = u.emailVerified === true || u.emailVerified === 1;
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
          emailVerified,
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
        // The admin_session cookie is minted only after the admin
        // password proof or a verified owner sign-in (lib/auth +
        // /auth/land), so this bridge is trusted as verified.
        emailVerified: true,
      },
    };
  }

  return null;
}
