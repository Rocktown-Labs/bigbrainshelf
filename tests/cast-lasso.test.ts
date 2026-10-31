import { test, expect, describe } from "bun:test";
import {
  createLassoCapture,
  lassoPointerDown,
  lassoPointerMove,
  lassoPointerUp,
  lassoPoints,
  lassoUndoLast,
  lassoClear,
  lassoHasPath,
  lassoCanClose,
  lassoNearStart,
  pointInPolygon,
  rasterizeLassoMask,
  applyLassoErase,
  type LassoPoint,
} from "../src/lib/lasso";
import { validEraseInfo, normalizePoseMeta } from "../src/lib/cast-gallery";

// ---------------------------------------------------------------------------
// The lasso's pure math: mixed click/drag capture, close detection,
// even-odd rasterization with a feathered edge, and the erase blend.
// The editor consumes the same functions through window.BbsLasso.
// ---------------------------------------------------------------------------

function click(cap: ReturnType<typeof createLassoCapture>, x: number, y: number) {
  lassoPointerDown(cap, { x, y });
  lassoPointerUp(cap);
}

function drag(
  cap: ReturnType<typeof createLassoCapture>,
  pts: LassoPoint[]
) {
  lassoPointerDown(cap, pts[0]);
  for (const p of pts.slice(1)) lassoPointerMove(cap, p, 1, 3);
  lassoPointerUp(cap);
}

describe("lasso capture model", () => {
  test("clicks commit single vertices; a drag commits one stroke", () => {
    const cap = createLassoCapture();
    click(cap, 0, 0);
    click(cap, 40, 0);
    expect(cap.contributions.map((c) => c.kind)).toEqual(["vertex", "vertex"]);
    drag(cap, [
      { x: 40, y: 40 },
      { x: 30, y: 44 },
      { x: 20, y: 46 },
      { x: 10, y: 44 },
      { x: 0, y: 40 },
    ]);
    expect(cap.contributions.length).toBe(3);
    expect(cap.contributions[2].kind).toBe("stroke");
    expect(cap.contributions[2].points.length).toBe(5);
    const pts = lassoPoints(cap);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[1]).toEqual({ x: 40, y: 0 });
    expect(pts.length).toBe(7); // 2 vertices + 5 stroke points, deduped
  });

  test("a press that never moves is a click, even with jitter below the drag threshold", () => {
    const cap = createLassoCapture();
    lassoPointerDown(cap, { x: 10, y: 10 });
    lassoPointerMove(cap, { x: 11, y: 11 }, 2, 4); // 1.4px: still a click
    lassoPointerUp(cap);
    expect(cap.contributions).toEqual([{ kind: "vertex", points: [{ x: 10, y: 10 }] }]);
  });

  test("drag capture decimates points closer than minDist", () => {
    const cap = createLassoCapture();
    lassoPointerDown(cap, { x: 0, y: 0 });
    for (let x = 1; x <= 20; x++) lassoPointerMove(cap, { x, y: 0 }, 5, 3);
    lassoPointerUp(cap);
    const stroke = cap.contributions[0];
    expect(stroke.kind).toBe("stroke");
    // start + a point every >=5px: far fewer than 21 raw points
    expect(stroke.points.length).toBeLessThan(8);
    expect(stroke.points.length).toBeGreaterThan(2);
    for (let i = 1; i < stroke.points.length; i++) {
      const d = Math.hypot(
        stroke.points[i].x - stroke.points[i - 1].x,
        stroke.points[i].y - stroke.points[i - 1].y
      );
      expect(d).toBeGreaterThanOrEqual(5);
    }
  });

  test("undo removes one whole contribution at a time, drag included", () => {
    const cap = createLassoCapture();
    click(cap, 0, 0);
    drag(cap, [
      { x: 10, y: 0 },
      { x: 20, y: 3 },
      { x: 30, y: 0 },
    ]);
    expect(lassoHasPath(cap)).toBe(true);
    expect(lassoUndoLast(cap)).toBe(true);
    expect(cap.contributions.length).toBe(1); // the whole stroke went at once
    expect(lassoUndoLast(cap)).toBe(true);
    expect(lassoUndoLast(cap)).toBe(false);
    expect(lassoHasPath(cap)).toBe(false);
    // An in-progress drag is abandoned before committed points go.
    click(cap, 1, 1);
    lassoPointerDown(cap, { x: 5, y: 5 });
    expect(lassoUndoLast(cap)).toBe(true);
    expect(cap.contributions.length).toBe(1);
    lassoClear(cap);
    expect(cap.contributions.length).toBe(0);
  });

  test("close needs 3 points, and near-start respects the tolerance", () => {
    const cap = createLassoCapture();
    click(cap, 0, 0);
    click(cap, 30, 0);
    expect(lassoCanClose(cap)).toBe(false);
    expect(lassoNearStart(cap, { x: 1, y: 1 }, 10)).toBe(false);
    click(cap, 30, 30);
    expect(lassoCanClose(cap)).toBe(true);
    expect(lassoNearStart(cap, { x: 3, y: 4 }, 10)).toBe(true); // 5px away
    expect(lassoNearStart(cap, { x: 20, y: 0 }, 10)).toBe(false);
    expect(lassoNearStart(cap, { x: 3, y: 4 }, 4)).toBe(false); // outside a tighter tol
  });

  test("pointInPolygon agrees with the rasterizer's interior", () => {
    const tri: LassoPoint[] = [
      { x: 5, y: 5 },
      { x: 45, y: 5 },
      { x: 25, y: 40 },
    ];
    expect(pointInPolygon({ x: 25, y: 15 }, tri)).toBe(true);
    expect(pointInPolygon({ x: 3, y: 35 }, tri)).toBe(false);
    expect(pointInPolygon({ x: 48, y: 48 }, tri)).toBe(false);
  });
});

