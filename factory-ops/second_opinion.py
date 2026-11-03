#!/usr/bin/env python3
"""Second-opinion (appeals) judge for factory QC rejects. SHADOW MODE.

Production QC (Clef) rejects a roll. This tool re-judges archived rejects
with a different model family (Gemini Flash, direct API, stored
custom.gemini credential) and LOGS the verdict to D1 qc_second_opinions.
It never accepts, ships, or changes anything. Its job is measurement:
how often does an independent judge say the production gate was wrong,
on which gates, and what would rescuing those rolls have saved?

Appeals are scoped to the noisy judgment gates (anatomy, dupe / cast
integrity, drift, single_scene). Reliable gates (has_text, has_color,
purity, is_lineart) are not appealable: the deterministic and Clef
readings there have no recorded false-reject problem.

Usage:
  python3 second_opinion.py --dry-run [--limit N]
  python3 second_opinion.py [--limit N] [--ids 12,13] [--force]

Auth: surrogate credential helper, same pattern as eval_cast_judge.py.
No raw key is printed or persisted.
"""

import argparse
import base64
import hashlib
import json
import sys
import time
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
sys.path.insert(0, "/home/hatch/workspace/factory-ops")
sys.path.insert(0, "/home/hatch/workspace/kidsbook-video")
sys.path.insert(0, "/home/hatch/workspace/custom-connectors/custom.vercel-ai-gateway/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response
from cf import d1
import audiobook_gen
import gateway as gw

MODEL = "gemini-3.8-flash"
BASE = "https://generativelanguage.googleapis.com/v1beta"
LUNA_MODEL = "openai/gpt-6-luna-decisions"

APPEALABLE_MARKERS = (
    "anatomy",
    "dupe",
    "cast integrity",
    "drift",
    "single_scene",
    "single scene",
)
RELIABLE_MARKERS = ("has_text", "has_color", "purity", "is_lineart", "text=")

PROMPT_TEMPLATE = """You are an appeals judge for a children's picture book factory. A first QC system rejected the attached book page illustration. Your job is to adjudicate the SPECIFIC claim that caused the rejection, then scan for other serious defects.

The rejection claim was:
"{claim}"

All of the first QC system's scores for this image (0 to 1, higher means the named good property is more present, except has_text and has_color where lower is cleaner):
{scores}

Adjudication rules:
- Judge ONLY what is actually drawn. Reflections and shadows of a character are part of that character, not a second character.
- Two animals of the same species can be two different characters. Look for distinguishing features (a crest or tuft, a scarf, a hat, different sizes, different postures) before calling something a duplicate.
- "Anatomy" is defective only if a body part is clearly wrong: a hand or foot shape where a wing, fin, or animal foot belongs, extra or missing limbs, limbs attached to the wrong body part. Normal stylized animal anatomy in a children's book is NOT defective.
- If the claim names a character appearing more than once, count that character using distinguishing features, not species alone.
- Be strict about real defects and honest about uncertainty. A page a child would notice as wrong is defective. A page only a scoring model could object to is not.

Answer with a single JSON object, no prose, with exactly these fields:
{{"claim_upheld": <true if the rejection claim describes a real defect in this image, false if the image does not have that defect>,
"any_serious_defect": <true if the image has ANY defect that should block it from a published children's book, including ones the claim did not name>,
"defects": ["<short plain description of each real defect you see, empty list if none>"],
"confidence": <0.0 to 1.0, your confidence in claim_upheld>,
"rationale": "<one or two sentences, what you saw>"}}"""


def is_appealable(reason: str) -> bool:
    r = (reason or "").lower()
    if any(m in r for m in RELIABLE_MARKERS):
        return False
    return any(m in r for m in APPEALABLE_MARKERS)


def fetch_candidates(limit, ids):
    if ids:
        rows = d1(
            "SELECT * FROM gen_attempts WHERE id IN (%s) ORDER BY id"
            % ",".join(str(int(i)) for i in ids)
        )
    else:
        rows = d1(
            "SELECT * FROM gen_attempts WHERE outcome NOT IN ('accepted','autofixed') ORDER BY id"
        )
    out = ((rows.get("result") or [{}])[0].get("results") or [])
    out = [r for r in out if is_appealable(r.get("reason") or "")]
    if limit:
        out = out[:limit]
    return out


def already_judged(attempt_id):
    r = d1("SELECT COUNT(*) n FROM qc_second_opinions WHERE attempt_id=%d" % attempt_id)
    rows = ((r.get("result") or [{}])[0].get("results") or [{}])
    return (rows[0].get("n") or 0) > 0


def judge(image_bytes, mime, claim, scores_json):
    prompt = PROMPT_TEMPLATE.format(claim=claim, scores=scores_json)
    body = {
        "contents": [
            {
                "parts": [
                    {"text": prompt},
                    {
                        "inline_data": {
                            "mime_type": mime,
                            "data": base64.b64encode(image_bytes).decode(),
                        }
                    },
                ]
            }
        ],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
            "thinkingConfig": {"thinkingBudget": 0},
        },
    }
    req = urllib.request.Request(
        f"{BASE}/models/{MODEL}:generateContent",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    add_surrogate_to_request(
        req, "custom.gemini", allowed_hosts=["generativelanguage.googleapis.com"]
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = read_json_response(resp)
    text = data["candidates"][0]["content"]["parts"][0]["text"]
    verdict = json.loads(text)
    usage = data.get("usageMetadata") or {}
    return verdict, usage.get("promptTokenCount"), usage.get("candidatesTokenCount")


def judge_luna(image_bytes, mime, claim, scores_json):
    """GPT-6 Luna Decisions via the Vercel AI Gateway (POST /v1/decisions).

    Through the gateway the model slug is openai/gpt-6-luna-decisions
    (gpt-6-luna alone is the direct-OpenAI model id; the gateway probe
    on 2026-11-01 returned 402 billing before model validation, which
    hid the wrong slug until CG supplied the gateway docs on 2026-11-01).
    The gateway's OpenAI-compatible endpoint documents input_text and
    input_image parts only, so the claim and production scores ride as
    a JSON text part, not an input_json part. Decisions returns typed
    probabilities, no prose: predicates map to the same verdict shape
    the Gemini backend produces, with the raw probabilities and the
    gateway-reported cost preserved in the rationale field.
    """
    data_url = f"data:{mime};base64," + base64.b64encode(image_bytes).decode()
    evidence = json.dumps({"rejection_claim": claim, "production_scores": scores_json})
    body = {
        "model": LUNA_MODEL,
        "input": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": (
                            "You are an appeals judge for a children's picture book factory. "
                            "A first QC system rejected the attached page illustration. "
                            "Adjudicate the rejection claim against what is actually drawn. "
                            "Reflections and shadows are part of a character, not a second character. "
                            "Two animals of the same species can be different characters; use distinguishing "
                            "features (crest, scarf, hat, size, posture) before calling a duplicate. "
                            "Stylized animal anatomy in a children's book is not defective; anatomy is "
                            "defective only when a body part is clearly wrong, such as a hand or human foot "
                            "shape where a wing, fin, or animal foot belongs, or limbs attached wrongly. "
                            f"The rejection evidence is: {evidence}"
                        ),
                    },
                    {"type": "input_image", "image_url": data_url},
                ],
            }
        ],
        "questions": [
            {
                "type": "predicate",
                "name": "claim_defect_present",
                "instructions": "Is the defect described in the rejection_claim actually present in this image?",
            },
            {
                "type": "predicate",
                "name": "serious_defect_present",
                "instructions": "Does this image have ANY defect serious enough to block it from a published children's book, including defects the claim did not name (drawn text, humans, broken anatomy, duplicated or missing characters)?",
            },
            {
                "type": "score",
                "name": "publishability",
                "instructions": "How publishable is this page as drawn?",
                "levels": [
                    {"label": "publishable", "description": "No defect a reader would notice."},
                    {"label": "minor_flaw", "description": "A small flaw a careful adult might notice; a child would not."},
                    {"label": "serious_defect", "description": "A defect a child would notice as wrong."},
                ],
            },
        ],
    }
    resp = gw.call("POST", "/decisions", body)
    answers = {a.get("name"): a for a in resp.get("answers", [])}
    p_claim = (answers.get("claim_defect_present") or {}).get("probability")
    p_serious = (answers.get("serious_defect_present") or {}).get("probability")
    pub = answers.get("publishability") or {}
    if p_claim is None or p_serious is None:
        raise RuntimeError(f"decisions response missing predicates: {json.dumps(resp)[:200]}")
    gw_cost = ((resp.get("provider_metadata") or {}).get("gateway") or {}).get("cost")
    verdict = {
        "claim_upheld": p_claim >= 0.5,
        "any_serious_defect": p_serious >= 0.5,
        "defects": [],
        "confidence": round(max(p_claim, 1 - p_claim), 3),
        "rationale": (
            f"Luna Decisions: p(claim defect present)={p_claim:.3f}, "
            f"p(any serious defect)={p_serious:.3f}, "
            f"publishability score={pub.get('score')} confidence={pub.get('confidence')}"
            + (f", gateway cost=${gw_cost}" if gw_cost is not None else "")
        ),
    }
    usage = resp.get("usage") or {}
    return verdict, usage.get("input_tokens") or usage.get("prompt_tokens"), usage.get("output_tokens") or usage.get("completion_tokens")


