#!/usr/bin/env python3
"""Pose-reuse audit: find pages that share pixel-level drawing regions.

Born 2026-10-27 from the Juno investigation: the image model copies
poses straight off the multi-pose character sheets, so whole figures
reappear, pixel-identical, on unrelated pages. Clef cannot see this
(it judges one page at a time); a template match can.

Method: every page is resized to 448x600 grayscale. Tiles of 96x96 are
cut from page A on a 48px stride and template-matched against page B
(cv2.matchTemplate, TM_CCOEFF_NORMED). Two pages count as sharing only
when at least MIN_TILES distinct tiles of A match inside B above the
threshold: a copied figure covers several tiles, while one shared sky
or roof texture tile is just scenery repeating.

Calibration note (2026-10-27): the first version of this rule (any
single shared tile links two pages) chained 39 of Juno's 45 pages into
one useless cluster. The original one-off script's Juno run (threshold
0.93) found a tight 6-page mutual cluster: S2p1, S2p3, S4p3, S5p1,
S5p3, S7p2.

Usage:
  reuse_audit.py <dir-with-page-images> [--threshold 0.93] [--json out.json]
  reuse_audit.py --slug motivationmanifesto [--threshold 0.93]

With --slug, line pages are downloaded from R2 into
factory-ops/reuse-cache/<slug>/ first (needs the kidsbook-video
runner's cover.py helpers on the path).

Requires opencv-python-headless + numpy (factory-ops/venv).
"""

import argparse
import itertools
import json
import os
import sys

import cv2
import numpy as np

W, H = 448, 600
TILE = 96
STRIDE = 48
MIN_TILES = 3


def load_pages(directory):
    pages = {}
    for name in sorted(os.listdir(directory)):
        if not name.lower().endswith((".jpg", ".jpeg", ".png")):
            continue
        img = cv2.imread(os.path.join(directory, name), cv2.IMREAD_GRAYSCALE)
        if img is None:
            continue
        pages[name] = cv2.resize(img, (W, H))
    return pages


def shared_region(a, b, threshold):
    """(best score, how many distinct tiles of a match inside b)."""
    best = 0.0
    hits = 0
    for y in range(0, H - TILE + 1, STRIDE):
        for x in range(0, W - TILE + 1, STRIDE):
            tile = a[y : y + TILE, x : x + TILE]
            if tile.std() < 5:  # blank tile: matches everything, means nothing
                continue
            res = cv2.matchTemplate(b, tile, cv2.TM_CCOEFF_NORMED)
            _, mx, _, _ = cv2.minMaxLoc(res)
            if mx > best:
                best = mx
            if mx > threshold:
                hits += 1
    return best, hits


def clusters(pages, threshold):
    names = sorted(pages)
    parent = {n: n for n in names}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    pairs = []
    for a, b in itertools.combinations(names, 2):
        s1, h1 = shared_region(pages[a], pages[b], threshold)
        s2, h2 = shared_region(pages[b], pages[a], threshold)
        score, hits = max((s1, h1), (s2, h2))
        if hits >= MIN_TILES:
            pairs.append({"a": a, "b": b, "score": round(float(score), 4), "tiles": hits})
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb
    groups = {}
    for n in names:
        groups.setdefault(find(n), []).append(n)
    return pairs, [sorted(g) for g in groups.values() if len(g) > 1]


def download_slug(slug):
    sys.path.insert(0, os.path.expanduser("~/workspace/kidsbook-video/runner"))
    import cover  # noqa: F401  (r2 helpers live there)

    cache = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reuse-cache", slug)
    os.makedirs(cache, exist_ok=True)
    keys = cover.r2_list(f"books/{slug}/images/") if hasattr(cover, "r2_list") else None
    if keys is None:
        raise SystemExit("cover.py has no r2_list helper; download the pages manually")
    for key in keys:
        name = key.split("/")[-1]
        dest = os.path.join(cache, name)
        if not os.path.exists(dest):
            data = cover.r2_get(key)
            with open(dest, "wb") as f:
                f.write(data)
    return cache


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("directory", nargs="?", help="directory of page images")
    ap.add_argument("--slug", help="download this book's line pages from R2 first")
    ap.add_argument("--threshold", type=float, default=0.93)
    ap.add_argument("--json", help="write the full result as JSON here")
    args = ap.parse_args()

    directory = args.directory
    if args.slug:
        directory = download_slug(args.slug)
    if not directory:
        ap.error("give a directory or --slug")

    pages = load_pages(directory)
    print(f"{len(pages)} pages loaded from {directory}")
    pairs, groups = clusters(pages, args.threshold)
    print(f"threshold {args.threshold}: {len(pairs)} sharing pairs, {len(groups)} clusters")
    for g in groups:
        print("cluster:", ", ".join(g))
    for p in pairs:
        print(f"  {p['a']} <-> {p['b']}  {p['score']}")
    if args.json:
        with open(args.json, "w") as f:
            json.dump({"pages": len(pages), "threshold": args.threshold, "pairs": pairs, "clusters": groups}, f, indent=1)
        print("wrote", args.json)


if __name__ == "__main__":
    main()
