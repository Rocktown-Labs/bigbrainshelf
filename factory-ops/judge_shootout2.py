#!/usr/bin/env python3
"""Judge shootout round 2 (2026-11-02, CG): Gemini 4 Argon and Alibaba
Qwen3.8 on the Vercel gateway, against the round-1 winner (Opus 5.5)
as control. Same 7 human-verified pages, same rubric, same pass rule
(flag every BROKEN on serious >= 0.5, clear every CLEAN) as
judge_shootout.py. Round-2 harness fixes vs round 1: max_tokens 2000
(Gemini's thinking ate the 300 budget and truncated its JSON) and a
balanced-brace JSON extractor (fenced replies parse). Qwen gets two
seats: qwen3.8-max (the flagship CG named) and qwen3-vl-instruct
(the purpose-built vision line) as insurance.
"""

import base64
import json
import sys

sys.path.insert(0, "/home/hatch/workspace/factory-ops")
sys.path.insert(0, "/home/hatch/workspace/kidsbook-video")
sys.path.insert(0, "/home/hatch/workspace/custom-connectors/custom.vercel-ai-gateway/bin")
import audiobook_gen
import gateway as gw
from judge_shootout import TRUTH, GENERIC_CLAIM, RUBRIC, fetch_row


def extract_verdict(text):
    """Find balanced {...} substrings, last first, return the first
    that parses and carries the three verdict keys."""
    if not text:
        return None
    cands = []
    depth = 0
    start = None
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start is not None:
                cands.append(text[start:i + 1])
                start = None
    for cand in reversed(cands):
        try:
            out = json.loads(cand)
        except Exception:
            continue
        if isinstance(out, dict) and "serious_defect" in out:
            return out
    return None


def chat_judge2(model, img, mime, claim):
    data_url = f"data:{mime};base64," + base64.b64encode(img).decode()
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
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
        "temperature": 0,
        "max_tokens": 2000,
    }
    resp = gw.call("POST", "/chat/completions", body)
    text = ((resp.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    out = extract_verdict(text)
    if out is None:
        raise RuntimeError(f"unparseable: {text[:140]!r}")
    cost = ((resp.get("provider_metadata") or {}).get("gateway") or {}).get("cost")
    usage = resp.get("usage") or {}
    return {
        "claim": float(out.get("claim_defect", -1)),
        "serious": float(out.get("serious_defect", -1)),
        "pub": float(out.get("publishable", -1)),
        "cost": cost,
        "usage": usage,
        "raw": text,
    }


JUDGES = [
    ("opus_chat", "anthropic/claude-opus-5.5"),
    ("gemini4_argon", "google/gemini-4-argon"),
    ("qwen38_max", "alibaba/qwen3.8-max"),
    ("qwen3_vl", "alibaba/qwen3-vl-instruct"),
]


def main():
    results = {name: [] for name, _ in JUDGES}
    raw_shown = set()
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
        print(f"\nid={attempt_id} [{truth}] {row['chapter']}p{row['page']} {row['kind']} claim={claim[:60]!r}")
        for name, model in JUDGES:
            try:
                r = chat_judge2(model, img, mime, claim)
                flag = "FLAG" if r["serious"] >= 0.5 else "pass"
                want = "FLAG" if truth == "BROKEN" else "pass"
                mark = "OK " if flag == want else "XX "
                print(f"  {mark}{name:15s} claim={r['claim']:.3f} serious={r['serious']:.3f} pub={r['pub']:.3f} cost={r['cost']} usage={r['usage']}")
                if name not in raw_shown:
                    raw_shown.add(name)
                    print(f"    first raw reply: {r['raw'][:220]!r}")
                results[name].append((truth, r))
            except Exception as e:
                print(f"  ERR {name:15s} {str(e)[:160]}")
                results[name].append((truth, None))
    print("\n================ SUMMARY (round 2) ================")
    for name, rows in results.items():
        judged = [(t, r) for t, r in rows if r]
        errs = len(rows) - len(judged)
        correct = sum(1 for t, r in judged if (r["serious"] >= 0.5) == (t == "BROKEN"))
        clean_serious = [r["serious"] for t, r in judged if t == "CLEAN"]
        broken_serious = [r["serious"] for t, r in judged if t == "BROKEN"]
        gap = (sum(broken_serious) / len(broken_serious) - sum(clean_serious) / len(clean_serious)) if clean_serious and broken_serious else 0
        costs = [r["cost"] for _, r in judged if isinstance(r.get("cost"), (int, float))]
        verdict = "PASSES" if correct == len(judged) and judged else "fails"
        print(f"{name:15s} {verdict}: {correct}/{len(judged)} correct, errors={errs}, "
              f"serious gap={gap:+.3f}, cost/call={('$%.5f' % (sum(costs) / len(costs))) if costs else 'n/a'}")


if __name__ == "__main__":
    main()
