#!/usr/bin/env python3
"""Full cast/art audit of shipped pages, re-judged with Clef.

Generation-time QC asked bundled questions (one cast_match verdict for
the whole scene). This audit asks one sharp proposition per defect, so
each failure mode is measured separately:

- count per species: 'more than N {species}' where N is how many of
  that species the scene actually calls for. Catches CLONES (N=1) and
  UNPLANNED EXTRAS (N=0) with the same question, and stays correct for
  books whose cast shares a species (three squirrels are fine when the
  scene wants three squirrels).
- presence per expected character, described by the bible visual:
  catches a character who is MISSING or quietly REPLACED by another
  animal (the two-foxes-instead-of-a-turtle defect).
- anatomy: duplicated or missing body parts on a single character
  (the two-tails cover defect).
- text baked into the art, at the factory's own 0.12 bar.

Expected cast per page follows the house rule: names found in the
page's art prompt, union the plan's character field. Flags are for a
visual re-check, not automatic verdicts.

Usage: python3 cast_audit.py <slug>
Writes ~/workspace/factory-ops/cast-audit-<slug>.json and prints flags.
"""
import base64
import json
import re
import sys
import urllib.request

sys.path.insert(0, "/home/hatch/workspace/kidsbook-video/runner")
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
import cover  # noqa: E402
import dynamic_credentials  # noqa: E402

ACCT = "5af47adc047fa74dcfa59048858b486c"
CLEF_URL = f"https://api.cloudflare.com/client/v4/accounts/{ACCT}/ai/run/@cf/cloudflare/clef"


def clef_judge(img: bytes, questions: dict) -> dict:
    ct = "image/png" if img[:2] == b"\x89P" else "image/jpeg"
    body = json.dumps({
        "model": "clef",
        "state": "A generated coloring-book page image is attached. Judge each statement about it.",
        "questions": questions,
        "images": [{"content_type": ct, "base64": base64.b64encode(img).decode()}],
    }).encode()
    req = urllib.request.Request(CLEF_URL, data=body, method="POST", headers={
        "Content-Type": "application/json", "User-Agent": "curl/8.0"})
    dynamic_credentials.add_surrogate_to_request(
        req, "custom.cloudflare", entry_name="access_token",
        allowed_hosts=["api.cloudflare.com"])
    with urllib.request.urlopen(req, timeout=120) as r:
        out = json.loads(r.read())
    answers = (out.get("result") or {}).get("answers") or {}
    return {k: (v or {}).get("noul") for k, v in answers.items()}


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", (s or "").lower()).split()


def _visual_in_prompt(visual: str, prompt_words: list) -> bool:
    """Plans embed a character's bible visual verbatim in the art prompt
    when that character is in the scene, often without the name (docker
    S1p0 describes Pip by appearance only). A shared run of 6 words is
    distinctive enough to count the character as expected."""
    vw = _norm(visual)
    if len(vw) < 6:
        return False
    pset = {" ".join(prompt_words[i:i + 6]) for i in range(len(prompt_words) - 5)}
    return any(" ".join(vw[i:i + 6]) in pset for i in range(len(vw) - 5))


def expected_cast(plan_page: dict, cast_by_name: dict) -> list:
    found = []
    prompt = plan_page.get("imagePrompt") or ""
    prompt_words = _norm(prompt)
    field = plan_page.get("character") or ""
    field_names = field if isinstance(field, list) else [field]
    for name, c in cast_by_name.items():
        if (name in field_names
                or re.search(rf"\b{re.escape(name)}\b", prompt)
                or _visual_in_prompt(c.get("visual") or "", prompt_words)):
            found.append(c)
    return found


def main():
    slug = sys.argv[1]
    color = len(sys.argv) > 2 and sys.argv[2] == "color"
    edition = "color" if color else "line"
    bible = json.loads(cover.r2_get(f"books/{slug}/bible.json"))
    cast = bible["characters"]
    cast_by_name = {c["name"]: c for c in cast}
    species_list = sorted({c["species"] for c in cast})
    print(f"{slug}: cast {[(c['name'], c['species']) for c in cast]}", flush=True)

    pages = []
    n = 1
    while True:
        raw = cover.r2_get(f"books/{slug}/plans/S{n}.json")
        if raw is None:
            break
        plan = json.loads(raw)
        for pi, pg in enumerate(plan.get("pages") or []):
            if pg.get("imageKey"):
                pages.append((f"S{n}p{pi}", pg))
        fin = plan.get("finale") or {}
        if isinstance(fin, dict) and fin.get("imageKey"):
            pages.append((f"S{n} finale", fin))
        n += 1
    print(f"{len(pages)} pages to judge", flush=True)

    flags, results = [], []
    for i, (label, pg) in enumerate(pages):
        key = pg["imageKey"]
        if color:
            key = key.replace("/images/", "/images-color/")
        data = cover.r2_get(key)
        if data is None:
            print(f"  {label}: IMAGE MISSING {key}", flush=True)
            continue
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
        # Added 2026-11-02 (CG's catalog-wide judgment run): the three
        # defect classes generation-time gates kept missing on the
        # early books - a HUMAN drawn into a no-humans book, a stranger
        # whose species is not in this book's cast at all, and color
        # fill bleeding into a LINE page.
        questions["has_human"] = {
            "type": "noul",
            "instructions": "A human person, or a character shaped like a human child or adult with human skin, hair, hands, and clothes, appears in this image.",
        }
        sp_list = ", ".join(species_list)
        questions["foreign_species"] = {
            "type": "noul",
            "instructions": f"This book's characters are only these species: {sp_list}. A character of any OTHER species appears in this image.",
        }
        if not color:
            questions["has_color"] = {
                "type": "noul",
                "instructions": "Any part of this drawing is filled with color or with gray shading or gray tones, instead of being pure black line art on white paper throughout.",
            }
        questions["has_text"] = {
            "type": "noul",
            "instructions": "Does this image contain any text, letters, numbers, or words drawn anywhere in it, even a single letter, including tiny labels, name tags, speech bubbles, stamps, or writing on objects?",
        }
        try:
            scores = clef_judge(data, questions)
        except Exception as ex:
            print(f"  {label}: clef error {ex}", flush=True)
            continue
        results.append({"page": label, "key": key,
                        "expected": [c["name"] for c in exp], "scores": scores})

        def flag(kind, detail, score, cls):
            flags.append({"page": label, "kind": kind, "detail": detail, "cls": cls,
                          "score": None if score is None else round(score, 3),
                          "expected": [c["name"] for c in exp], "key": key})
            print(f"  FLAG[{cls}] {label}: {kind} - {detail} (p={score})", flush=True)

        for sp in species_list:
            sc = scores.get(f"count_{sp}")
            if sc is not None and sc >= 0.5:
                want = exp_species_count.get(sp, 0)
                # want>=1: the scene allows some and Clef sees more ->
                # clone-likely (docker sample verified 5/5). want==0:
                # may be an intended co-star the plan described loosely
                # -> human review, not a verdict.
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
        if (i + 1) % 20 == 0:
            print(f"  ...{i + 1}/{len(pages)} judged, {len(flags)} flags", flush=True)

    suffix = f"-{edition}" if color else ""
    out_path = f"/home/hatch/workspace/factory-ops/cast-audit-{slug}{suffix}.json"
    with open(out_path, "w") as f:
        json.dump({"slug": slug, "edition": edition, "flags": flags, "results": results}, f, indent=1)
    print(f"DONE {slug} ({edition}): {len(pages)} pages, {len(flags)} flags -> {out_path}", flush=True)


if __name__ == "__main__":
    main()
