"""Replay the factory's exact line-QC questions against saved page bytes.
Usage: probe_qc.py <slug> <localfile>=<chapter> <localfile>=<chapter> ...
Cast derived like genImageWithQC: bible names found in plan character field + prompt."""
import sys, json
sys.path.insert(0, "/home/hatch/workspace/kidsbook-video/runner")
sys.path.insert(0, "/home/hatch/workspace/factory-ops")
import cover
from cast_audit import clef_judge

slug = sys.argv[1]
bible = json.loads(cover.r2_get(f"books/{slug}/bible.json"))
sheet = cover.r2_get(f"characters/{bible['characters'][0]['name'].lower()}.png")

def questions_for(chapter, page_idx):
    plan = json.loads(cover.r2_get(f"books/{slug}/plans/{chapter}.json"))
    pg = plan["pages"][page_idx]
    hay = f"{pg.get('character','')} {pg.get('imagePrompt','')}".lower()
    named = [c for c in bible["characters"] if c["name"].lower() in hay]
    cast_text = ", ".join(f"{c['name']} (a {c['species']})" for c in named)
    q = {
        "has_text": {"type": "noul", "instructions": "Does this image contain any text, letters, numbers, or words drawn anywhere in it, even a single letter, including tiny labels, name tags, speech bubbles, stamps, or writing on objects?"},
        "has_color": {"type": "noul", "instructions": "Does this image contain any color, shading, or gray fills (anything other than pure black lines on white)?"},
        "is_lineart": {"type": "noul", "instructions": "Is this a clean black-and-white line-art coloring page for kids, with bold outlines and wide white margins?"},
    }
    if cast_text:
        q["anatomy"] = {"type": "noul", "instructions": "Does every animal in this image have correct, natural anatomy: exactly one tail per animal, the normal number of legs and ears, and no extra, missing, or duplicated body parts anywhere?"}
        q["cast_match"] = {"type": "noul", "instructions": f"The story says these characters appear in this scene: {cast_text}. Is every named character present in the image, and is each one drawn as the correct species (for example, a character who should be a turtle must not be drawn as a fox)?"}
    for i, c in enumerate(named[:3]):
        visual = (c.get("visual") or "")[:140]
        q[f"dupe_{i}"] = {"type": "noul", "instructions": f"The character {c['name']} is a {c['species']}, described as: {visual}. Is {c['name']} drawn AT MOST ONCE in this image? Answer yes only if the character appears zero or one times, never two or more times in any pose or size."}
    if named:
        q["single_scene"] = {"type": "noul", "instructions": "Is this image ONE single scene (one moment, in one place), and NOT a character study sheet, model sheet, or collage that shows the same character in several separate poses against a plain background?"}
        if not any(w in (c["species"] or "").lower() for c in named for w in ("human","person","boy","girl","child","man","woman","people")):
            q["no_humans"] = {"type": "noul", "instructions": "Does this image contain NO human people, human children, human faces, or human hands anywhere in it?"}
    return q, [c["name"] for c in named]

for spec in sys.argv[2:]:
    path, chapter, pidx = spec.rsplit("=", 2)[0], None, None
    f, rest = spec.split("=", 1)
    chapter, pidx = rest.rsplit("p", 1)
    img = open(f, "rb").read()
    q, names = questions_for(chapter, int(pidx))
    # factory also attaches the lead sheet + character_match; clef_judge takes one image,
    # so character_match is probed separately below.
    scores = clef_judge(img, q)
    print(f"{f} ({chapter}p{pidx}, cast {names}):")
    for k, v in scores.items():
        print(f"   {k}: {v if v is None else round(v, 3)}")
