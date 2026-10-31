// Delivery readiness tests (2026-10-31): the verdict model behind
// the admin book page's "Delivery readiness" panel. Ready means
// every advertised deliverable measured present and clean; a fail
// names its blocker; an unmeasured check is "unverified", never
// ready. Run with:
//   bun tests/delivery-readiness.test.ts
import assert from "node:assert";
import {
  computeDeliveryReadiness,
  audioCoverKind,
  type DeliveryFacts,
} from "../src/lib/delivery-readiness";

function facts(over: Partial<DeliveryFacts> = {}): DeliveryFacts {
  return {
    slug: "mastery",
    title: "Mira the Heron and the Still Water",
    files: { picture: true, coloring: true, epub: true, audiobook: true, color: true },
    audioCover: "composed",
    linePurity: true,
    cast: [
      { name: "Mira", cast: true },
      { name: "Ansel", cast: true },
      { name: "Dell", cast: true },
    ],
    audioProduction: "full-cast",
    audioVoiceName: "Kore",
    qa: { coverTypeset: false, coloringCaptionsTruncated: 0, backCoverTruncated: false },
    marketing: { promoMain: true, promoParents: true, defects: null, kitMissing: [] },
    ...over,
  };
}

// A fully measured, fully clean book is ready.
{
  const r = computeDeliveryReadiness(facts());
  assert.equal(r.verdict, "ready");
  assert.equal(r.blockers.length, 0);
  assert.equal(r.unknowns.length, 0);
}

// Mira's real 2026-10-31 fact pattern is NOT ready, with the true
// blockers named: no color edition, Ansel + Dell uncast, the
// audiobook a single-voice draft, dirty PDF QA.
{
  const r = computeDeliveryReadiness(
    facts({
      files: { picture: true, coloring: true, epub: true, audiobook: true, color: false },
      cast: [
        { name: "Mira", cast: true },
        { name: "Ansel", cast: false },
        { name: "Dell", cast: false },
      ],
      audioProduction: "single-voice",
      qa: { coverTypeset: true, coloringCaptionsTruncated: 28, backCoverTruncated: true },
    })
  );
  assert.equal(r.verdict, "not-ready");
  const text = r.blockers.join(" ");
  assert.match(text, /Color edition/);
  assert.match(text, /Ansel, Dell/);
  assert.match(text, /single-voice draft/);
  assert.match(text, /typeset/);
  assert.match(text, /28 coloring captions/);
  assert.match(text, /back-cover/);
}

// Unmeasured is unverified, never ready.
{
  const r = computeDeliveryReadiness(facts({ qa: null, audioCover: "unknown" }));
  assert.equal(r.verdict, "unverified");
  assert.equal(r.blockers.length, 0);
  assert.ok(r.unknowns.includes("PDF content QA"));
  assert.ok(r.unknowns.includes("Audiobook cover"));
}

// Marketing is the LAST step (CG, 2026-10-31): when it is the
// only thing outstanding, the product itself is ready.
{
  const r = computeDeliveryReadiness(
    facts({ marketing: { promoMain: true, promoParents: false, defects: null, kitMissing: [] } })
  );
  assert.equal(r.verdict, "product-ready");
  assert.equal(r.statusLabel, "Product ready: marketing is the last step");
  assert.match(r.blockers.join(" "), /parents promo/);
}

// A marketing pair with a known defect is a blocker with the
// defect named, and unmeasured marketing is unknown.
{
  const r = computeDeliveryReadiness(
    facts({ marketing: { promoMain: true, promoParents: true, defects: "color beat is a stand-in", kitMissing: [] } })
  );
  assert.equal(r.verdict, "product-ready");
  assert.match(r.blockers.join(" "), /color beat is a stand-in/);
  const u = computeDeliveryReadiness(facts({ marketing: null }));
  assert.equal(u.verdict, "unverified");
  assert.ok(u.unknowns.includes("Marketing assets"));
}

// An incomplete marketing kit is caught on its own (CG,
// 2026-10-31: an uncast, uncolored book's kit cannot read
// complete): the manifest's missing list fails the marketing
// check with the items named, and no manifest at all fails it
// too.
{
  const r = computeDeliveryReadiness(
    facts({ marketing: { promoMain: true, promoParents: true, defects: null, kitMissing: ["voice for Ansel", "color edition (colorize has not run)"] } })
  );
  assert.equal(r.verdict, "product-ready");
  assert.match(r.blockers.join(" "), /voice for Ansel/);
  assert.match(r.blockers.join(" "), /color edition/);
  const n = computeDeliveryReadiness(
    facts({ marketing: { promoMain: true, promoParents: true, defects: null, kitMissing: null } })
  );
  assert.match(n.blockers.join(" "), /no marketing kit manifest/);
}

// Line art purity (CG, 2026-10-31, Fern's line art carries
// color): unmeasured reads unverified, never fine; measured
// color in the line art is a blocker.
{
  const u = computeDeliveryReadiness(facts({ linePurity: null }));
  assert.equal(u.verdict, "unverified");
  assert.ok(u.unknowns.includes("Line art purity"));
  const bad = computeDeliveryReadiness(facts({ linePurity: false }));
  assert.equal(bad.verdict, "not-ready");
  assert.match(bad.blockers.join(" "), /Line art purity/);
}

// The bare-art embed fails the cover check; a missing file fails
// its presence check; an unchecked presence is unknown.
{
  const r = computeDeliveryReadiness(
    facts({
      audioCover: "bare",
      files: { picture: true, coloring: true, epub: false, audiobook: true, color: null },
    })
  );
  assert.equal(r.verdict, "not-ready");
  assert.match(r.blockers.join(" "), /bare art/);
  assert.match(r.blockers.join(" "), /EPUB/);
  assert.ok(r.unknowns.includes("Color edition"));
}

// --- audioCoverKind against synthetic M4B box structures ---------

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

function jpeg(w: number, h: number): Uint8Array {
  // SOI + SOF0 segment carrying the dimensions; enough for the walker.
  const seg = new Uint8Array(2 + 2 + 1 + 2 + 2 + 1 + 3 * 3);
  let o = 0;
  seg[o++] = 0xff; seg[o++] = 0xd8;
  seg[o++] = 0xff; seg[o++] = 0xc0;
  const dv = new DataView(seg.buffer);
  dv.setUint16(o, 8 + 3 * 3); o += 2;
  seg[o++] = 8;
  dv.setUint16(o, h); o += 2;
  dv.setUint16(o, w); o += 2;
  seg[o++] = 3;
  return seg;
}

function fakeM4b(w: number, h: number): Uint8Array {
  const dataPayload = new Uint8Array(8 + jpeg(w, h).length);
  dataPayload.set(jpeg(w, h), 8); // 8-byte data header (flags + locale)
  const covr = box("covr", box("data", dataPayload));
  const ilst = box("ilst", covr);
  const meta = box("meta", (() => { const p = new Uint8Array(4 + ilst.length); p.set(ilst, 4); return p; })());
  const udta = box("udta", meta);
  const moov = box("moov", udta);
  const ftyp = box("ftyp", new Uint8Array(8));
  const out = new Uint8Array(ftyp.length + moov.length);
  out.set(ftyp, 0);
  out.set(moov, ftyp.length);
  return out;
}

assert.equal(audioCoverKind(fakeM4b(1050, 1400)), "composed");
assert.equal(audioCoverKind(fakeM4b(1024, 1024)), "bare");
assert.equal(audioCoverKind(new Uint8Array([1, 2, 3])), "unknown");

console.log("delivery-readiness: all assertions passed");
