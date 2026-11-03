#!/usr/bin/env python3
"""Minimal Doop MCP client (streamable HTTP).

Reads the API key from the DOOP_KEY environment variable only. The key is
never written to disk by this script. Usage:

    DOOP_KEY=... python3 doop_mcp.py <command> [args]

Commands:
    tools                      list tool names
    call <tool> <json-args>    call a tool with a JSON args object
    script <file>              run a JSON list of {"tool":..., "args": {...}}
                               calls in one session, printing each result
"""
import json
import os
import sys
import urllib.request
import urllib.error

ENDPOINT = "https://doop.design/mcp"


class Doop:
    def __init__(self, key):
        self.key = key
        self.session = None
        self._id = 0

    def _post(self, payload, want_response=True):
        body = json.dumps(payload).encode()
        req = urllib.request.Request(ENDPOINT, data=body, method="POST")
        req.add_header("Authorization", f"Bearer {self.key}")
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "application/json, text/event-stream")
        req.add_header("User-Agent", "curl/8.0")
        if self.session:
            req.add_header("Mcp-Session-Id", self.session)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                sid = resp.headers.get("Mcp-Session-Id")
                if sid:
                    self.session = sid
                raw = resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            raise RuntimeError(f"HTTP {e.code}: {raw[:600]}")
        if not want_response:
            return None
        return parse_rpc(raw)

    def request(self, method, params=None):
        self._id += 1
        return self._post({"jsonrpc": "2.0", "id": self._id, "method": method,
                           "params": params or {}})

    def notify(self, method, params=None):
        self._post({"jsonrpc": "2.0", "method": method, "params": params or {}},
                   want_response=False)

    def connect(self):
        res = self.request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "RGM", "version": "1.0"},
        })
        self.notify("notifications/initialized")
        return res

    def call(self, tool, args):
        return self.request("tools/call", {"name": tool, "arguments": args})


def parse_rpc(raw):
    raw = raw.strip()
    if not raw:
        return None
    if raw.startswith("{"):
        return json.loads(raw)
    out = None
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            data = line[5:].strip()
            if data and data != "[DONE]":
                out = json.loads(data)
    return out


def text_of(result):
    if not result:
        return "(no result)"
    if "error" in result:
        return "ERROR: " + json.dumps(result["error"])[:800]
    res = result.get("result", {})
    parts = []
    for c in res.get("content", []):
        if c.get("type") == "text":
            parts.append(c["text"])
        else:
            parts.append(f"[{c.get('type')}]")
    return "\n".join(parts) if parts else json.dumps(res)[:800]


def main():
    key = os.environ.get("DOOP_KEY")
    if not key:
        print("DOOP_KEY not set", file=sys.stderr)
        return 1
    cmd = sys.argv[1] if len(sys.argv) > 1 else "tools"
    d = Doop(key)
    d.connect()
    if cmd == "tools":
        res = d.request("tools/list")
        tools = res.get("result", {}).get("tools", [])
        for t in tools:
            print(t["name"])
        print(f"({len(tools)} tools)", file=sys.stderr)
    elif cmd == "call":
        tool = sys.argv[2]
        args = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
        print(text_of(d.call(tool, args)))
    elif cmd == "script":
        calls = json.load(open(sys.argv[2]))
        for i, c in enumerate(calls):
            out = text_of(d.call(c["tool"], c.get("args", {})))
            print(f"--- [{i}] {c['tool']}: {out[:1500]}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
