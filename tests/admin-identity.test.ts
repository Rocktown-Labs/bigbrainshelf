// SECURITY F2 (2026-10-31): admin identity must never be minted from
// an unverified email. Source pins over the surfaces that grant admin
// recognition, plus a live run of the allowlist health check against
// an in-memory DB. Run with: bun tests/admin-identity.test.ts
import { Database } from "bun:sqlite";
import { ADMIN_EMAILS, isAdminEmail } from "../src/lib/admins";
import { ensureAuthUserSchema } from "../src/lib/auth-users";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const read = async (rel: string) =>
  Bun.file(new URL(rel, import.meta.url)).text();

// ---- The role hook is gone ------------------------------------------------
const authSrc = await read("../src/lib/auth.ts");
assert(
  !authSrc.includes('role: "admin"'),
  "sign-up hook no longer mints role=admin from the email (F2)"
);
assert(
  authSrc.includes("sendOnSignUp: true"),
  "verification email is sent on sign-up (F1 soft gate companion)"
);

// ---- Verified requirement at every admin recognition point ---------------
const middlewareSrc = await read("../src/middleware.ts");
assert(
  middlewareSrc.includes('isAdminEmail(s.user.email) && (s.user as any).emailVerified === true'),
  "middleware BA bridge requires a verified session for admin emails"
);

const landSrc = await read("../src/pages/auth/land.astro");
assert(
  landSrc.includes("emailVerified && (role === \"admin\" || isAdminEmail(email))"),
  "/auth/land grants admin only for a verified session"
);
assert(
  landSrc.includes("emailVerified && isAdminEmail(email) && role !== \"admin\""),
  "the role self-heal requires a verified session (F2)"
);

const authUsersSrc = await read("../src/lib/auth-users.ts");
assert(
  authUsersSrc.includes("emailVerified && (isAdminEmail(email) || u.role === \"admin\")"),
  "getEffectiveSession flags isAdmin only for verified sessions (role rows included)"
);

const googleCbSrc = await read("../src/pages/api/auth/callback/google.ts");
assert(
  googleCbSrc.includes("user.verified_email !== true"),
  "admin Google callback requires a provider-verified email"
);

const bookPagesSrc = await read("../src/pages/api/account/book-pages.ts");
assert(
  bookPagesSrc.includes("isAdminEmail(user.email) && session.user.emailVerified === true"),
  "book-pages admin bypass requires a verified session"
);

// ---- The public reset page no longer lists the admin addresses ------------
const resetSrc = await read("../src/pages/admin/reset-password.astro");
for (const addr of ADMIN_EMAILS) {
  assert(
    !resetSrc.toLowerCase().includes(addr.split("@")[0]),
    `reset page does not advertise ${addr}`
  );
}

// ---- Allowlist health check (live, in-memory DB) ---------------------------
const raw = new Database(":memory:");
const logs: string[] = [];
const origError = console.error;
console.error = (...args: any[]) => {
  logs.push(args.join(" "));
};
const db = {
  prepare(sql: string) {
    return {
      bind(...args: any[]) {
        const stmt = raw.query(sql);
        return {
          async run() { const r = stmt.run(...args) as any; return { meta: { changes: r?.changes ?? 0 } }; },
          async first() { return stmt.get(...args) ?? null; },
          async all() { return { results: stmt.all(...args) }; },
        };
      },
    };
  },
} as any;
try {
  await ensureAuthUserSchema(db);
} finally {
  console.error = origError;
}
assert(
  logs.some((l) => l.includes("admin allowlist check") && l.includes("no user row")),
  "boot health check warns when an allowlisted address has no user row"
);

// A verified admin row silences the claimable warning.
raw.query(
  `INSERT INTO "user" ("id", "name", "email", "emailVerified", "role", "createdAt", "updatedAt")
   VALUES ('u-1', 'Owner', ?, 1, 'admin', '2026-11-01', '2026-11-01')`
).run(ADMIN_EMAILS[0]);
const logs2: string[] = [];
console.error = (...args: any[]) => { logs2.push(args.join(" ")); };
try {
  // Force a fresh health check on a new db-identity key by using a new
  // wrapper object (ensureOnce keys on the db object identity).
  const db2 = { prepare: (db as any).prepare.bind(db) };
  await ensureAuthUserSchema(db2);
} finally {
  console.error = origError;
}
assert(
  !logs2.some((l) => l.includes(ADMIN_EMAILS[0]) && l.includes("no user row")),
  "a verified admin row is not reported as claimable"
);

assert(isAdminEmail(ADMIN_EMAILS[0]) && !isAdminEmail("attacker@example.com"), "allowlist matching unchanged");

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll admin identity tests passed.");
