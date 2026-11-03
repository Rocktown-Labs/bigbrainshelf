#!/usr/bin/env python3
"""Deploy the kidsbook-factory worker via the Cloudflare API (multipart upload)."""
import json, sys, urllib.request
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request

API_BASE = "https://api.cloudflare.com/client/v4"
ACCOUNT_ID = "5af47adc047fa74dcfa59048858b486c"
SCRIPT_NAME = "kidsbook-factory"
CREDENTIAL = "custom.cloudflare"
ALLOWED_HOSTS = ["api.cloudflare.com"]

with open("/home/hatch/workspace/kidsbook-factory/dist/worker.js", "rb") as f:
    script = f.read()

bindings = [
    {"type": "ai", "name": "AI"},
    {"type": "r2_bucket", "name": "BOOKS", "bucket_name": "kidsbook-factory"},
    {"type": "workflow", "name": "KIDSBOOK_WORKFLOW",
     "workflow_name": "kidsbook", "class_name": "KidsBookWorkflow",
     "script_name": SCRIPT_NAME},
    {"type": "d1", "name": "DB",
     "id": "e1da6223-d7ab-496f-97e8-4c97111e8b8d"},
    {"type": "workflow", "name": "BOOKBUILD_WORKFLOW",
     "workflow_name": "bookbuild", "class_name": "BookBuildWorkflow",
     "script_name": SCRIPT_NAME},
    {"type": "workflow", "name": "REGEN_WORKFLOW",
     "workflow_name": "regen", "class_name": "RegenWorkflow",
     "script_name": SCRIPT_NAME},
    {"type": "workflow", "name": "COLORIZE_WORKFLOW",
     "workflow_name": "colorize", "class_name": "ColorizeWorkflow",
     "script_name": SCRIPT_NAME},
    {"type": "workflow", "name": "REPAIR_WORKFLOW",
     "workflow_name": "repair", "class_name": "RepairWorkflow",
     "script_name": SCRIPT_NAME},
    {"type": "workflow", "name": "REASSEMBLE_WORKFLOW",
     "workflow_name": "reassemble", "class_name": "ReassembleWorkflow",
     "script_name": SCRIPT_NAME},
    {"type": "workflow", "name": "PAGEFIX_WORKFLOW",
     "workflow_name": "pagefix", "class_name": "PageFixWorkflow",
     "script_name": SCRIPT_NAME},
    {"type": "durable_object_namespace", "name": "BUDGET",
     "class_name": "BudgetCoordinator"},
    {"type": "analytics_engine", "name": "METRICS",
     "dataset": "factory_metrics"},
    {"type": "queue", "name": "APPEALS", "queue_name": "factory-appeals"},
]

metadata = {
    "main_module": "worker.js",
    "bindings": bindings,
    # NOTE: queue producers are BINDINGS (see the bindings list); queue
    # consumers attach via the Queues API (POST /accounts/{id}/queues/
    # {queue_id}/consumers), not through script metadata. A top-level
    # "queues" key here is silently ignored (learned 2026-11-01 when the
    # APPEALS producer binding never attached).
    # DO migration tag "v1" (new_sqlite_classes: BudgetCoordinator) was
    # registered on the 2026-11-01 deploy and must NOT be resent: the API
    # rejects a repeat with 10079. A future DO class needs a fresh
    # {"old_tag": "v1", "new_tag": "v2", ...} migrations entry, once.
    "compatibility_date": "2026-10-15",
    "observability": {"enabled": True},
}

boundary = "----kidsbookboundary123"
body = b""
body += f"--{boundary}\r\n".encode()
body += b'Content-Disposition: form-data; name="metadata"\r\n'
body += b"Content-Type: application/json\r\n\r\n"
body += json.dumps(metadata).encode() + b"\r\n"
body += f"--{boundary}\r\n".encode()
body += b'Content-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n'
body += b"Content-Type: application/javascript+module\r\n\r\n"
body += script + b"\r\n"
body += f"--{boundary}--\r\n".encode()

url = f"{API_BASE}/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}"
req = urllib.request.Request(url, data=body, method="PUT")
req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
req.add_header("User-Agent", "curl/8.0")
add_surrogate_to_request(req, CREDENTIAL, entry_name="access_token",
                         allowed_hosts=ALLOWED_HOSTS)
try:
    with urllib.request.urlopen(req, timeout=180) as resp:
        result = json.loads(resp.read())
        print(json.dumps({"success": result.get("success"),
                          "errors": result.get("errors")}, indent=2))
except urllib.request.HTTPError as e:
    print(f"HTTP {e.code}", file=sys.stderr)
    print(e.read().decode()[:3000], file=sys.stderr)
    sys.exit(1)
