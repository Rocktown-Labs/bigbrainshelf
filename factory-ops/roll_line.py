"""Roll LINE candidates for one page with an explicit identity block
appended to the plan prompt (CG's QC-note flow, offline edition).

Usage: roll_line.py <slug> <chapter> <page|-1=finale> <n> [extra note]
Saves candidates to ~/workspace/factory-ops/mira-qc-fix/, archives bytes
to R2 attempts + gen_attempts rows (outcome 'candidate'), Clef-screens
purity + per-character dupes, prints costs.
"""
import sys, json, base64, time, random
sys.path.insert(0, "/home/hatch/workspace/kidsbook-video/runner")
sys.path.insert(0, "/home/hatch/workspace/factory-ops")
sys.path.insert(0, "/home/hatch/workspace/custom-connectors/custom.vercel-ai-gateway/bin")
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
import cover
import gateway
from cast_audit import clef_judge

slug, chapter, pidx, n = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
extra_note = sys.argv[5] if len(sys.argv) > 5 else ""

bible = json.loads(cover.r2_get(f"books/{slug}/bible.json"))
plan = json.loads(cover.r2_get(f"books/{slug}/plans/{chapter}.json"))
pg = plan["finale"] if pidx == -1 else plan["pages"][pidx]

IDENTITY = (
    " CHARACTER IDENTITY, follow exactly: Mira is a young heron with a ROUND head, "
    "a slim SHORT yellow bill, and ONE small rust-orange tuft on her crown. "
    "Mira has NO long crest plumes and NO swept-back crest. "
    "Ansel is a much taller elderly heron with a LONG dagger-like bill and long wispy "
    "crest plumes swept back from his crown, a white face, and one slightly drooping wing; "
    "he has NO rust tuft. Never draw Mira as a smaller copy of Ansel."
)
prompt = (pg["imagePrompt"] or "") + IDENTITY
if extra_note:
    prompt += " " + extra_note
prompt += " Black-and-white line art only, bold clean outlines, no shading, no color, no text, no letters, no words."

hay = (f"{pg.get('character','')} " + (pg.get('imagePrompt') or "")).lower()
named = [c for c in bible["characters"] if c["name"].lower() in hay]
if not named:
    named = [bible["characters"][0]]
print("cast:", [c["name"] for c in named])

refs = []
for c in named:
    refs.append(cover.r2_get(f"characters/{c['name'].lower()}.png"))

tag = f"{chapter}p{pidx if pidx >= 0 else 'fin'}"
total = 0.0
for i in range(1, n + 1):
    content = [{"type": "text", "text": prompt}]
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
        print(f"cand{i}: NO IMAGE", json.dumps(resp)[:300]); continue
    cost = (resp.get("usage") or {}).get("cost") or 0
    total += float(cost or 0)
    local = f"/home/hatch/workspace/factory-ops/mira-qc-fix/{tag}-cand{i}.jpg"
    open(local, "wb").write(img)
    ts = int(time.time())
    rkey = f"books/{slug}/attempts/line/{chapter}-page-{pidx}-cand{i}-{ts}-{random.randint(1000,9999)}.jpg"
    cover.r2_put(rkey, img, "image/jpeg")
    q = {
        "has_text": "The image contains written text, letters, or words.",
        "is_lineart": "The image is black-and-white line art with no color and no shading.",
        "has_color": "The image contains color.",
        "no_humans": "The image contains no human people.",
    }
    for c in named:
        q[f"dupe_{c['name'].lower()}"] = (f"Counting reflections in water as NOT another animal: there is more than one "
                                          f"{c['species']} in the image that matches the appearance of {c['name']}.")
    try:
        from PIL import Image
        import io
        im = Image.open(io.BytesIO(img)).convert("RGB")
        im.thumbnail((1024, 1024))
        buf = io.BytesIO(); im.save(buf, "JPEG", quality=80)
        scores = clef_judge(buf.getvalue(), q)
    except Exception as e:
        print("clef screen skipped:", e); scores = {}
    reason = "cg-qc candidate: smaller-ansel drift fix"
    sql = ("INSERT INTO gen_attempts (slug, kind, chapter, page, attempt, outcome, reason, scores, cost, image_key, created_at) "
           f"VALUES ('{slug}', 'line', '{chapter}', {pidx}, {i}, 'candidate', '{reason}', "
           f"'{json.dumps(scores).replace(chr(39), chr(39)*2)}', {float(cost or 0)}, '{rkey}', {ts})")
    cover.d1(sql)
    print(f"cand{i}: {local} {len(img)}B cost={cost} scores={json.dumps(scores)}")
print("TOTAL COST:", round(total, 4))
