import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { hashPassword } from "../../../lib/adminpass";

// One-time admin password reset. The token lives in the settings table as
// 'admin_reset_token' with value '<token>:<expiryEpochMs>'. A successful
// reset stores 'admin_password_hash' and deletes the token.
export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const { token, password } = await request.json().catch(() => ({}));

  if (!token || !password || typeof password !== "string" || password.length < 8) {
    return Response.json(
      { error: "Password must be at least 8 characters." },
      { status: 400 }
    );
  }

  const row: any = await e.DB.prepare(
    "SELECT value FROM settings WHERE key = 'admin_reset_token'"
  ).first();
  if (!row?.value) {
    return Response.json({ error: "Reset link is invalid or already used." }, { status: 400 });
  }
  const [savedToken, expiryStr] = String(row.value).split(":");
  if (token !== savedToken || Date.now() > Number(expiryStr || 0)) {
    return Response.json({ error: "Reset link is invalid or expired." }, { status: 400 });
  }

  const hash = await hashPassword(password);
  const now = Date.now();
  await e.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('admin_password_hash', ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(hash, now).run();
  await e.DB.prepare("DELETE FROM settings WHERE key = 'admin_reset_token'").run();

  return Response.json({ ok: true });
};
