#!/usr/bin/env python3
"""Offline evaluation of the cast-listing judge (ai.ts judgeCastListing).

Runs the judge's exact prompt against pages whose ground truth was
established by the 2026-10-26 full visual verification, and scores
whether the returned listing exposes the confirmed defect (or stays
clean on confirmed-clean pages). Decides whether the judge earns a
gate seat next to Clef or stays advisory.

Auth: the stored custom.gemini credential via the surrogate helper,
same as bin/gemini_api.py. No raw key is printed or persisted.
"""

import base64
import json
import sys
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

MODEL = "gemini-3.8-flash"
BASE = "https://generativelanguage.googleapis.com/v1beta"

# Verbatim copy of CAST_LISTING_PROMPT in kidsbook-factory/src/ai.ts.
PROMPT = (
    "Look at this children's book page and report ONLY what is drawn. "
    "Answer with a single JSON object, no prose, with exactly these fields: "
    '{"animals": [{"species": "<plain animal kind, e.g. swift, stork, pigeon, fox>", "count": <how many of that kind are drawn>}], '
    '"humans_or_humanoids": <number of human people, human children, or human-like figures>, '
    '"text_visible": <true if any letters, words, numbers, signs, or labels are drawn anywhere>, '
    '"text_found": "<the letters or words you can read, or empty string>", '
    '"single_scene": <true if this is one scene in one place, false if it is a character sheet, model sheet, or collage of separate poses>, '
    '"same_pose_repeated": <true if the exact same figure drawing appears more than once, copied>}. '
    "Count reflections in water or mirrors as part of the same animal, not a second animal. "
    "Count shadows as part of the same animal too. If a kind of animal is not drawn, do not list it."
)

OPS = "/home/hatch/workspace/factory-ops"
JUNO = f"{OPS}/juno-pages"


def count_of(listing, *kinds):
    total = 0
    for a in listing.get("animals", []):
        sp = str(a.get("species", "")).lower()
        if any(k in sp or sp in k for k in kinds):
            total += int(a.get("count") or 0)
    return total


# (label, file, check(listing) -> (passed, what we looked for))
CASES = [
    ("Juno S4p1 two crested Pells", f"{JUNO}/S4-page-1.jpg",
     lambda L: (count_of(L, "pigeon") >= 2, "pigeon count >= 2")),
    ("Juno S5p2 Pell twice", f"{JUNO}/S5-page-2.jpg",
     lambda L: (count_of(L, "pigeon") >= 2, "pigeon count >= 2")),
    ("Juno S7 finale baked sign text", f"{JUNO}/S7-finale.jpg",
     lambda L: (L.get("text_visible") is True, "text_visible true")),
    ("Juno S9 finale human child, no bird", f"{JUNO}/S9-finale.jpg",
     lambda L: (int(L.get("humans_or_humanoids") or 0) >= 1, "humans >= 1")),
    ("Juno S1p0 no swift (pigeon only)", f"{JUNO}/S1-page-0.jpg",
     lambda L: (count_of(L, "swift") == 0, "swift count == 0")),
    ("Juno S9p0 architecture, no cast", f"{JUNO}/S9-page-0.jpg",
     lambda L: (sum(int(a.get("count") or 0) for a in L.get("animals", [])) == 0, "no animals at all")),
    ("Basil S2p2 three Adas (pose sheet)", f"{OPS}/basil-bell-page3-three-adas.jpg",
     lambda L: (count_of(L, "otter") >= 3 or L.get("single_scene") is False, "otter >= 3 or not single scene")),
    ("Juno S6p0 gold key (clean cast)", f"{OPS}/measure/motivationmanifesto-S6-page-0.jpg",
     lambda L: (int(L.get("humans_or_humanoids") or 0) == 0 and L.get("text_visible") is not True, "no humans, no text")),
    ("Mira S1p2 clean", f"{OPS}/verify-mastery/S1p2.jpg",
     lambda L: (int(L.get("humans_or_humanoids") or 0) == 0 and L.get("single_scene") is True, "no humans, single scene")),
    ("Mira S2p1 clean", f"{OPS}/verify-mastery/S2p1.jpg",
     lambda L: (int(L.get("humans_or_humanoids") or 0) == 0 and L.get("single_scene") is True, "no humans, single scene")),
    ("Fern line S1p0 clean", f"{OPS}/measure2/fern-line-S1-page-0.jpg",
     lambda L: (count_of(L, "fox") == 1 and int(L.get("humans_or_humanoids") or 0) == 0, "exactly one fox, no humans")),
]


def judge(path):
    with open(path, "rb") as f:
        data = f.read()
    mime = "image/png" if data[:2] == b"\x89P" else "image/jpeg"
    body = {
        "contents": [
            {
                "parts": [
                    {"inline_data": {"mime_type": mime, "data": base64.b64encode(data).decode()}},
                    {"text": PROMPT},
                ]
            }
        ],
        "generationConfig": {
            "maxOutputTokens": 1024,
            "temperature": 0,
            "thinkingConfig": {"thinkingBudget": 0},
        },
    }
    req = urllib.request.Request(
        f"{BASE}/models/{MODEL}:generateContent",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "curl/8.0"},
        method="POST",
    )
    add_surrogate_to_request(req, "custom.gemini", allowed_hosts=["generativelanguage.googleapis.com"])
    resp = urllib.request.urlopen(req, timeout=180)
    result = read_json_response(resp)
    text = "".join(
        p.get("text", "")
        for p in result.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    )
    start, end = text.find("{"), text.rfind("}")
    if start < 0:
        return None, text[:200]
    return json.loads(text[start : end + 1]), None


def main():
    passed = 0
    for label, path, check in CASES:
        try:
            listing, err = judge(path)
        except Exception as e:  # noqa: BLE001
            print(f"ERROR  {label}: {e}")
            continue
        if listing is None:
            print(f"NOJSON {label}: {err}")
            continue
        ok, want = check(listing)
        passed += ok
        print(f"{'PASS' if ok else 'FAIL'}  {label}  (want: {want})")
        print(f"      listing: {json.dumps(listing)}")
    print(f"\n{passed}/{len(CASES)} checks passed")


if __name__ == "__main__":
    main()
