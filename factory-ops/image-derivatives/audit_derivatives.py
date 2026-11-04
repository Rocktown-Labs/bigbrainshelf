#!/usr/bin/env python3
"""Derivative freshness audit: baked map vs live R2 cover bytes.

Why this exists (2026-11-03): the rename pass replaced the Fenix,
Blaze, and Wells covers in R2, but nobody reran the derivative
generator, so the baked map in src/data/image-derivatives.json kept
stamping byte sizes for the OLD covers. Surfaces silently disagreed
for days: derivative URLs versioned by stale sizes pinned retired
art in immutable caches, and admin pages reading the raw cover URL
served the old names. CG caught it by eye. This audit is the guard
that catches it first.

What it checks, for every book in D1 carrying a titled cover:
  1. The book has an entry in the baked derivative map. A titled
     cover with no entry makes public pages fall back to the raw
     unversioned media URL (the pinning hazard).
  2. The live R2 object at books/{slug}/cover-titled.jpg has exactly
     the byte size the map records as sourceBytes. A mismatch means
     the cover was replaced without a derivative refresh (or the map
     was refreshed against bytes that are no longer live).
  3. The derivative objects named by the map (card, hero) exist in
     R2 and match the byte sizes the map records for them
     (cardBytes / heroBytes, when the map carries them).

Exit code 0 when everything agrees, 1 with a loud per-book report
otherwise. Remedy on failure: rerun gen_derivatives.py (VM:
~/workspace/factory-ops/image-derivatives/), refresh the baked map
and the R2 mirror, rerun this audit, then redeploy the hub.

Usage: python3 audit_derivatives.py [--map PATH]
Reads R2/D1 through the runner credential helper (cover.py), the
same channel as the other factory-ops tools. R2 reads use the
two-agreeing-reads rule for source covers: this environment can
return stale bytes without an error, and the source size is the
number everything else is judged against.
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, "/home/hatch/workspace/kidsbook-video/runner")
import cover  # noqa: E402

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEFAULT_MAP = os.path.join(REPO_ROOT, "src", "data", "image-derivatives.json")


def r2_get_retry(key, attempts=4):
    for i in range(attempts):
        try:
            data = cover.r2_get(key)
        except Exception:
            data = None
        if data is not None:
            return data
        time.sleep(0.5 * (i + 1))
    return None


def r2_get_stable(key):
    """Two consecutive byte-identical reads, per the house R2 rule."""
    prev = None
    for _ in range(4):
        data = r2_get_retry(key, attempts=2)
        if data is None:
            return None
        if prev is not None and len(data) == len(prev) and data == prev:
            return data
        prev = data
    return prev


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", default=DEFAULT_MAP, help="path to image-derivatives.json")
    args = ap.parse_args()

    with open(args.map) as f:
        deriv = json.load(f)
    map_covers = deriv.get("covers") or {}

    rows = cover.d1(
        "SELECT slug, cover_key FROM books WHERE cover_key IS NOT NULL AND cover_key LIKE '%cover-titled.jpg'"
    )["results"]
    titled = {r["slug"]: r["cover_key"] for r in rows}

    failures = []
    checked = 0

    for slug in sorted(set(titled) | set(map_covers)):
        entry = map_covers.get(slug)
        if slug in titled and entry is None:
            failures.append(
                f"{slug}: has titled cover {titled[slug]} in D1 but NO derivative map entry; "
                "public surfaces fall back to the raw unversioned cover URL"
            )
            continue
        if entry is None:
            continue
        src_key = titled.get(slug) or f"books/{slug}/cover-titled.jpg"
        src = r2_get_stable(src_key)
        if src is None:
            failures.append(f"{slug}: source cover {src_key} unreadable/missing in R2")
            continue
        checked += 1
        if entry.get("sourceBytes") is not None and len(src) != entry["sourceBytes"]:
            failures.append(
                f"{slug}: source cover is {len(src)} bytes live, map sourceBytes says "
                f"{entry['sourceBytes']}; the cover was replaced without a derivative refresh "
                "(or the map was refreshed against bytes that are not live)"
            )
        for kind, bytes_field in (("card", "cardBytes"), ("hero", "heroBytes")):
            key = entry.get(kind)
            if not key:
                failures.append(f"{slug}: map entry has no {kind} derivative key")
                continue
            obj = r2_get_retry(key)
            if obj is None:
                failures.append(f"{slug}: derivative {key} missing in R2")
                continue
            if entry.get(bytes_field) is not None and len(obj) != entry[bytes_field]:
                failures.append(
                    f"{slug}: derivative {key} is {len(obj)} bytes live, map {bytes_field} "
                    f"says {entry[bytes_field]}; derivative URLs version by these sizes, so "
                    "the stale size pins the old derivative in immutable caches"
                )

    print(f"derivative audit: {checked} cover(s) compared against live R2")
    if failures:
        print(f"\nFAIL: {len(failures)} derivative drift problem(s):")
        for f in failures:
            print(f"  - {f}")
        print(
            "\nRemedy: rerun gen_derivatives.py, refresh src/data/image-derivatives.json "
            "and the R2 mirror, rerun this audit, then redeploy the hub."
        )
        return 1
    print("OK: baked derivative map agrees with live R2 cover bytes for every titled book.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
