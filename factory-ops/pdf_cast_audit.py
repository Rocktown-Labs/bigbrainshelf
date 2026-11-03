#!/usr/bin/env python3
"""PDF version audit (CG, 2026-11-02): gate the three DELIVERED
PDFs of a book - the story book and the coloring book (the two
black-and-white versions) and the full color edition - page by
page, then compare across versions.

Story pages are identified by position: rendered pages whose
text marks them as book furniture (cover, copyright, contents,
glossary, cast page) are set aside; the rest, in order, map 1:1
onto the plan pages. Each story page is judged with the cast
audit's question set against the cast its plan expects. A page
flagged in one version and clean in another lands in the
disagreement list: that is a version defect, not just a page
defect (a stale or divergent PDF page).

Usage: python3 pdf_cast_audit.py <internal-slug>
Writes pdf-audit-<slug>.json locally and to
books/<slug>/audit/pdf-audit.json (verified by read-back).
"""
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, "/home/hatch/workspace/kidsbook-video/runner")
sys.path.insert(0, "/home/hatch/workspace/factory-ops")
import cover  # noqa: E402
from cast_audit import clef_judge, expected_cast  # noqa: E402
from pdf_vision_qc import is_matter, page_text  # noqa: E402

slug = sys.argv[1]


def get_stable(key):
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


bible = json.loads(get_stable(f"books/{slug}/bible.json"))
cast = bible["characters"]
cast_by_name = {c["name"]: c for c in cast}
species_list = sorted({c["species"] for c in cast})

plan_pages = []
for n in range(1, 41):
    raw = get_stable(f"books/{slug}/plans/S{n}.json")
    if raw is None:
        continue
    plan = json.loads(raw)
    for pi, pg in enumerate(plan.get("pages") or []):
        if pg.get("imageKey"):
            plan_pages.append((f"S{n}p{pi}", pg))
    fin = plan.get("finale") or {}
    if isinstance(fin, dict) and fin.get("imageKey"):
        plan_pages.append((f"S{n} finale", fin))
print(f"{slug}: {len(plan_pages)} planned story pages", flush=True)

rows = cover.d1("SELECT * FROM books WHERE slug=?", params=[slug])["results"]
row = rows[0] if rows else {}


def key_for(needle, exclude=None):
    for col, val in row.items():
        if needle in col and col.endswith("_key") and val and col != exclude:
            if exclude and exclude in col:
                continue
            return val
    return None


VERSIONS = [
    ("story", key_for("picture"), True),
    ("coloring", key_for("coloring"), True),
    ("color", key_for("color", exclude="coloring"), False),
]

# The coloring assembly never includes chapter finales (factory
# bookbuild.ts/repair.ts push finales to storyPages only), so the
# coloring book's expected sequence is the plan pages minus the
# finales. Judging it against the full sequence would misalign
# every page after the first finale; the exclusion itself is
# recorded as a gap on the book.
FINALE_GAP = "coloring book omits every chapter finale page (factory assembly pushes finales to the story book only)"


def judge_page(img_bytes, pg, is_line):
    exp = expected_cast(pg, cast_by_name)
    exp_species_count = {}
    for c in exp:
        exp_species_count[c["species"]] = exp_species_count.get(c["species"], 0) + 1
    questions = {}
    for sp in species_list:
        want = exp_species_count.get(sp, 0)
        questions[f"count_{sp}"] = {
            "type": "noul",
            "instructions": f"There are more than {want} {sp} character{'s' if want != 1 else ''} in this image.",
        }
    for c in exp:
        questions[f"present_{c['name']}"] = {
            "type": "noul",
            "instructions": f"The character described as: {c['visual'][:160]} appears in this image.",
        }
    questions["anatomy_ok"] = {
        "type": "noul",
        "instructions": "Every animal in this image has correct, natural anatomy: exactly one tail per animal, the normal number of legs, ears, and wings, and no extra, missing, or duplicated body parts anywhere.",
    }
    questions["has_human"] = {
        "type": "noul",
        "instructions": "A human person, or a character shaped like a human child or adult with human skin, hair, hands, and clothes, appears in this image.",
    }
    sp_list = ", ".join(species_list)
    questions["foreign_species"] = {
        "type": "noul",
        "instructions": f"This book's characters are only these species: {sp_list}. A character of any OTHER species appears in this image.",
    }
    if is_line:
        questions["has_color"] = {
            "type": "noul",
            "instructions": "Any part of this drawing is filled with color or with gray shading or gray tones, instead of being pure black line art on white paper throughout.",
        }
    questions["has_text"] = {
        "type": "noul",
        "instructions": "Does this image contain any text, letters, numbers, or words drawn anywhere in it, even a single letter, including tiny labels, name tags, speech bubbles, stamps, or writing on objects?",
    }
    scores = clef_judge(img_bytes, questions)
    flags = []

    def flag(kind, detail, score, cls):
        flags.append({"kind": kind, "detail": detail, "cls": cls,
                      "score": None if score is None else round(score, 3)})

    for sp in species_list:
        sc = scores.get(f"count_{sp}")
        if sc is not None and sc >= 0.5:
            want = exp_species_count.get(sp, 0)
            flag("count", f"more than {want} {sp} in scene", sc,
                 "clone-likely" if want >= 1 else "extra-review")
    for c in exp:
        sc = scores.get(f"present_{c['name']}")
        if sc is not None and sc < 0.4:
            flag("missing", f"{c['name']} ({c['species']}) expected but not found", sc, "review")
    sc = scores.get("anatomy_ok")
    if sc is not None and sc < 0.5:
        flag("anatomy", "anatomy check failed", sc, "advisory")
    sc = scores.get("has_text")
    if sc is not None and sc > 0.12:
        flag("text", "text baked into art", sc, "review")
    sc = scores.get("has_human")
    if sc is not None and sc >= 0.5:
        flag("human", "a human or human-shaped character is drawn", sc, "defect")
    sc = scores.get("foreign_species")
    if sc is not None and sc >= 0.5:
        flag("foreign", "a character whose species is not in this book's cast", sc, "review")
    sc = scores.get("has_color")
    if sc is not None and sc >= 0.3:
        flag("colorfill", "color or gray fill on a line page", sc, "defect")
    return flags


