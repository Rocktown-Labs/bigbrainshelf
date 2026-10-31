// Newsletter email validation tests: the strict validator table, the
// subscribe write path (invalid writes nothing, valid writes one
// normalized row, duplicate is an idempotent success), and source
// pins on the route + footer form. Runs the real src/lib code
// against an in-memory bun:sqlite database.
// Run with: bun tests/email-validate.test.ts
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  validateEmail,
  normalizeEmail,
  addSubscriber,
  sanitizeSubscriberName,
  INVALID_EMAIL_MESSAGE,
} from "../src/lib/email-validate";
import {
  turnstileEnforced,
  verifyTurnstileToken,
  TURNSTILE_FAILED_MESSAGE,
} from "../src/lib/turnstile";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

// --- Validator table
const VALID: Array<[string, string]> = [
  ["reader@example.com", "reader@example.com"],
  ["reader+tag@example.com", "reader+tag@example.com"],
  ["reader@mail.example.co.uk", "reader@mail.example.co.uk"],
  ["READER@Example.COM", "reader@example.com"],
  ["  spaced@example.com  ", "spaced@example.com"],
  ["a.b-c@x-y.example.io", "a.b-c@x-y.example.io"],
  [`${"a".repeat(64)}@example.com`, `${"a".repeat(64)}@example.com`],
];
for (const [input, expected] of VALID) {
  const v = validateEmail(input);
  assert(v.ok && v.email === expected, `valid: ${JSON.stringify(input)} -> ${expected}`);
}

const INVALID: Array<[string, string]> = [
  ["", "empty"],
  ["   ", "whitespace only"],
  ["no-at-sign.example.com", "no @"],
  ["two@@example.com", "two @ (adjacent)"],
  ["a@b@example.com", "two @"],
  ["reader@example", "no domain dot"],
  ["read er@example.com", "space in local part"],
  ["reader@exam ple.com", "space in domain"],
  ["rea..der@example.com", "consecutive dots in local part"],
  ["@example.com", "empty local part"],
  [`${"a".repeat(65)}@example.com`, "65-char local part"],
  ["reader@example.c", "one-letter TLD"],
  ["reader@example.123", "numeric TLD"],
  ["reader@.example.com", "empty first domain label"],
  ["reader@example..com", "empty middle domain label"],
  ["reader@-example.com", "domain label starts with hyphen"],
  ["reader@example-.com", "domain label ends with hyphen"],
  [".reader@example.com", "local part starts with a dot"],
  ["reader.@example.com", "local part ends with a dot"],
  // Every part individually legal, but the whole address runs past 254 chars.
  [`${"a".repeat(64)}@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(60)}.com`, "total over 254 chars"],
  [null as any, "null"],
  [undefined as any, "undefined"],
  [42 as any, "number"],
];
for (const [input, why] of INVALID) {
  assert(!validateEmail(input).ok, `invalid (${why}): ${JSON.stringify(input)}`);
}
assert(normalizeEmail("  MixedCase@Example.COM ") === "mixedcase@example.com", "normalizeEmail trims and lowercases");
assert(INVALID_EMAIL_MESSAGE === "That email does not look right.", "the plain error message is the agreed copy");

// --- Subscribe write path against a real (in-memory) database
const raw = new Database(":memory:");
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
const subCount = () => (raw.query("SELECT COUNT(*) AS n FROM subscribers").get() as any).n as number;

// Invalid input (even before the table exists) writes nothing.
for (const bad of ["", "no-at-sign", "a@@b.com", "x@y", "a b@c.com"]) {
  const r = await addSubscriber(db, bad, "footer");
  assert(!r.ok, `addSubscriber rejects ${JSON.stringify(bad)}`);
}
let tableExists = true;
try { subCount(); } catch { tableExists = false; }
assert(!tableExists || subCount() === 0, "invalid subscribes wrote no rows");

// Valid input writes exactly one normalized row.
const first = await addSubscriber(db, "  Fan@Example.COM ", "footer");
assert(first.ok && !first.already && first.email === "fan@example.com", "first subscribe succeeds, normalized");
assert(subCount() === 1, "exactly one row after the first subscribe");
const row = raw.query("SELECT email, source FROM subscribers").get() as any;
assert(row.email === "fan@example.com" && row.source === "footer", "the stored row is the normalized address with its source");

