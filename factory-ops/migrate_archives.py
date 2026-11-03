"""Slug migration stage 1b: copy archive snapshots books/mastery/archive/**
to the new prefix. Single-pass probe+copy (r2_get is the existence test;
the earlier HEAD-based probe silently failed on existing keys).
Snapshots contain images, images-color, plans, bible.json,
editor_chapters.json and similar small artifacts; PDFs, the M4B, the
EPUB, covers and audio are NOT snapshotted (verified by direct reads).
Resumable: progress in migration-archives-progress.json.
Usage: migrate_archives.py --go
"""
import sys, json, time
sys.path.insert(0, "/home/hatch/workspace/kidsbook-video/runner")
import cover

OLD, NEW = "mastery", "mira-the-heron-and-the-still-water"
OP, NP = f"books/{OLD}/", f"books/{NEW}/"
PROG = "/home/hatch/workspace/factory-ops/migration-archives-progress.json"
GO = "--go" in sys.argv

CT = {".jpg": "image/jpeg", ".png": "image/png", ".json": "application/json",
      ".txt": "text/plain"}
def ctype(k):
    for ext, ct in CT.items():
        if k.endswith(ext): return ct
    return "application/octet-stream"

def retry(fn, tries=4):
    for i in range(tries):
        try:
            return fn()
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(2 * (i + 1))

try:
    done = set(json.load(open(PROG)))
except Exception:
    done = set()

live = set(json.load(open("/home/hatch/workspace/factory-ops/migration-mastery-keys.json")))
for ch in range(1, 9):
    live.add(f"{OP}plans/S{ch}.json")
EXCLUDE_PREFIX = (f"{OP}attempts/", f"{OP}editions/", f"{OP}audio/", f"{OP}archive/")
EXCLUDE_EXACT = {f"{OP}versions.json", f"{OP}cover.jpg", f"{OP}cover-titled.jpg",
                 f"{OP}cover-w400.webp", f"{OP}cover-w960.webp"}
rel_live = []
for k in sorted(live):
    if k.startswith(EXCLUDE_PREFIX) or k in EXCLUDE_EXACT:
        continue
    if k.endswith((".pdf", ".m4b", ".epub")):
        continue
    rel_live.append(k[len(OP):])
print("candidate rel keys per version:", len(rel_live), flush=True)

versions = json.loads(cover.r2_get(f"{OP}versions.json"))
copied = skipped = failed = 0
failed_keys = []
for v in versions.get("versions", []):
    n = v["version"]
    for rel in rel_live:
        ak = f"{OP}archive/v{n}/{rel}"
        if ak in done:
            skipped += 1
            continue
        try:
            data = retry(lambda: cover.r2_get(ak))
        except Exception:
            data = None
            failed += 1; failed_keys.append(ak); continue
        if data is None:
            done.add(ak)  # confirmed absent; don't reprobe next run
            continue
        if ak.endswith(".json"):
            try:
                t = data.decode("utf-8")
                t = t.replace(f"books/{OLD}/", f"books/{NEW}/")
                data = t.encode("utf-8")
            except Exception:
                pass
        if GO:
            try:
                retry(lambda: cover.r2_put(NP + ak[len(OP):], data, ctype(ak)))
            except Exception:
                failed += 1; failed_keys.append(ak); continue
        done.add(ak); copied += 1
        if copied % 25 == 0:
            json.dump(sorted(done), open(PROG, "w"))
            print(f"v{n}: copied {copied} so far", flush=True)
    print(f"v{n} done (copied total {copied}, already-done {skipped})", flush=True)
json.dump(sorted(done), open(PROG, "w"))
print("archives copied:", copied, "| skipped:", skipped, "| failed:", failed, failed_keys[:5])
