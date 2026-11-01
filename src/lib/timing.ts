// Constant-time string comparison (F13, 2026-10-31). Hand-rolled
// session signatures and reset tokens were compared with !==, which
// leaks a length/prefix signal to a timing attacker. Both sides are
// digested first, so the comparison runs over a fixed 32 bytes and
// neither length nor content leaks through the loop.

export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a ?? ""))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b ?? ""))),
  ]);
  const ba = new Uint8Array(da);
  const bb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < ba.length; i++) {
    diff |= ba[i] ^ bb[i];
  }
  return diff === 0;
}
