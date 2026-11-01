// Scoped sender identities (CG, 2026-10-31): sign-in and system mail
// sends from noreply@, relationship mail from hello@, money and
// packages stay on the orders@ default, and marketing keeps its own
// explicit news@ sender. Pins senderForKind + the enqueue wiring.
import { readFileSync } from "node:fs";
import { senderForKind } from "../src/lib/orders";
import { NOREPLY_EMAIL, HELLO_EMAIL } from "../src/lib/email";

let fails = 0;
function assert(c: unknown, m: string) {
  if (c) console.log("PASS:", m);
  else {
    fails++;
    console.log("FAIL:", m);
  }
}

assert(senderForKind("magic_link") === "noreply@bigbrainshelf.com", "sign-in links send from noreply@");
assert(senderForKind("password_reset") === "noreply@bigbrainshelf.com", "password resets send from noreply@");
assert(senderForKind("contact_form") === "noreply@bigbrainshelf.com", "contact form forwards send from noreply@");
assert(senderForKind("family_onboarding") === "hello@bigbrainshelf.com", "family welcome sends from hello@");
assert(senderForKind("birthday_gift") === "hello@bigbrainshelf.com", "birthday gift sends from hello@");
assert(senderForKind("club_welcome") === "hello@bigbrainshelf.com", "club welcome sends from hello@");
assert(senderForKind("club_cycle_locked") === "hello@bigbrainshelf.com", "club box locked note sends from hello@");
assert(senderForKind("club_cycle_attention") === "hello@bigbrainshelf.com", "club box attention note sends from hello@");
assert(senderForKind("order_confirmation") === null, "order confirmations stay on the orders@ default");
assert(senderForKind("physical_update_shipped") === null, "shipping updates stay on the orders@ default");
assert(senderForKind("club_payment_failed") === null, "club billing problems stay on the orders@ default");
assert(senderForKind("club_canceled") === null, "club cancellations stay on the orders@ default");
assert(senderForKind("club_box_shipped") === null, "club box shipments stay on the orders@ default");
assert(senderForKind("owner_new_order") === null, "owner alerts stay on the orders@ default");
assert(
  NOREPLY_EMAIL === "noreply@bigbrainshelf.com" && HELLO_EMAIL === "hello@bigbrainshelf.com",
  "email.ts identity constants match the sender map"
);

const ordersSrc = readFileSync(new URL("../src/lib/orders.ts", import.meta.url), "utf8");
assert(
  ordersSrc.includes("args.fromEmail ?? senderForKind(args.kind)"),
  "enqueueEmail applies the kind map only when the caller set no sender"
);
const emailSrc = readFileSync(new URL("../src/lib/email.ts", import.meta.url), "utf8");
assert(
  emailSrc.includes("row.from_email === NOREPLY_EMAIL ? NOREPLY_EMAIL : SUPPORT_EMAIL"),
  "noreply@ mail carries itself as Reply-To, never support@"
);

console.log(fails ? `\n${fails} FAILURES` : "\nALL PASS");
process.exit(fails ? 1 : 0);