describe("lasso mask rasterization", () => {
  const square: LassoPoint[] = [
    { x: 10, y: 10 },
    { x: 30, y: 10 },
    { x: 30, y: 30 },
    { x: 10, y: 30 },
  ];

  test("hard mask: inside is 1, outside is 0", () => {
    const m = rasterizeLassoMask(square, 40, 40, 0);
    expect(m[20 * 40 + 20]).toBe(1);
    expect(m[2 * 40 + 2]).toBe(0);
    expect(m[20 * 40 + 35]).toBe(0);
    expect(m[35 * 40 + 20]).toBe(0);
  });

  test("feather: boundary pixels land strictly between 0 and 1, monotone across the edge", () => {
    const m = rasterizeLassoMask(square, 40, 40, 2);
    expect(m[20 * 40 + 20]).toBe(1); // deep inside stays 1
    expect(m[20 * 40 + 2]).toBe(0); // far outside stays 0
    const row: number[] = [];
    for (let x = 4; x <= 18; x++) row.push(m[20 * 40 + x]);
    for (let i = 1; i < row.length; i++) {
      expect(row[i]).toBeGreaterThanOrEqual(row[i - 1]); // monotone rising into the shape
    }
    const edge = m[20 * 40 + 10];
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(1);
  });

  test("self-intersecting paths are handled by the even-odd rule, not a crash", () => {
    // A bowtie: two lobes crossed in the middle.
    const bowtie: LassoPoint[] = [
      { x: 5, y: 5 },
      { x: 35, y: 35 },
      { x: 35, y: 5 },
      { x: 5, y: 35 },
    ];
    const m = rasterizeLassoMask(bowtie, 40, 40, 0);
    expect(m[10 * 40 + 10]).toBe(1); // upper-left lobe
    expect(m[30 * 40 + 30]).toBe(1); // lower-right lobe
    expect(m[6 * 40 + 20]).toBe(0); // top middle: outside both lobes
  });

  test("a degenerate path rasterizes to an empty mask", () => {
    const m = rasterizeLassoMask([{ x: 1, y: 1 }, { x: 2, y: 2 }], 8, 8, 2);
    expect([...m].every((v) => v === 0)).toBe(true);
  });
});

