import type { APIRoute } from "astro";

export const POST: APIRoute = async () => {
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": "admin_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    },
  });
};
