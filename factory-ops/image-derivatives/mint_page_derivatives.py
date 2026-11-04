#!/usr/bin/env python3
"""Mint display-width WebP derivatives for QC page art.

The QC viewer used to ship full-resolution originals as both page
art and rail thumbnails through the admin media route. The zone is
on Cloudflare Free (no plan-gated image resizing), so right-sized
images are produced locally, same as the cover derivatives.

For every line and color page image of a book, this writes
    books/{slug}/derivatives/{sha256}-w{width}.webp
for widths 200 and 960 (only when the original is wider). The name
is the artifact's own SHA-256, so a replaced page gets a new
derivative name and a stale derivative can never be served for new
art. The derivatives/ prefix is deliberately outside the factory
snapshot predicate (plans/, images/, images-color/), so minting
never changes a book's versions fingerprint. The admin media route
serves a derivative only after verifying the original's hash
against the sha256 in the request URL, and falls back to the
original when no derivative exists, so this script is an
optimization, never a correctness dependency. Idempotent: existing
derivatives are skipped.

Usage: python3 mint_page_derivatives.py <slug> [<slug> ...]
Run from the factory-ops environment (cover.py credential helper).
"""
import hashlib
import io
import json
import sys

sys.path.insert(0, "/home/hatch/workspace/kidsbook-video/runner")
import cover  # noqa: E402
from PIL import Image  # noqa: E402

# R2 reads through the API helper occasionally drop the connection
# mid-run; the minter is idempotent, so a few retries per call keep
# one dropped connection from killing a whole book.
import time as _time

for _name in ("r2_get", "r2_put"):
    _fn = getattr(cover, _name)
    def _wrapped(*a, _fn=_fn, **kw):
        for attempt in range(4):
            try:
                return _fn(*a, **kw)
            except Exception:
                if attempt == 3:
                    raise
                _time.sleep(2 * (attempt + 1))
    setattr(cover, _name, _wrapped)

WIDTHS = (200, 960)


def page_keys(slug):
    """Every line/color page key for the book, from its plans.
    Plan imageKey/imageColorKey fields win; pages written before
    those fields existed resolve to the conventional keys."""
    bible_raw = cover.r2_get(f"books/{slug}/bible.json")
    if not bible_raw:
        raise SystemExit(f"no bible for {slug}")
    bible = json.loads(bible_raw)
    chapters = len(bible.get("conceptLadder") or [])
    keys = []
    for c in range(1, chapters + 1):
        plan_raw = cover.r2_get(f"books/{slug}/plans/S{c}.json")
        if not plan_raw:
            continue
        plan = json.loads(plan_raw)
        pages = list(plan.get("pages") or [])
        if plan.get("finale"):
            pages.append(plan["finale"])
        for i, pg in enumerate(pages):
            finale = pg is plan.get("finale")
            stem = f"S{c}-finale" if finale else f"S{c}-page-{i}"
            keys.append(pg.get("imageKey") or f"books/{slug}/images/{stem}.jpg")
            if pg.get("imageColorKey"):
                keys.append(pg["imageColorKey"])
    return keys


def mint(slug):
    made = skipped = missing = 0
    for key in page_keys(slug):
        data = cover.r2_get(key)
        if data is None:
            missing += 1
            continue
        sha = hashlib.sha256(data).hexdigest()
        img = Image.open(io.BytesIO(data))
        for w in WIDTHS:
            if img.width <= w:
                continue
            dkey = f"books/{slug}/derivatives/{sha}-w{w}.webp"
            if cover.r2_get(dkey) is not None:
                skipped += 1
                continue
            out = io.BytesIO()
            img.resize((w, round(img.height * w / img.width)), Image.LANCZOS).save(out, "WEBP", quality=80)
            cover.r2_put(dkey, out.getvalue(), "image/webp")
            made += 1
    print(f"{slug}: {made} minted, {skipped} already present, {missing} page keys missing")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    for slug in sys.argv[1:]:
        mint(slug)