describe("applyLassoErase", () => {
  function fixture() {
    const w = 40, h = 40;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = 200; data[i * 4 + 1] = 30; data[i * 4 + 2] = 30; data[i * 4 + 3] = 255;
    }
    const square: LassoPoint[] = [
      { x: 10, y: 10 },
      { x: 30, y: 10 },
      { x: 30, y: 30 },
      { x: 10, y: 30 },
    ];
    const mask = rasterizeLassoMask(square, w, h, 0);
    return { w, h, data, mask };
  }
  const bg = { r: 253, g: 250, b: 243 };
  const px = (data: Uint8ClampedArray, w: number, x: number, y: number) => {
    const k = (y * w + x) * 4;
    return [data[k], data[k + 1], data[k + 2], data[k + 3]];
  };

  test("erase inside replaces only the traced region with the background", () => {
    const { w, h, data, mask } = fixture();
    applyLassoErase(data, w, h, mask, "inside", bg);
    expect(px(data, w, 20, 20)).toEqual([253, 250, 243, 255]);
    expect(px(data, w, 3, 3)).toEqual([200, 30, 30, 255]);
  });

  test("erase outside keeps the traced region and backgrounds everything else", () => {
    const { w, h, data, mask } = fixture();
    applyLassoErase(data, w, h, mask, "outside", bg);
    expect(px(data, w, 20, 20)).toEqual([200, 30, 30, 255]);
    expect(px(data, w, 3, 3)).toEqual([253, 250, 243, 255]);
    expect(px(data, w, 38, 38)).toEqual([253, 250, 243, 255]);
  });
});

describe("eraseInfo lasso bookkeeping", () => {
  test("validEraseInfo keeps lasso only when true (sparse)", () => {
    expect(validEraseInfo({ at: 100, sam: 1, brush: false, lasso: true })).toEqual(
      { at: 100, sam: 1, brush: false, lasso: true });
    expect(validEraseInfo({ at: 100, sam: 1, brush: false })).toEqual(
      { at: 100, sam: 1, brush: false });
    expect(validEraseInfo({ at: 100, sam: 0, brush: false, lasso: "yes" })).toEqual(
      { at: 100, sam: 0, brush: false });
  });

  test("normalizePoseMeta preserves an edited pose's lasso flag", () => {
    const out = normalizePoseMeta(
      [{ edited: true, eraseInfo: { at: 5, sam: 0, brush: false, lasso: true } }], 1);
    expect(out[0].edited).toBe(true);
    expect(out[0].eraseInfo).toEqual({ at: 5, sam: 0, brush: false, lasso: true });
  });
});

describe("editor wiring (source pins)", () => {
  const fs = require("node:fs");
  const page = fs.readFileSync("src/pages/admin/characters/cast-crops.astro", "utf8");

  test("the lasso tool sits beside brush and click-to-remove", () => {
    expect(page).toContain('id="erase-tool-lasso"');
    expect(page).toContain('id="lasso-erase-outside"');
    expect(page).toContain('id="lasso-erase-inside"');
    expect(page).toContain('id="lasso-close"');
    expect(page).toContain('id="lasso-undo-point"');
    expect(page).toContain("Erase outside keeps only the traced part");
  });

  test("the editor consumes the lib module through window.BbsLasso", () => {
    expect(page).toContain('from "../../../lib/lasso"');
    expect(page).toContain("window as any).BbsLasso");
    expect(page).toContain("rasterizeLassoMask(poly, w, h, 2)");
    expect(page).toContain("applyLassoErase(imgData.data, w, h, mask, mode, eraseSession.bg)");
  });

  test("a lasso apply joins the shared undo stack and flags the edit", () => {
    expect(page).toContain("function applyLasso(mode)");
    expect(page).toContain("eraseSession.lassoUsed = true");
    expect(page).toContain("previewDirty ? eraseBaseCanvas : eraseCanvas");
    expect(page).toContain("info.lasso = true");
  });

  test("the history panel and its restore flow are in the page", () => {
    expect(page).toContain('id="history-list"');
    expect(page).toContain("restorePoseFlow");
    expect(page).toContain("can itself be undone from this same list");
    expect(page).toContain("&history=1&poseIndex=");
    expect(page).toContain("restorePose: { poseIndex: i, ts }");
  });
});