// Duplicate (any casing/spacing) is an idempotent success.
const dup = await addSubscriber(db, "FAN@example.com", "footer");
assert(dup.ok && dup.already, "duplicate subscribe reports already: true");
assert(subCount() === 1, "duplicate subscribe wrote no second row");

// A second distinct address adds a second row.
const second = await addSubscriber(db, "other+news@mail.example.org");
assert(second.ok && !second.already, "a distinct address subscribes fresh");
assert(subCount() === 2, "two rows for two distinct addresses");

// --- Optional name: sanitize rules
assert(sanitizeSubscriberName("  Grace   Hopper ") === "Grace Hopper", "name: trimmed, whitespace collapsed");
assert(sanitizeSubscriberName("<Grace>\nHopper") === "Grace Hopper", "name: angle brackets and control chars stripped");
assert(sanitizeSubscriberName("") === null && sanitizeSubscriberName("   ") === null, "name: blank means no name");
assert(sanitizeSubscriberName(null) === null && sanitizeSubscriberName(undefined) === null, "name: null/undefined means no name");
assert((sanitizeSubscriberName("x".repeat(80)) || "").length === 60, "name: capped at 60 characters");

// --- Optional name: stored on subscribe; duplicates fill, never overwrite
const nameOf = (email: string) =>
  (raw.query("SELECT name FROM subscribers WHERE email = ?").get(email) as any)?.name ?? null;
const named = await addSubscriber(db, "named@example.com", "footer", "  Ada   Lovelace ");
assert(named.ok && !named.already, "named subscribe succeeds");
assert(nameOf("named@example.com") === "Ada Lovelace", "the stored name is the sanitized one");
assert(nameOf("fan@example.com") === null, "the earlier nameless row still has no name");
const filled = await addSubscriber(db, "FAN@example.com", "footer", "Fan Reader");
assert(filled.ok && filled.already, "duplicate with a name is still an idempotent success");
assert(nameOf("fan@example.com") === "Fan Reader", "a duplicate subscribe fills in a missing name");
const overwrite = await addSubscriber(db, "fan@example.com", "footer", "Someone Else");
assert(overwrite.ok && overwrite.already, "second duplicate also succeeds");
assert(nameOf("fan@example.com") === "Fan Reader", "a duplicate never overwrites an existing name");
const dirty = await addSubscriber(db, "dirty@example.com", "footer", "<b>Eve</b>");
assert(dirty.ok && nameOf("dirty@example.com") === "b Eve /b", "markup in a name is stored as plain text only");

