#!/usr/bin/env python3
"""Deploy the kidsbook-hub Astro worker to Cloudflare via API.

Uploads dist/server modules AND dist/client static assets (Workers Assets
direct-upload flow) so the worker's ASSETS binding exists; without it the
Astro entry throws on every asset/404 request (favicon, /_astro/*.css, ...).
"""
import base64, glob, hashlib, json, mimetypes, os, subprocess, sys, urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request

ACCT = "5af47adc047fa74dcfa59048858b486c"
WORKER = "bigbrainshelf"
BASE = "/home/hatch/workspace/kidsbook-hub"
# Files the Astro adapter lists in dist/client/.assetsignore; never assets.
ASSET_IGNORE = {".assetsignore", "_worker.js", "_routes.json", "wrangler.json", ".dev.vars"}

def api(method, path, body=None, headers=None, surrogate=True):
    url = f"https://api.cloudflare.com/client/v4/accounts/{ACCT}{path}"
    data = body if isinstance(body, bytes) else (json.dumps(body).encode() if body else None)
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", "curl/8.0")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    if data and "Content-Type" not in (headers or {}):
        req.add_header("Content-Type", "application/json")
    if surrogate:
        add_surrogate_to_request(req, "custom.cloudflare", entry_name="access_token",
                                 allowed_hosts=["api.cloudflare.com"])
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())

# ---- Stage 1: register the asset manifest, upload any new/changed files ----
manifest, files = {}, {}
for path in glob.glob(f"{BASE}/dist/client/**/*", recursive=True):
    if not os.path.isfile(path):
        continue
    rel = os.path.relpath(path, f"{BASE}/dist/client").replace(os.sep, "/")
    if rel in ASSET_IGNORE:
        continue
    raw = open(path, "rb").read()
    ext = os.path.splitext(rel)[1].lstrip(".")
    # Hash per Cloudflare's direct-upload spec: sha256(base64(bytes) + ext), first 32 hex chars.
    h = hashlib.sha256((base64.b64encode(raw).decode() + ext).encode()).hexdigest()[:32]
    manifest["/" + rel] = {"hash": h, "size": len(raw)}
    files[h] = (rel, raw, mimetypes.guess_type(rel)[0] or "application/octet-stream")
print(f"assets: {len(manifest)} files")

sess = api("POST", f"/workers/scripts/{WORKER}/assets-upload-session", {"manifest": manifest})
if not sess.get("success"):
    sys.exit(f"assets-upload-session failed: {sess.get('errors')}")
upload_jwt = sess["result"]["jwt"]
buckets = sess["result"].get("buckets") or []
completion_jwt = upload_jwt  # used directly when nothing needs uploading

for bucket in buckets:
    boundary = "----hubassets456"
    parts = []
    for h in bucket:
        rel, raw, mime = files[h]
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{h}\"\r\nContent-Type: {mime}\r\n\r\n".encode()
                     + base64.b64encode(raw) + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    # This endpoint authenticates with the upload-session JWT, not the account credential.
    resp = api("POST", "/workers/assets/upload?base64=true", body=b"".join(parts),
               headers={"Authorization": f"Bearer {upload_jwt}",
                        "Content-Type": f"multipart/form-data; boundary={boundary}"},
               surrogate=False)
    if resp.get("result", {}).get("jwt"):
        completion_jwt = resp["result"]["jwt"]
print(f"assets uploaded: {sum(len(b) for b in buckets)} file(s) in {len(buckets)} bucket(s)")

# ---- Stage 1.5: wrap the Astro entry with the scheduled handler ----
# Book Club V2: bundles src/worker/scheduler.ts to dist/server/
# club-scheduler.mjs and writes dist/server/worker.mjs (fetch = Astro,
# scheduled = outbox flush + club cycle pass). Without this the worker
# has no cron handler at all.
prep = subprocess.run(["bun", f"{BASE}/scripts/prepare-worker-entry.mjs"], cwd=BASE,
                      capture_output=True, text=True)
if prep.returncode != 0:
    sys.exit(f"prepare-worker-entry failed:\n{prep.stdout}\n{prep.stderr}")
print(prep.stdout.strip())

# ---- Stage 2: upload the worker modules with the assets attached ----
modules = {}
for path in glob.glob(f"{BASE}/dist/server/**/*.mjs", recursive=True):
    rel = os.path.relpath(path, f"{BASE}/dist/server")
    modules[rel] = open(path).read()
print(f"modules: {len(modules)} ({sum(len(c) for c in modules.values())} bytes total)")

boundary = "----hubdeploy123"
parts = []
metadata = {
    "main_module": "worker.mjs",
    # run_worker_first: static files are normally served by the Assets
    # platform before the worker runs (with max-age=0 headers and no
    # respect for the dist _headers in this raw-API flow). Routing the
    # content-hashed /_astro/* bundles and the stable brand assets
    # through the worker lets src/worker entry wrapper stamp their
    # long-lived Cache-Control (see scripts/prepare-worker-entry.mjs).
    "assets": {"jwt": completion_jwt, "config": {"run_worker_first": [
        "/_astro/*",
        "/favicon.ico", "/favicon.svg", "/favicon-16.png", "/favicon-32.png", "/favicon-48.png",
        "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png",
        "/logo-stacked.png", "/logo-stacked.svg", "/og-image.jpg", "/site.webmanifest",
    ]}},
    "bindings": [
        {"type": "d1", "name": "DB", "id": "e1da6223-d7ab-496f-97e8-4c97111e8b8d"},
        {"type": "r2_bucket", "name": "BOOKS", "bucket_name": "kidsbook-factory"},
        {"type": "assets", "name": "ASSETS"},
        {"type": "ai", "name": "AI"},
        {"type": "send_email", "name": "EMAIL"},
    ],
    "compatibility_date": "2026-10-16",
    "compatibility_flags": ["nodejs_als"],
}
parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n{json.dumps(metadata)}\r\n".encode())
for rel, content in sorted(modules.items()):
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{rel}\"; filename=\"{rel}\"\r\nContent-Type: application/javascript+module\r\n\r\n".encode() + content.encode() + b"\r\n")
parts.append(f"--{boundary}--\r\n".encode())

d = api("PUT", f"/workers/scripts/{WORKER}",
        body=b"".join(parts),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
print("deploy:", "success" if d.get("success") else d.get("errors"))
if not d.get("success"):
    sys.exit("worker upload failed; schedules not touched")

# ---- Stage 3: (re)register the cron schedules and verify them ----
# Book Club V2 scheduler: every 15 minutes. The script-upload PUT does
# NOT carry cron triggers, and a deploy without them does not clear
# existing ones either, so registration is explicit here: PUT the bare
# schedules array, then GET it back and fail the deploy loudly if the
# live worker does not show the trigger.
CRONS = [{"cron": "*/15 * * * *"}]
s = api("PUT", f"/workers/scripts/{WORKER}/schedules", body=CRONS)
if not s.get("success"):
    sys.exit(f"schedules PUT failed: {s.get('errors')}")
check = api("GET", f"/workers/scripts/{WORKER}/schedules")
result = check.get("result") or {}
rows = result.get("schedules") if isinstance(result, dict) else result
live_crons = [row.get("cron") for row in (rows or [])]
print("schedules live:", live_crons)
if [c.get("cron") for c in CRONS] != live_crons:
    sys.exit(f"schedules verification failed: expected {[c.get('cron') for c in CRONS]}, live shows {live_crons}")
