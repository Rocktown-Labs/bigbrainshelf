#!/usr/bin/env python3
"""Cheap judge shootout (2026-11-01, CG: "try cheap calls to see who passes").

Ground truth, human-anchored:
  CLEAN  = attempt 2 (S6p1 colorize, CG eye-verified clean), 7, 32, 36
           (accepted colorize rolls that shipped in the finished book)
  BROKEN = attempt 37 (S3p0 colorize, CG-verified hand-feet), 5 (S3p0
           colorize a0, painted from the same broken line art), 11
           (S6p3 colorize, hand-wing per the 2026-11-01 census)

Judges under test, same rubric and questions on every route:
  luna_decisions  GPT-6 Luna via gateway Decisions (the current wiring)
  luna_chat       GPT-6 Luna via gateway chat completions, JSON verdict
  gemini_chat     Gemini 3.8 Flash via gateway chat, JSON verdict
  opus_chat       Claude Opus 5.5 via gateway chat, JSON verdict
  clef_omni       Clef-Omni on Workers AI, noul questions (queue judge)

A judge PASSES if it flags every BROKEN page (serious >= 0.5) and
clears every CLEAN page (serious < 0.5). Publishability gap and cost
per call break ties. One raw Decisions response is dumped to
judge_shootout_raw_decisions.json for the parsing audit.
"""

import base64
import json
import re
import sys
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
sys.path.insert(0, "/home/hatch/workspace/factory-ops")
sys.path.insert(0, "/home/hatch/workspace/kidsbook-video")
sys.path.insert(0, "/home/hatch/workspace/custom-connectors/custom.vercel-ai-gateway/bin")
from dynamic_credentials import add_surrogate_to_request
from cf import d1
import audiobook_gen
import gateway as gw

TRUTH = {2: "CLEAN", 7: "CLEAN", 32: "CLEAN", 36: "CLEAN",
         37: "BROKEN", 5: "BROKEN", 11: "BROKEN"}
GENERIC_CLAIM = "the page was flagged for a possible anatomy or duplicate-character defect"

RUBRIC = (
    "You are an appeals judge for a children's picture book factory. A first QC system "
    "rejected the attached page illustration (for accepted pages, treat this as a spot check). "
    "Judge ONLY what is actually drawn. Reflections and shadows of a character are part of that "
    "character, not a second character. Two animals of the same species can be two different "
    "characters: look for distinguishing features (crest, scarf, hat, size, posture) before "
    "calling a duplicate. Anatomy is defective only if a body part is clearly wrong: a hand or "
    "human foot shape where a wing, fin, or animal foot belongs, extra or missing limbs, limbs "
    "attached to the wrong body part. Normal stylized animal anatomy in a children's book is "
    "NOT defective."
)


def fetch_row(attempt_id):
    r = d1("SELECT * FROM gen_attempts WHERE id=%d" % attempt_id)
    rows = ((r.get("result") or [{}])[0].get("results") or [])
    return rows[0] if rows else None


def data_url(img, mime):
    return f"data:{mime};base64," + base64.b64encode(img).decode()


def parse_json_loose(text):
    if not text:
        return None
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


def chat_judge(model, img, mime, claim):
    body = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": (
                        RUBRIC + f"\nThe rejection claim was: \"{claim}\"\n"
                        "Return ONLY a JSON object with three probabilities from 0 to 1: "
                        "{\"claim_defect\": <the claimed defect is truly present>, "
                        "\"serious_defect\": <any defect that should block publication>, "
                        "\"publishable\": <the page is publishable as-is>}")},
                    {"type": "image_url", "image_url": {"url": data_url(img, mime)}},
                ],
            }
        ],
        "max_tokens": 300,
    }
    resp = gw.call("POST", "/chat/completions", body)
    text = ((resp.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    out = parse_json_loose(text)
    if out is None:
        raise RuntimeError(f"unparseable chat reply: {text[:120]!r}")
    cost = ((resp.get("provider_metadata") or {}).get("gateway") or {}).get("cost")
    return {
        "claim": float(out.get("claim_defect", -1)),
        "serious": float(out.get("serious_defect", -1)),
        "pub": float(out.get("publishable", -1)),
        "cost": cost,
    }


def decisions_judge(img, mime, claim, scores_json, dump=False):
    evidence = json.dumps({"rejection_claim": claim, "production_scores": scores_json})
    body = {
        "model": "openai/gpt-6-luna-decisions",
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": RUBRIC + f" The rejection evidence is: {evidence}"},
                    {"type": "input_image", "image_url": data_url(img, mime)},
                ],
            }
        ],
        "questions": [
            {"type": "predicate", "name": "claim_defect_present",
             "instructions": "Is the defect described in the rejection_claim actually present in this image?"},
            {"type": "predicate", "name": "serious_defect_present",
             "instructions": "Does this image have ANY defect serious enough to block it from a published children's book, including defects the claim did not name (drawn text, humans, broken anatomy, duplicated or missing characters)?"},
            {"type": "score", "name": "publishability",
             "instructions": "How publishable is this page as drawn?",
             "levels": [
                 {"label": "publishable", "description": "No defect a reader would notice."},
                 {"label": "minor_flaw", "description": "A small flaw a careful adult might notice; a child would not."},
                 {"label": "serious_defect", "description": "A defect a child would notice as wrong."},
             ]},
        ],
    }
    resp = gw.call("POST", "/decisions", body)
    if dump:
        with open("/home/hatch/workspace/factory-ops/judge_shootout_raw_decisions.json", "w") as f:
            json.dump(resp, f, indent=1)
    answers = {a.get("name"): a for a in resp.get("answers", [])}
    p_claim = (answers.get("claim_defect_present") or {}).get("probability")
    p_serious = (answers.get("serious_defect_present") or {}).get("probability")
    pub_raw = (answers.get("publishability") or {}).get("score")
    cost = ((resp.get("provider_metadata") or {}).get("gateway") or {}).get("cost")
    return {
        "claim": p_claim if p_claim is not None else -1,
        "serious": p_serious if p_serious is not None else -1,
        # score is an expected level index on 0..2; normalize to 0..1 publishable
        "pub": (1 - pub_raw / 2) if isinstance(pub_raw, (int, float)) else -1,
        "pub_raw": pub_raw,
        "cost": cost,
    }


