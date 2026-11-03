import json, urllib.request

BASE = "https://kidsbook-factory.rocktown-labs.workers.dev"
TOKEN = open("/home/hatch/workspace/night-lab/hidden/api_token.txt").read().strip()

def call(path, body=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method or ("POST" if data else "GET"))
    req.add_header("Authorization", "Bearer " + TOKEN)
    if data: req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "curl/8.0")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode() or "{}")

if __name__ == "__main__":
    import sys
    print(json.dumps(call(sys.argv[1], json.loads(sys.argv[2]) if len(sys.argv) > 2 else None), indent=1))