// --- Turnstile: enforcement is all-or-nothing on the two keys, and
// verification runs against siteverify (fetch stubbed at the boundary).
assert(!turnstileEnforced({}), "turnstile: no keys means enforcement off (form behaves as before)");
assert(!turnstileEnforced({ TURNSTILE_SITE_KEY: "site" }), "turnstile: site key alone does not enforce");
assert(!turnstileEnforced({ TURNSTILE_SECRET_KEY: "secret" }), "turnstile: secret alone does not enforce");
assert(turnstileEnforced({ TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" }), "turnstile: both keys means enforcement on");
assert(TURNSTILE_FAILED_MESSAGE === "Please complete the check and try again.", "turnstile: the plain failure message is the agreed copy");

const TS_ENV = { TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "sekret" };
const realFetch = globalThis.fetch;
let verifyCalls = 0;
let verifyBehavior: "ok" | "bad" | "throw" = "ok";
globalThis.fetch = (async (url: any, init: any = {}) => {
  const u = String(url);
  if (u.includes("challenges.cloudflare.com/turnstile/v0/siteverify")) {
    verifyCalls += 1;
    if (verifyBehavior === "throw") throw new Error("network down");
    const body = String(init?.body ?? "");
    const good = body.includes("response=good-token") && body.includes("secret=sekret");
    return new Response(JSON.stringify({ success: verifyBehavior === "ok" && good }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error("unexpected fetch: " + u);
}) as any;
assert((await verifyTurnstileToken(TS_ENV, "good-token")) === true, "turnstile: a token Cloudflare accepts verifies");
assert(verifyCalls === 1, "turnstile: siteverify was called once");
assert((await verifyTurnstileToken(TS_ENV, "bad-token")) === false, "turnstile: a rejected token does not verify");
verifyCalls = 0;
assert((await verifyTurnstileToken(TS_ENV, "")) === false && (await verifyTurnstileToken(TS_ENV, undefined)) === false, "turnstile: a missing token does not verify");
assert(verifyCalls === 0, "turnstile: a missing token never reaches siteverify");
verifyBehavior = "throw";
assert((await verifyTurnstileToken(TS_ENV, "good-token")) === false, "turnstile: an unreachable siteverify fails closed");
verifyBehavior = "ok";
assert((await verifyTurnstileToken({}, "good-token")) === false, "turnstile: no secret configured never verifies");
globalThis.fetch = realFetch;

// --- Route + form source pins
const route = readFileSync(new URL("../src/pages/api/subscribe.ts", import.meta.url), "utf8");
assert(route.includes('from "../../lib/email-validate"'), "the route uses the shared validator lib");
assert(route.includes("addSubscriber"), "the route writes through addSubscriber (validation before insert)");
assert(route.includes("INVALID_EMAIL_MESSAGE"), "the route returns the plain validation message");
assert(route.includes("status: 400"), "the route answers invalid input with 400");
assert(!route.includes("INSERT"), "the route contains no insert of its own (validation cannot be bypassed)");
assert(!route.includes("Book Club signups"), "the route no longer calls the list Book Club signups");
assert(route.includes("turnstileEnforced") && route.includes("verifyTurnstileToken"), "the route verifies Turnstile through the shared lib");
assert(route.includes("TURNSTILE_FAILED_MESSAGE") && route.includes("status: 403"), "the route answers a failed Turnstile check with 403 and the plain message");
assert(route.includes("body?.name"), "the route passes the optional name through to addSubscriber");

const footer = readFileSync(new URL("../src/components/SiteFooter.astro", import.meta.url), "utf8");
assert(footer.includes("New books, by email"), "footer heading is the newsletter framing");
assert(footer.includes("New releases and the occasional offer, nothing else."), "footer subline is the newsletter copy");
assert(footer.includes("newsletter-form"), "the form carries the newsletter class");
assert(!footer.includes("Join the Book Club"), "the footer form never says Join the Book Club");
assert(!footer.includes("already in the Book Club"), "the duplicate message no longer claims Book Club membership");
assert(footer.includes("You are on the list."), "the success message is the friendly list copy");
assert(footer.includes("That email does not look right."), "the client-side error matches the server message");
assert(footer.includes("emailLooksRight"), "the client mirrors the validation rules before submitting");
assert(footer.includes('href="/clubs/book-club"'), "the footer's See how the Book Club works line routes to The Book Club's own page (the bare /clubs nav link was removed 2026-10-31, Clubs is in the main nav)");
assert(footer.includes('name="name"') && footer.includes('autocomplete="given-name"'), "the form carries the optional first-name field");
assert(footer.includes("First name (optional)"), "the name field is labeled optional");
assert(footer.includes("TURNSTILE_SITE_KEY"), "the footer reads the Turnstile site key from the worker env");
assert(!footer.includes("cf-turnstile"), "the footer ships no eager Turnstile widget markup (the check loads on submit instead)");
assert(!footer.includes("data-sitekey"), "the footer does not hand the key to an implicit widget render");
assert(!footer.includes("challenges.cloudflare.com"), "nothing from the Turnstile origin is referenced in the initial page HTML");
assert(footer.includes("ts.render("), "the footer renders the Turnstile widget explicitly, inside the modal, on submit");
assert(footer.includes("api.js?render=explicit"), "the footer lazy loads the Turnstile script in explicit render mode");
assert(footer.includes("newsletter-modal") && footer.includes("One quick check"), "the footer carries the modal the check opens in");
assert(footer.includes("data-ts-key"), "the site key reaches the submit handler through the form data attribute");
assert(footer.includes("newsletter-name-reveal"), "the first-name field starts hidden and reveals once the email field is dirty");
assert(footer.includes("turnstile_token"), "the submit handler sends the Turnstile token with the subscribe POST");

if (failures) { console.error(`\n${failures} FAILURES`); process.exit(1); }
console.log("\nAll email validation tests passed.");
