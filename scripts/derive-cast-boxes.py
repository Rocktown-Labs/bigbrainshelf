#!/usr/bin/env python3
"""Record each gallery pose's source box into the cast-gallery manifest.

Re-runs the extraction pipeline's detection (same code path as
scripts/extract-cast-poses.py: detect_boxes / MANUAL_BOXES, same
padding rule as its extract()) in a boxes-only mode: it does NOT
re-crop or re-upload any pose image. For every character it merges
into src/data/cast-gallery.json:

  boxes:         [{x, y, w, h}] fractions of the sheet, reading order,
                 each box being the EXACT region (padding included)
                 that was cropped into pose-{n}.png
  portraitIndex: 0 (pose 1 is the portrait, as shipped)
  sheetSize:     {w, h} sheet pixels
  v:             1 (per-character art version, bumped by the admin
                 crop editor on every save; public pages append ?v=)

and uploads the enriched manifest to R2 as cast-gallery/manifest.json,
the runtime source the public pages and the admin crop editor read.

Bix's sheetKey is normalized from the extraction script's "local:..."
marker to characters/bix.png, the copy of CG's sheet that lives in
the bucket, so the editor can fetch and crop it uniformly.

Usage: python3 scripts/derive-cast-boxes.py [--no-upload]
"""
import io, json, os, sys, urllib.parse, urllib.request

import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "extract_cast_poses",
    os.path.join(os.path.dirname(os.path.abspath(__file__)),
                 "extract-cast-poses.py"))
ex = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ex)

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
import dynamic_credentials  # noqa: E402

MANIFEST = ex.MANIFEST


def r2_put_json(key: str, doc: dict) -> None:
    url = (f"https://api.cloudflare.com/client/v4/accounts/{ex.ACCT}"
           f"/r2/buckets/{ex.BUCKET}/objects/{urllib.parse.quote(key, safe='')}")
    data = json.dumps(doc, indent=1).encode()
    req = urllib.request.Request(url, data=data, method="PUT",
                                 headers={"Content-Type": "application/json",
                                          "User-Agent": "curl/8.0"})
    dynamic_credentials.add_surrogate_to_request(
        req, "custom.cloudflare", entry_name="access_token",
        allowed_hosts=["api.cloudflare.com"])
    with urllib.request.urlopen(req, timeout=120) as r:
        body = json.loads(r.read().decode())
    if not body.get("success"):
        raise RuntimeError(f"R2 PUT {key} failed: {body}")


def padded_region(box, W, H):
    """Same padding + clamping as extract_cast_poses.extract()."""
    x0, y0, x1, y1 = box
    pad = int(0.04 * max(x1 - x0, y1 - y0)) + 6
    return (max(0, x0 - pad), max(0, y0 - pad),
            min(W, x1 + pad), min(H, y1 + pad))


def main() -> None:
    upload = "--no-upload" not in sys.argv
    with open(MANIFEST) as f:
        manifest = json.load(f)
    chars = manifest["characters"]
    report = []
    for name, slug, book, key in ex.CHARACTERS:
        if slug in ex.LOCAL_SHEETS:
            from PIL import Image
            img = Image.open(ex.LOCAL_SHEETS[slug]).convert("RGB")
        else:
            raw = ex.fetch(f"{ex.R2_PUBLIC}/{key}")
            from PIL import Image
            img = Image.open(io.BytesIO(raw)).convert("RGB")
        W, H = img.size
        if slug in ex.MANUAL_BOXES:
            boxes = ex.MANUAL_BOXES[slug]
        else:
            boxes = ex.detect_boxes(img)
        if len(boxes) < 2:
            boxes = [[0, 0, W, H]]
        fracs = []
        for b in boxes:
            cx0, cy0, cx1, cy1 = padded_region(b, W, H)
            fracs.append({
                "x": round(cx0 / W, 5), "y": round(cy0 / H, 5),
                "w": round((cx1 - cx0) / W, 5), "h": round((cy1 - cy0) / H, 5),
            })
        entry = chars.get(slug)
        if entry is None:
            raise SystemExit(f"manifest has no entry for {slug}; run extraction first")
        if len(fracs) != entry["poseCount"]:
            raise SystemExit(
                f"{slug}: detected {len(fracs)} boxes but manifest ships "
                f"{entry['poseCount']} poses; refusing to guess")
        entry["boxes"] = fracs
        entry["portraitIndex"] = 0
        entry["sheetSize"] = {"w": W, "h": H}
        entry.setdefault("v", 1)
        if slug == "bix":
            entry["sheetKey"] = "characters/bix.png"
        report.append(f"{slug}: {len(fracs)} boxes on {W}x{H}")
        print(report[-1], flush=True)
    with open(MANIFEST, "w") as f:
        json.dump(manifest, f, indent=1)
    if upload:
        r2_put_json("cast-gallery/manifest.json", manifest)
        print("uploaded cast-gallery/manifest.json")
    print("\n".join(report))


if __name__ == "__main__":
    main()