def omni_judge(img, mime, claim):
    questions = {
        "claim_defect_present": {
            "type": "noul",
            "instructions": f"The first QC system rejected this page claiming: \"{claim[:300]}\". Is that specific claimed defect truly present in this image?",
        },
        "serious_defect_present": {
            "type": "noul",
            "instructions": "Does this image have ANY defect that should block it from a published children's book, including defects the claim did not name?",
        },
        "publishable_as_is": {
            "type": "noul",
            "instructions": "Could this page be published as-is in a children's picture book without a child or parent noticing anything wrong?",
        },
    }
    body = {
        "model": "clef-omni",
        "state": RUBRIC,
        "questions": questions,
        "images": [{"content_type": mime, "base64": base64.b64encode(img).decode()}],
    }
    req = urllib.request.Request(
        "https://api.cloudflare.com/client/v4/accounts/5af47adc047fa74dcfa59048858b486c/ai/run/@cf/cloudflare/clef-omni",
        data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "curl/8.0")
    add_surrogate_to_request(req, "custom.cloudflare", entry_name="access_token", allowed_hosts=["api.cloudflare.com"])
    with urllib.request.urlopen(req, timeout=120) as r:
        out = json.loads(r.read())
    a = (out.get("result") or {}).get("answers") or {}
    return {
        "claim": (a.get("claim_defect_present") or {}).get("noul", -1),
        "serious": (a.get("serious_defect_present") or {}).get("noul", -1),
        "pub": (a.get("publishable_as_is") or {}).get("noul", -1),
        "cost": None,  # Workers AI neurons, unpriced
    }


JUDGES = [
    ("luna_decisions", lambda img, mime, claim, scores: decisions_judge(img, mime, claim, scores)),
    ("luna_chat", lambda img, mime, claim, scores: chat_judge("openai/gpt-6-luna", img, mime, claim)),
    ("gemini_chat", lambda img, mime, claim, scores: chat_judge("google/gemini-3.8-flash", img, mime, claim)),
    ("opus_chat", lambda img, mime, claim, scores: chat_judge("anthropic/claude-opus-5.5", img, mime, claim)),
    ("clef_omni", lambda img, mime, claim, scores: omni_judge(img, mime, claim)),
]


def main():
    results = {name: [] for name, _ in JUDGES}
    dumped = False
    for attempt_id, truth in TRUTH.items():
        row = fetch_row(attempt_id)
        if not row:
            print(f"id={attempt_id}: row missing")
            continue
        st, img = audiobook_gen.r2_get(row["image_key"])
        if st != 200:
            print(f"id={attempt_id}: R2 fetch failed ({st})")
            continue
        mime = "image/png" if row["image_key"].endswith(".png") else "image/jpeg"
        claim = row.get("reason") or GENERIC_CLAIM
        label = f"{row['chapter']}p{row['page']} {row['kind']}"
        print(f"\nid={attempt_id} [{truth}] {label} claim={claim[:60]!r}")
        for name, fn in JUDGES:
            try:
                if name == "luna_decisions" and not dumped:
                    r = decisions_judge(img, mime, claim, row.get("scores"), dump=True)
                    dumped = True
                else:
                    r = fn(img, mime, claim, row.get("scores"))
                flag = "FLAG" if r["serious"] >= 0.5 else "pass"
                want = "FLAG" if truth == "BROKEN" else "pass"
                mark = "OK " if flag == want else "XX "
                print(f"  {mark}{name:15s} claim={r['claim']:.3f} serious={r['serious']:.3f} pub={r['pub']:.3f} cost={r['cost']}")
                results[name].append((truth, r))
            except Exception as e:
                print(f"  ERR {name:15s} {str(e)[:140]}")
                results[name].append((truth, None))
    print("\n================ SUMMARY ================")
    for name, rows in results.items():
        judged = [(t, r) for t, r in rows if r]
        errs = len(rows) - len(judged)
        correct = sum(1 for t, r in judged if (r["serious"] >= 0.5) == (t == "BROKEN"))
        clean_serious = [r["serious"] for t, r in judged if t == "CLEAN"]
        broken_serious = [r["serious"] for t, r in judged if t == "BROKEN"]
        clean_pub = [r["pub"] for t, r in judged if t == "CLEAN" and r["pub"] >= 0]
        broken_pub = [r["pub"] for t, r in judged if t == "BROKEN" and r["pub"] >= 0]
        costs = [r["cost"] for _, r in judged if isinstance(r.get("cost"), (int, float))]
        gap = (sum(broken_serious) / len(broken_serious) - sum(clean_serious) / len(clean_serious)) if clean_serious and broken_serious else 0
        pubgap = (sum(clean_pub) / len(clean_pub) - sum(broken_pub) / len(broken_pub)) if clean_pub and broken_pub else 0
        verdict = "PASSES" if correct == len(judged) and judged else "fails"
        print(f"{name:15s} {verdict}: {correct}/{len(judged)} correct, errors={errs}, "
              f"serious gap={gap:+.3f}, pub gap={pubgap:+.3f}, "
              f"cost/call={('$%.5f' % (sum(costs) / len(costs))) if costs else 'n/a'}")


if __name__ == "__main__":
    main()