OPUS_MODEL = "anthropic/claude-opus-5.5"


def judge_opus(image_bytes, mime, claim, scores_json):
    """Claude Opus 5.5 via gateway chat completions, JSON verdict.

    Added 2026-11-01 after the cheap judge shootout (judge_shootout.py):
    on 7 human-verified pages Opus was the ONLY judge that separated
    clean from broken (serious-defect gap +0.517; Luna failed through
    both the Decisions and chat routes, Clef-Omni was flat, and the
    Gemini chat route needs its thinking budget zeroed before it can
    even return parseable JSON). Same PROMPT_TEMPLATE and verdict
    shape as the other backends.
    """
    import re as _re
    prompt = PROMPT_TEMPLATE.format(claim=claim, scores=scores_json)
    data_url = f"data:{mime};base64," + base64.b64encode(image_bytes).decode()
    body = {
        "model": OPUS_MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
        "temperature": 0,
        "max_tokens": 600,
    }
    resp = gw.call("POST", "/chat/completions", body)
    text = ((resp.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    m = _re.search(r"\{.*\}", text, _re.S)
    if not m:
        raise RuntimeError(f"opus reply unparseable: {text[:160]!r}")
    verdict = json.loads(m.group(0))
    usage = resp.get("usage") or {}
    return verdict, usage.get("prompt_tokens"), usage.get("completion_tokens")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--ids", type=str, default="")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="re-judge attempts already logged")
    ap.add_argument("--judge", choices=["luna", "gemini", "opus"], default="luna",
                    help="luna: GPT-6 Luna Decisions via the gateway (default). gemini: direct API (billing blocked 2026-11-01). opus: Claude Opus 5.5 via gateway chat (shootout winner 2026-11-01)")
    args = ap.parse_args()

    ids = [i for i in args.ids.split(",") if i.strip()] if args.ids else None
    cands = fetch_candidates(args.limit, ids)
    print(f"appealable candidates: {len(cands)}")
    for r in cands:
        print(f"  id={r['id']} {r['slug']} {r['kind']} {r['chapter']}p{r['page']} a{r['attempt']}: {r['reason']}")
    if args.dry_run:
        return

    judged = skipped = errors = 0
    for r in cands:
        if not args.force and already_judged(r["id"]):
            skipped += 1
            continue
        st, img = audiobook_gen.r2_get(r["image_key"])
        if st != 200:
            print(f"  id={r['id']}: R2 fetch failed ({st}), skipped")
            errors += 1
            continue
        mime = "image/png" if r["image_key"].endswith(".png") else "image/jpeg"
        try:
            if args.judge == "luna":
                v, tok_in, tok_out = judge_luna(img, mime, r["reason"], r.get("scores") or "{}")
                provider, model_name = "vercel-gateway-decisions", LUNA_MODEL
            elif args.judge == "opus":
                v, tok_in, tok_out = judge_opus(img, mime, r["reason"], r.get("scores") or "{}")
                provider, model_name = "vercel-gateway-chat", OPUS_MODEL
            else:
                v, tok_in, tok_out = judge(img, mime, r["reason"], r.get("scores") or "{}")
                provider, model_name = "google-direct", MODEL
        except Exception as e:
            print(f"  id={r['id']}: judge error: {str(e)[:160]}")
            errors += 1
            continue
        verdict = (
            "would_reject" if v.get("claim_upheld") or v.get("any_serious_defect") else "would_accept"
        )
        d1(
            "INSERT INTO qc_second_opinions (attempt_id, slug, kind, chapter, page, attempt, "
            "production_outcome, production_reason, production_scores, judge_provider, judge_model, "
            "verdict, claim_upheld, confidence, defects, rationale, judge_tokens_in, judge_tokens_out, created_at) "
            "VALUES (%d, '%s', '%s', '%s', %d, %d, '%s', '%s', '%s', '%s', '%s', '%s', %d, %s, '%s', '%s', %s, %s, %d)"
            % (
                r["id"],
                r["slug"],
                r["kind"],
                r["chapter"],
                r["page"] if r["page"] is not None else -1,
                r["attempt"],
                r["outcome"],
                (r["reason"] or "").replace("'", "''"),
                (r.get("scores") or "").replace("'", "''"),
                provider,
                model_name,
                verdict,
                1 if v.get("claim_upheld") else 0,
                v.get("confidence") if v.get("confidence") is not None else "NULL",
                json.dumps(v.get("defects") or []).replace("'", "''"),
                (v.get("rationale") or "").replace("'", "''")[:500],
                tok_in if tok_in is not None else "NULL",
                tok_out if tok_out is not None else "NULL",
                int(time.time()),
            )
        )
        judged += 1
        print(
            f"  id={r['id']} {r['chapter']}p{r['page']}: {verdict} "
            f"(claim_upheld={v.get('claim_upheld')}, conf={v.get('confidence')}) {v.get('rationale','')[:110]}"
        )
    print(f"done: judged={judged} skipped_already={skipped} errors={errors}")


if __name__ == "__main__":
    main()
