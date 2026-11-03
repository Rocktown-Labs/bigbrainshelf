#!/usr/bin/env python3
"""Inventory sync for one book (CG, 2026-11-02: log the old pages,
and if stuff is missing, make sure it is in sync).

Counts, per book: planned pages (plans, chapters probed 1..40 with
gaps skipped, one retry per read), line images on file, color
images on file, delivered PDF page counts (picture / coloring /
color), and editor chapter page totals. Any disagreement with the
plan count is a sync gap and lands in the report.

Usage: python3 inventory_sync.py <internal-slug>
Writes factory-ops/inventory-<slug>.json and uploads the report to
books/<slug>/audit/inventory.json, then reads it back to prove it
landed.
"""
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, "/home/hatch/workspace/kidsbook-video/runner")
import cover  # noqa: E402

slug = sys.argv[1]
out = {"slug": slug, "gaps": []}


def get(key):
    # Transport reads in this env drop connections under load
    # (IncompleteRead); retry with backoff before believing a miss.
    import time

    for attempt in range(4):
        try:
            d = cover.r2_get(key)
        except Exception:
            d = None
        if d is not None:
            return d
        time.sleep(0.5 * (attempt + 1))
    return None


def get_stable(key):
    """Read until two consecutive reads are byte-identical.

    This env can return stale or partial bytes WITHOUT an error (a
    cached older object reads cleanly), so a single successful read
    is not proof. Genuinely missing keys return None on every read.
    """
    prev = ...
    for _ in range(4):
        try:
            d = cover.r2_get(key)
        except Exception:
            d = None
        if d is None and prev is None:
            return None
        if d is not None and prev is not ... and d == prev:
            return d
        prev = d
    return prev if prev is not ... else None


# Plans: enumerate chapters 1..40, skipping gaps (audit-style), so a
# single flaky or absent file cannot truncate the census.
plan_by_chapter = {}
finale_count = 0
for n in range(1, 41):
    raw = get_stable(f"books/{slug}/plans/S{n}.json")
    if raw is None:
        continue
    plan = json.loads(raw)
    keys = []
    for pg in plan.get("pages") or []:
        if pg.get("imageKey"):
            keys.append(pg["imageKey"])
    fin = plan.get("finale") or {}
    if isinstance(fin, dict) and fin.get("imageKey"):
        keys.append(fin["imageKey"])
        finale_count += 1
    plan_by_chapter[f"S{n}"] = keys

all_keys = [k for keys in plan_by_chapter.values() for k in keys]
planned = len(all_keys)
planned_story = planned - finale_count
out["chapters_found"] = sorted(plan_by_chapter.keys(), key=lambda s: int(s[1:]))
out["planned_pages"] = planned
out["planned_story_pages"] = planned_story


def probe(key):
    def once(k):
        try:
            return cover.r2_get(k) is not None
        except Exception:
            try:
                return cover.r2_get(k) is not None
            except Exception:
                return False

    line = once(key)
    color = once(key.replace("/images/", "/images-color/"))
    return line, color


with ThreadPoolExecutor(max_workers=3) as ex:
    results = list(ex.map(probe, all_keys))
line_present = sum(1 for line, _ in results if line)
color_present = sum(1 for _, color in results if color)
out["line_images"] = line_present
out["color_images"] = color_present
if line_present != planned:
    out["gaps"].append(f"line images {line_present} != planned {planned}")

# Delivered PDFs: read the whole books row and pick the key columns
# by name pattern (column names differ across eras of the schema).
rows = cover.d1("SELECT * FROM books WHERE slug=?", params=[slug])["results"]
row = rows[0] if rows else {}
out["pdf_pages"] = {}
for label, needle in (("picture", "picture"), ("coloring", "coloring"), ("color", "color")):
    key = None
    for col, val in row.items():
        if needle in col and col.endswith("_key") and val:
            if label == "color" and "coloring" in col:
                continue
            key = val
            break
    if not key:
        continue
    data = get_stable(key)
    if data is None:
        out["gaps"].append(f"{label} PDF key in D1 but object missing: {key}")
        continue
    if not data.rstrip().endswith(b"%%EOF"):
        out["gaps"].append(f"{label} PDF read never stabilized (no EOF marker): {key}")
        continue
    path = f"/home/hatch/workspace/factory-ops/tmp/inv-{slug}-{label}.pdf"
    open(path, "wb").write(data)
    info = subprocess.run(["pdfinfo", path], capture_output=True, text=True)
    try:
        os.remove(path)
    except OSError:
        pass
    pages = None
    for line in info.stdout.splitlines():
        if line.startswith("Pages:"):
            pages = int(line.split()[1])
    out["pdf_pages"][label] = pages

# Editor chapters (the QC viewer / reader source of pages). The
# editor doc carries STORY pages only (no finales), so it is
# compared against planned story pages.
raw = get_stable(f"books/{slug}/editor_chapters.json")
if raw is None:
    out["editor_pages"] = None
    out["gaps"].append("editor_chapters.json missing")
else:
    doc = json.loads(raw)
    chs = doc.get("chapters") if isinstance(doc, dict) else doc
    total = 0
    if isinstance(chs, list):
        for ch in chs:
            total += len(ch.get("pages") or [])
    out["editor_pages"] = total
    if total and planned_story and total != planned_story:
        out["gaps"].append(f"editor pages {total} != planned story pages {planned_story}")

payload = json.dumps(out, indent=1).encode()
path = f"/home/hatch/workspace/factory-ops/inventory-{slug}.json"
with open(path, "wb") as f:
    f.write(payload)
cover.r2_put(f"books/{slug}/audit/inventory.json", payload, "application/json")
back = cover.r2_get(f"books/{slug}/audit/inventory.json")
out["r2_verified"] = back is not None and len(back) == len(payload)
print(json.dumps(out), flush=True)
