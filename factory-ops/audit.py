#!/usr/bin/env python3
"""Purity audit mirroring factory src/purity.ts thresholds exactly.
Usage: audit.py <slug> [slug...]  (prints IMPURE/MISSING lines only)"""
import sys, io, json
sys.path.insert(0, "/home/hatch/workspace/kidsbook-video/runner")
import cover
from PIL import Image

def purity(data: bytes):
    im = Image.open(io.BytesIO(data)).convert("RGB")
    px = im.tobytes()
    total = sat = dark = 0
    n = len(px)
    for i in range(0, n - 2, 9):
        r, g, b = px[i], px[i + 1], px[i + 2]
        total += 1
        mx = max(r, g, b); mn = min(r, g, b)
        if mx > 50 and (mx - mn) / mx > 0.35:
            sat += 1
        if 0.2126 * r + 0.7152 * g + 0.0722 * b < 70:
            dark += 1
    sf, df = sat / total, dark / total
    return sf <= 0.02 and df <= 0.30, sf, df

def plan_chapters(slug):
    chs = []
    n = 1
    while True:
        raw = cover.r2_get(f"books/{slug}/plans/S{n}.json")
        if not raw:
            break
        plan = json.loads(raw)
        chs.append((f"S{n}", len(plan.get("pages", [])), bool(plan.get("finale", {}).get("imagePrompt"))))
        n += 1
    return chs

bad = 0
for slug in sys.argv[1:]:
    print(f"== {slug}")
    for ch, pages, finale in plan_chapters(slug):
        for pi in range(pages):
            key = f"books/{slug}/images/{ch}-page-{pi}.jpg"
            data = cover.r2_get(key)
            if data is None:
                print(f"  MISSING {key}"); bad += 1; continue
            pure, sf, df = purity(data)
            if not pure:
                print(f"  IMPURE {key} sat={sf:.3f} dark={df:.3f}"); bad += 1
        if finale:
            key = f"books/{slug}/images/{ch}-finale.jpg"
            data = cover.r2_get(key)
            if data is None:
                print(f"  MISSING {key}"); bad += 1
            else:
                pure, sf, df = purity(data)
                if not pure:
                    print(f"  IMPURE {key} sat={sf:.3f} dark={df:.3f}"); bad += 1
    print(f"== {slug} done")
print("TOTAL BAD:", bad)
