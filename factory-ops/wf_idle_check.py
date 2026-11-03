#!/usr/bin/env python3
"""List recent kidsbook-factory workflow instances and flag any
that are still active (queued/running/waiting). Exit 1 if busy.
Usage: python3 wf_idle_check.py [workflow ...]"""
import sys, json, urllib.request, urllib.error
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request

ACCT = "5af47adc047fa74dcfa59048858b486c"
WORKFLOWS = ["kidsbook", "bookbuild", "regen", "colorize", "repair", "reassemble"]
ACTIVE = {"queued", "running", "waiting", "waitingForPause", "paused"}

def get(url):
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": "curl/8.0"})
    add_surrogate_to_request(req, "custom.cloudflare", entry_name="access_token",
                             allowed_hosts=["api.cloudflare.com"])
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

busy = False
for wf in (sys.argv[1:] or WORKFLOWS):
    try:
        out = get(f"https://api.cloudflare.com/client/v4/accounts/{ACCT}/workflows/{wf}/instances?per_page=5")
        rows = out.get("result") or []
        if isinstance(rows, dict):
            rows = rows.get("result", [])
        for inst in rows[:5]:
            status = inst.get("status")
            print(f"{wf}: {inst.get('id')} status={status} modified={inst.get('modified_on')}")
            if status in ACTIVE:
                busy = True
        if not rows:
            print(f"{wf}: no instances")
    except urllib.error.HTTPError as e:
        print(f"{wf}: HTTP {e.code}")
print("BUSY" if busy else "IDLE")
sys.exit(1 if busy else 0)
