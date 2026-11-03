#!/usr/bin/env python3
"""Upload one book's audit reports to books/<slug>/audit/ and verify
each by size on read-back. Usage: upload_audit.py <slug>"""
import os
import sys

sys.path.insert(0, "/home/hatch/workspace/kidsbook-video/runner")
import cover  # noqa: E402

slug = sys.argv[1]
base = "/home/hatch/workspace/factory-ops"
for local, remote in (
    (f"cast-audit-{slug}.json", "cast-audit-line.json"),
    (f"cast-audit-{slug}-color.json", "cast-audit-color.json"),
):
    p = os.path.join(base, local)
    if not os.path.exists(p):
        print(slug, remote, "NO LOCAL FILE")
        continue
    data = open(p, "rb").read()
    cover.r2_put(f"books/{slug}/audit/{remote}", data, "application/json")
    back = cover.r2_get(f"books/{slug}/audit/{remote}")
    print(slug, remote, "OK" if back is not None and len(back) == len(data) else "VERIFY FAILED")
