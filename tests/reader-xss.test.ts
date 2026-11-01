// SECURITY F7 (2026-10-31, re-pinned for the hub rebuild 2026-11-01):
// reader page text is factory/AI-written book data (editor_chapters.json)
// and the content pipeline accepts free-text custom_topic_request, so
// page text must render as TEXT, never as markup. The old
// CustomerBookViewer built page cards with innerHTML; the rebuilt
// reader (/read/[slug], the QC reader pattern) renders through Astro
// template interpolation, which escapes by construction. This suite
// pins that structural property so an innerHTML reader can never
// quietly come back: page text via template expressions, chapter
// titles via textContent, and no innerHTML anywhere on the customer
// reader surfaces.
// Run with: bun tests/reader-xss.test.ts
let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const read = async (rel: string) =>
  Bun.file(new URL(rel, import.meta.url)).text();

// ---- The reader renders page text through template interpolation ----
const readerSrc = await read("../src/pages/read/[slug].astro");
assert(
  readerSrc.includes("{p.text && (") && readerSrc.includes("{p.text}"),
  "page text renders through an Astro template expression (escaped by construction)"
);
assert(
  readerSrc.includes("textContent"),
  "dynamic labels (chapter titles, player state) use textContent"
);
assert(
  !readerSrc.includes("innerHTML"),
  "the reader contains no innerHTML at all"
);
assert(
  !readerSrc.includes("insertAdjacentHTML"),
  "the reader contains no insertAdjacentHTML"
);

// ---- The retired innerHTML viewer stays retired ------------------------------
let viewerExists = false;
try {
  await Bun.file(new URL("../src/components/CustomerBookViewer.astro", import.meta.url)).stat();
  viewerExists = true;
} catch {}
assert(!viewerExists, "the innerHTML-based CustomerBookViewer stays deleted");

// ---- Every customer-facing hub surface is innerHTML-free -------------------
for (const rel of [
  "../src/pages/account/book/[slug].astro",
  "../src/pages/account/library.astro",
  "../src/pages/account/receipt.astro",
  "../src/components/CustomerShell.astro",
]) {
  const src = await read(rel);
  assert(
    !src.includes("innerHTML") && !src.includes("insertAdjacentHTML"),
    `${rel.replace("../../", "")} renders no innerHTML`
  );
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll reader XSS tests passed.");
