"""Offline colorize diagnosis: generate ONE color attempt for a held
page with the factory's exact prompt + refs, then replay the factory's
exact Clef color-QC questions and print scores against the bars.
Usage: probe_color.py <slug> <chapter> <page_index>   e.g. mastery S5 1
"""
import sys, json, base64, urllib.request
sys.path.insert(0, "/home/hatch/workspace/kidsbook-video/runner")
sys.path.insert(0, "/home/hatch/workspace/factory-ops")
sys.path.insert(0, "/home/hatch/workspace/custom-connectors/custom.vercel-ai-gateway/bin")
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
import cover
import gateway
import dynamic_credentials

slug, chapter, pidx = sys.argv[1], sys.argv[2], int(sys.argv[3])
bible = json.loads(cover.r2_get(f"books/{slug}/bible.json"))
plan = json.loads(cover.r2_get(f"books/{slug}/plans/{chapter}.json"))
if pidx == -1:
    pg = plan["finale"]
    line = cover.r2_get(f"books/{slug}/images/{chapter}-finale.jpg")
else:
    pg = plan["pages"][pidx]
    line = cover.r2_get(f"books/{slug}/images/{chapter}-page-{pidx}.jpg")

# cast as colorize.ts builds it since the 2026-11-01 fix: character
# field + scene cast names + the art prompt (never the story text)
hay = (f"{pg.get('character','')} " + ", ".join(str(c.get('name','')) for c in (pg.get('cast') or []))
       + " " + (pg.get('imagePrompt') or "")).lower()
named = [c for c in bible["characters"] if c["name"].lower() in hay]
if not named:
    named = [bible["characters"][0]]
cast_text = ", ".join(f"{c['name']} (a {c['species']})" for c in named)
print("cast for QC:", cast_text)

# refs: line page + each named character's sheet (loadPageRefs approx)
refs = [line]
for c in named:
    try:
        refs.append(cover.r2_get(f"characters/{c['name'].lower()}.png"))
    except Exception as e:
        print("sheet miss", c["name"], e)

PROMPT = ("Colorize the first image: a black-and-white line drawing from a children's picture book. "
          "Keep every line, character, pose, and object exactly where it is. Only add rich, warm "
          "watercolor color inside the existing lines, matching the character reference sheets "
          "when they are provided. Do not add, remove, move, or redraw anything. "
          "No text, no letters, no words, no numbers anywhere in the image.")
content = [{"type": "text", "text": PROMPT}]
for r in refs:
    ct = "image/png" if r[:2] == b"\x89P" else "image/jpeg"
    content.append({"type": "image_url", "image_url": {"url": f"data:{ct};base64," + base64.b64encode(r).decode()}})
resp = gateway.call("POST", "/chat/completions", {
    "model": "google/gemini-nano-banana-2.1",
    "messages": [{"role": "user", "content": content}],
    "modalities": ["text", "image"],
    "providerOptions": {"google": {"responseModalities": ["TEXT", "IMAGE"],
                                   "imageConfig": {"aspectRatio": "3:4", "imageSize": "2K"}}},
})
img = None
msg = (resp.get("choices") or [{}])[0].get("message") or {}
for key in ("images", "image", "files"):
    v = msg.get(key)
    if v:
        items = v if isinstance(v, list) else [v]
        for it in items:
            s = it if isinstance(it, str) else (it.get("image_url") or {}).get("url") or it.get("url") or it.get("b64_json") or it.get("data") or ""
            if isinstance(s, str) and "," in s:
                img = base64.b64decode(s.split(",", 1)[1]); break
    if img: break
if not img and isinstance(msg.get("content"), list):
    for p in msg["content"]:
        if p.get("type") in ("image", "image_url", "output_image"):
            s = (p.get("image_url") or {}).get("url") or p.get("b64_json") or p.get("data") or ""
            if s and "," in s:
                img = base64.b64decode(s.split(",", 1)[1]); break
if not img:
    print("NO IMAGE in response:", json.dumps(resp)[:400]); sys.exit(1)
out = f"/tmp/probe-{slug}-{chapter}p{pidx}.jpg"
open(out, "wb").write(img)
print("attempt saved:", out, len(img), "bytes; usage cost:", (resp.get("usage") or {}).get("cost"))

# ---- Clef color questions, exactly as qcColorWithClef builds them
from cast_audit import CLEF_URL  # noqa

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
scores = judge([img], q, "A generated full-color book illustration is attached for quality control.")
print("QC scores (bars: has_text<=0.12, is_color>=0.5, anatomy>=0.5, cast_match>=0.5, dupe>=0.5, single_scene>=0.5, no_humans>=0.5):")
for k, v in scores.items():
    print(f"  {k}: {v if v is None else round(v, 3)}")
# character_match against the lead sheet (second image), as the factory runs it
sheet = refs[1] if len(refs) > 1 else None
if sheet:
    q2 = {"character_match": {"type": "noul", "instructions": "The SECOND image is the official character reference sheet. Does the main character in the FIRST image match the reference character: same species, same body shape and proportions, same face, and the same signature clothing or accessory? Answer about the character design only, not the scene."}}
    s2 = judge([img, sheet], q2, "A generated full-color book illustration is attached for quality control.")
    print("  character_match:", s2.get("character_match"))
    scores["character_match"] = s2.get("character_match")

# ---- archive the probe roll like the factory now does (gen_attempts)
BARS = [("has_text", lambda v: v <= 0.12), ("is_color", lambda v: v >= 0.5),
        ("anatomy", lambda v: v >= 0.3), ("cast_match", lambda v: v >= 0.5),
        ("character_match", lambda v: v >= 0.5), ("single_scene", lambda v: v >= 0.5),
        ("no_humans", lambda v: v >= 0.5)]
reason = None
for k, ok in BARS:
    v = scores.get(k)
    if v is not None and not ok(v):
        reason = f"{k}={v:.3f} failed its bar (probe replay)"
        break
for i in range(3):
    v = scores.get(f"dupe_{i}")
    if v is not None and v < 0.5:
        reason = f"dupe_{i}={v:.3f} below 0.5 (probe replay)"
        break
outcome = "qc_reject" if reason else "accepted"
try:
    sys.path.insert(0, "/home/hatch/workspace/kidsbook-video")
    sys.path.insert(0, "/home/hatch/workspace/factory-ops")
    import audiobook_gen
    from cf import d1
    is_png = img[:2] == b"\x89P"
    key = f"books/{slug}/attempts/colorize/{chapter}-p{pidx}-probe-{int(__import__('time').time())}.{'png' if is_png else 'jpg'}"
    audiobook_gen.r2_put(out, key, "image/png" if is_png else "image/jpeg")
    cost = (resp.get("usage") or {}).get("cost")
    # cf.d1 takes raw SQL only; build it with escaped literals
    import json as _j
    def esc(s):
        return "'" + str(s).replace("'", "''") + "'"
    sql = ("INSERT INTO gen_attempts (slug, kind, chapter, page, attempt, outcome, reason, scores, cost, image_key, created_at) VALUES ("
           f"{esc(slug)}, 'colorize', {esc(chapter)}, {pidx}, 0, {esc(outcome)}, "
           f"{esc(reason) if reason else 'NULL'}, {esc(_j.dumps(scores))}, {cost if cost else 'NULL'}, {esc(key)}, CAST(strftime('%s','now') AS INTEGER))")
    d1(sql)
    print(f"archived as gen_attempts row ({outcome}) key={key}")
except Exception as e:
    print("archive failed (probe result still valid):", e)