report = {"slug": slug, "planned_story_pages": len(plan_pages), "versions": {}, "gaps": [], "disagreements": []}
flagged_by_page = {}  # label -> {version: [kinds]}

for vname, key, is_line in VERSIONS:
    if not key:
        report["versions"][vname] = None
        report["gaps"].append(f"no {vname} PDF on file")
        continue
    data = get_stable(key)
    if data is None:
        report["versions"][vname] = None
        report["gaps"].append(f"{vname} PDF key in D1 but object missing: {key}")
        continue
    with tempfile.TemporaryDirectory() as wd:
        pdf_path = os.path.join(wd, f"{vname}.pdf")
        open(pdf_path, "wb").write(data)
        subprocess.run(["pdftoppm", "-png", "-r", "100", pdf_path, os.path.join(wd, "pg")],
                       check=True, capture_output=True, timeout=900)
        renders = sorted(f for f in os.listdir(wd) if f.startswith("pg-") and f.endswith(".png"))
        story_renders = []
        for i, fn in enumerate(renders):
            page_no = i + 1
            if page_no == 1 or page_no == len(renders):
                continue  # covers
            if is_matter(page_text(pdf_path, page_no)):
                continue  # furniture
            story_renders.append(os.path.join(wd, fn))
        vrep = {"pdf_pages": len(renders), "story_pages_found": len(story_renders), "flags": []}
        expected_pages = plan_pages
        if vname == "coloring":
            expected_pages = [p for p in plan_pages if "finale" not in p[0]]
            if len(expected_pages) != len(plan_pages):
                report["gaps"].append(f"{vname}: {FINALE_GAP}")
        if len(story_renders) != len(expected_pages):
            report["gaps"].append(
                f"{vname}: {len(story_renders)} story pages in the PDF vs {len(expected_pages)} expected")
        for idx, (label, pg) in enumerate(expected_pages):
            if idx >= len(story_renders):
                break
            try:
                pflags = judge_page(open(story_renders[idx], "rb").read(), pg, is_line)
            except Exception as ex:
                print(f"  {vname} {label}: clef error {ex}", flush=True)
                continue
            for f in pflags:
                f2 = {"page": label, **f}
                vrep["flags"].append(f2)
                print(f"  FLAG[{f['cls']}] {vname} {label}: {f['kind']} - {f['detail']} (p={f['score']})", flush=True)
            # 'text' flags are excluded from the cross-version
            # comparison: PDF renders include the book's own typeset
            # story text, so that gate fires on nearly every page of
            # every version and masks real disagreements (learned
            # 2026-11-02: the first rollout reported 0 disagreements
            # catalog-wide for exactly this reason). Text flags stay
            # in the per-version ledger above.
            real_flags = [f for f in pflags if f["kind"] != "text"]
            if real_flags:
                flagged_by_page.setdefault(label, {})[vname] = sorted({f["kind"] for f in real_flags})
        report["versions"][vname] = vrep
        print(f"{vname}: {len(vrep['flags'])} flags over {len(story_renders)} story pages", flush=True)

present_versions = [v for v, _, _ in VERSIONS if report["versions"].get(v)]
for label, per in flagged_by_page.items():
    # The coloring book has no finale pages at all (assembly gap
    # recorded above), so it is neither flagged nor clean on them.
    applicable = [v for v in present_versions if not ("finale" in label and v == "coloring")]
    clean = [v for v in applicable if v not in per]
    if clean and any(v in per for v in applicable):
        report["disagreements"].append({"page": label, "flagged_in": per, "clean_in": clean})

payload = json.dumps(report, indent=1).encode()
out_path = f"/home/hatch/workspace/factory-ops/pdf-audit-{slug}.json"
with open(out_path, "wb") as f:
    f.write(payload)
cover.r2_put(f"books/{slug}/audit/pdf-audit.json", payload, "application/json")
back = cover.r2_get(f"books/{slug}/audit/pdf-audit.json")
print(f"DONE {slug}: disagreements {len(report['disagreements'])}, gaps {report['gaps']}, "
      f"r2 {'OK' if back is not None and len(back) == len(payload) else 'VERIFY FAILED'}", flush=True)
