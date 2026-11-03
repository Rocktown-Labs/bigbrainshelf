import sys, json, urllib.request, urllib.error
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request
ACCT = "5af47adc047fa74dcfa59048858b486c"
wf, iid = sys.argv[1], sys.argv[2]
req = urllib.request.Request(f"https://api.cloudflare.com/client/v4/accounts/{ACCT}/workflows/{wf}/instances/{iid}",
                             method="GET", headers={"User-Agent": "curl/8.0"})
add_surrogate_to_request(req, "custom.cloudflare", entry_name="access_token", allowed_hosts=["api.cloudflare.com"])
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        out = json.loads(r.read())
        print((out.get("result") or {}).get("status"))
except urllib.error.HTTPError as e:
    print("HTTP", e.code)
