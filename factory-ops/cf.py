import sys, json, urllib.request
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
import dynamic_credentials
ACCT = "5af47adc047fa74dcfa59048858b486c"
DB = "e1da6223-d7ab-496f-97e8-4c97111e8b8d"
def call(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json", "User-Agent": "curl/8.0"})
    dynamic_credentials.add_surrogate_to_request(req, "custom.cloudflare",
                                                 entry_name="access_token",
                                                 allowed_hosts=["api.cloudflare.com"])
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return {"http_error": e.code, "body": e.read().decode()[:2000]}
def d1(sql, params=None):
    return call("POST", f"https://api.cloudflare.com/client/v4/accounts/{ACCT}/d1/database/{DB}/query",
                {"sql": sql, "params": params or []})
if __name__ == "__main__":
    print(json.dumps(d1(sys.argv[1], sys.argv[2:]), indent=1)[:6000])
