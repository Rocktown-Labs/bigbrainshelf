import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { isAdminEmail } from "../../../lib/admins";

// Admin user management (CG, 2026-10-31): the better-auth admin
// plugin is registered in lib/auth (roles + ban fields are its
// schema, and admin addresses get the admin role at sign-up).
// This page's data rides the house admin API instead of the
// plugin's client endpoints, so it works under the same admin
// sign-in as every other admin page; role/ban writes land in the
// exact columns the plugin reads, so a ban here is a ban at
// sign-in too.
//
// Scope guard (CG: "scope access to me"): the admin role can only
// ever be granted to one of CG's own addresses, and those
// accounts can never be banned or demoted from here.

async function listUsers(e: any) {
  await e.DB.prepare("ALTER TABLE user ADD COLUMN stripe_customer_id TEXT").run().catch(() => {});
  const rows = await e.DB.prepare(
    `SELECT id, name, email, emailVerified, role, banned, banReason, banExpires, createdAt, stripe_customer_id
       FROM user ORDER BY createdAt DESC LIMIT 200`
  ).all().catch(async () =>
    e.DB.prepare(
      `SELECT id, name, email, emailVerified, role, banned, banReason, banExpires, createdAt, NULL AS stripe_customer_id
         FROM user ORDER BY createdAt DESC LIMIT 200`
    ).all()
  );
  return (rows.results || []) as any[];
}

export const GET: APIRoute = async () => {
  const e = env as any;
  const users = await listUsers(e);
  return Response.json({
    users: users.map((u) => ({ ...u, can_admin: isAdminEmail(u.email) })),
    total: users.length,
  });
};

export const POST: APIRoute = async ({ request }) => {
  const e = env as any;
  const body = await request.json().catch(() => ({} as any));
  const userId = String(body?.user_id || "");
  const action = String(body?.action || "");
  if (!userId || !["set_role", "ban", "unban"].includes(action)) {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  const target: any = await e.DB.prepare("SELECT id, email, role FROM user WHERE id = ?").bind(userId).first();
  if (!target) return Response.json({ error: "user not found" }, { status: 404 });
  const ownerAccount = isAdminEmail(target.email);

  if (action === "set_role") {
    const role = String(body?.role || "user");
    if (role === "admin" && !ownerAccount) {
      return Response.json({ error: "The admin role is scoped to the owner's own addresses." }, { status: 403 });
    }
    if (role !== "admin" && ownerAccount) {
      return Response.json({ error: "Owner accounts keep the admin role." }, { status: 403 });
    }
    await e.DB.prepare("UPDATE user SET role = ? WHERE id = ?").bind(role, userId).run();
  } else if (action === "ban") {
    if (ownerAccount) return Response.json({ error: "Owner accounts cannot be banned." }, { status: 403 });
    await e.DB.prepare("UPDATE user SET banned = 1, banReason = ? WHERE id = ?")
      .bind(String(body?.reason || "Banned by admin").slice(0, 200), userId)
      .run();
  } else {
    await e.DB.prepare("UPDATE user SET banned = 0, banReason = NULL, banExpires = NULL WHERE id = ?").bind(userId).run();
  }
  const users = await listUsers(e);
  return Response.json({ ok: true, users: users.map((u) => ({ ...u, can_admin: isAdminEmail(u.email) })), total: users.length });
};
