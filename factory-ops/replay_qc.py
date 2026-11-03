"""Replay the factory's Clef color-QC on EXISTING image bytes with an
explicit cast (the factory castForPage equivalent, incl. both herons).
Usage: replay_qc.py <image_file> <slug> <Name1,Name2,...>
Prints per-gate scores and a PASS/FAIL verdict at the factory color bars.
"""
import sys, json, base64, urllib.request, io
sys.path.insert(0, "/home/hatch/workspace/kidsbook-video/runner")
sys.path.insert(0, "/home/hatch/workspace/factory-ops")
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
import cover
import dynamic_credentials
from cast_audit import CLEF_URL
from PIL import Image

img_file, slug, names = sys.argv[1], sys.argv[2], sys.argv[3].split(",")
img = open(img_file, "rb").read()
bible = json.loads(cover.r2_get(f"books/{slug}/bible.json"))
named = [c for c in bible["characters"] if c["name"] in names]
cast_text = ", ".join(f"{c['name']} (a {c['species']})" for c in named)
print("cast:", cast_text)

def small(b, w=1024):
    im = Image.open(io.BytesIO(b)).convert("RGB")
    if im.width > w:
        im = im.resize((w, int(im.height * w / im.width)))
    out = io.BytesIO(); im.save(out, "JPEG", quality=85)
    return out.getvalue()

def judge(images, questions, state):
    body = json.dumps({"model": "clef", "state": state, "questions": questions,
                       "images": [{"content_type": "image/png" if b[:2] == b"\x89P" else "image/jpeg",
                                   "base64": base64.b64encode(b).decode()} for b in images]}).encode()
    req = urllib.request.Request(CLEF_URL, data=body, method="POST",
                                 headers={"Content-Type": "application/json", "User-Agent": "curl/8.0"})
    dynamic_credentials.add_surrogate_to_request(req, "custom.cloudflare", entry_name="access_token",
                                                 allowed_hosts=["api.cloudflare.com"])
    with urllib.request.urlopen(req, timeout=120) as r:
        outj = json.loads(r.read())
    answers = (outj.get("result") or {}).get("answers") or {}
    return {k: (v or {}).get("noul") for k, v in answers.items()}

q = {
    "has_text": {"type": "noul", "instructions": "Does this image contain any text, letters, numbers, or words drawn anywhere in it, even a single letter, including tiny labels, name tags, speech bubbles, stamps, or writing on objects?"},
    "is_color": {"type": "noul", "instructions": "Is this a full-color children's picture book illustration with bright, cheerful colors throughout (not black-and-white line art)?"},
    "anatomy": {"type": "noul", "instructions": "Does every animal in this image have correct, natural anatomy: exactly one tail per animal, the normal number of legs and ears, and no extra, missing, or duplicated body parts anywhere?"},
    "cast_match": {"type": "noul", "instructions": f"The story says these characters appear in this scene: {cast_text}. Is every named character present in the image, and is each one drawn as the correct species (for example, a character who should be a turtle must not be drawn as a fox)?"},
    "single_scene": {"type": "noul", "instructions": "Is this image ONE single scene (one moment, in one place), and NOT a character study sheet, model sheet, or collage that shows the same character in several separate poses against a plain background?"},
    "no_humans": {"type": "noul", "instructions": "Does this image contain NO human people, human children, human faces, or human hands anywhere in it?"},
}
for i, c in enumerate(named[:3]):
    visual = (c.get("visual") or "")[:140]
    q[f"dupe_{i}"] = {"type": "noul", "instructions": f"The character {c['name']} is a {c['species']}, described as: {visual}. Is {c['name']} drawn AT MOST ONCE in this image? Answer yes only if the character appears zero or one times, never two or more times in any pose or size. A reflection of the character in water or a mirror, and the character's shadow, do NOT count as another appearance."}

img_s = small(img)
scores = judge([img_s], q, "A generated full-color book illustration is attached for quality control.")
for c in named:
    sheet = cover.r2_get(f"characters/{c['name'].lower()}.png")
    q2 = {"character_match": {"type": "noul", "instructions": "The SECOND image is the official character reference sheet. Does the main character in the FIRST image match the reference character: same species, same body shape and proportions, same face, and the same signature clothing or accessory? Answer about the character design only, not the scene."}}
    s2 = judge([img_s, small(sheet)], q2, "A generated full-color book illustration is attached for quality control.")
    scores[f"character_match_{c['name']}"] = s2.get("character_match")

BARS = {"has_text": lambda v: v <= 0.12, "is_color": lambda v: v >= 0.5, "anatomy": lambda v: v >= 0.3,
        "cast_match": lambda v: v >= 0.5, "single_scene": lambda v: v >= 0.5, "no_humans": lambda v: v >= 0.5}
fails = []
for k, v in scores.items():
    print(f"  {k}: {None if v is None else round(v, 3)}")
    if v is None:
        continue
    if k.startswith("dupe_") or k.startswith("character_match"):
        if v < 0.5: fails.append(k)
    elif k in BARS and not BARS[k](v):
        fails.append(k)
print("VERDICT:", "PASS" if not fails else f"FAIL on {fails}")
