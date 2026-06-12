#!/usr/bin/env python3
# This file is part of Supysonic.
# Distributed under terms of the GNU AGPLv3 license.

"""Turn a browser HAR capture of the Deezer web app into an API catalog.

Capture a .har while using every Deezer feature you care about, then:

    python tools/deezer_explore/har_to_catalog.py capture.har

It writes, next to the HAR:
  * catalog.json  — machine-readable map of every Deezer API call
  * catalog.md    — readable summary (one entry per unique method/endpoint)

Covers the private gateway (gw-light.php), the public API (api.deezer.com) and
the GraphQL pipe (pipe.deezer.com). Tokens/cookies are redacted from samples.

HAR files contain your session tokens — keep them local (they're gitignored).
"""

from __future__ import annotations

import base64
import json
import re
import sys
from collections import OrderedDict
from urllib.parse import urlparse, parse_qs

# Keys whose values must never be written to the catalog.
_SECRET_KEYS = re.compile(
    r"(token|arl|sid|jwt|password|secret|license|authorization|cookie|hmac|"
    r"api_key|access_token)",
    re.I,
)
_NUM_SEG = re.compile(r"^\d+$")


def _redact(obj, depth=0):
    """Recursively redact secret-looking values and truncate big structures."""
    if depth > 4:
        return "…"
    if isinstance(obj, dict):
        out = {}
        for k, v in list(obj.items())[:40]:
            if _SECRET_KEYS.search(str(k)):
                out[k] = "<redacted>"
            else:
                out[k] = _redact(v, depth + 1)
        return out
    if isinstance(obj, list):
        return [_redact(x, depth + 1) for x in obj[:3]]
    if isinstance(obj, str):
        return obj[:200]
    return obj


def _shape(obj, depth=0):
    """A compact description of a response's structure (keys, not values)."""
    if depth > 3:
        return "…"
    if isinstance(obj, dict):
        return {k: _shape(v, depth + 1) for k, v in list(obj.items())[:40]}
    if isinstance(obj, list):
        return [_shape(obj[0], depth + 1)] if obj else []
    return type(obj).__name__


def _body_json(content):
    if not content:
        return None
    text = content.get("text")
    if text is None:
        return None
    if content.get("encoding") == "base64":
        try:
            text = base64.b64decode(text).decode("utf-8", "replace")
        except Exception:
            return None
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return None


def _classify(entry):
    """Return (host_group, method_key, request_payload) for a Deezer call, or None."""
    req = entry.get("request", {})
    url = req.get("url", "")
    host = urlparse(url).hostname or ""
    path = urlparse(url).path or ""
    qs = parse_qs(urlparse(url).query)

    # request payload (POST body) as parsed JSON if any
    post = req.get("postData", {})
    payload = _body_json(post) if post else None
    if payload is None and post.get("text"):
        try:
            payload = json.loads(post["text"])
        except Exception:
            payload = post.get("text")[:200]

    if "gw-light.php" in path:
        method = (qs.get("method") or ["?"])[0]
        return "gateway (gw-light.php)", method, payload

    if host.endswith("api.deezer.com"):
        # normalize numeric ids: /artist/27/related -> /artist/{id}/related
        norm = "/".join("{id}" if _NUM_SEG.match(s) else s for s in path.split("/"))
        return "public api (api.deezer.com)", f"{req.get('method','GET')} {norm}", payload

    if host.startswith("pipe.") or "graphql" in path.lower():
        op = None
        if isinstance(payload, dict):
            op = payload.get("operationName") or (payload.get("query") or "")[:60]
        return "graphql (pipe.deezer.com)", op or "<graphql>", payload

    return None


def main(har_path):
    with open(har_path, encoding="utf-8") as fh:
        har = json.load(fh)

    catalog = OrderedDict()  # (group, method) -> info
    for entry in har.get("log", {}).get("entries", []):
        cl = _classify(entry)
        if not cl:
            continue
        group, method, payload = cl
        key = (group, method)
        info = catalog.setdefault(
            key,
            {"group": group, "method": method, "count": 0, "request": None, "response": None},
        )
        info["count"] += 1
        if info["request"] is None and payload not in (None, {}, ""):
            info["request"] = _redact(payload)
        if info["response"] is None:
            resp = _body_json(entry.get("response", {}).get("content", {}))
            if resp is not None:
                # gateway wraps the useful data in "results"
                results = resp.get("results") if isinstance(resp, dict) else None
                info["response"] = _shape(results if results is not None else resp)

    items = sorted(catalog.values(), key=lambda i: (i["group"], i["method"]))

    base = re.sub(r"\.har$", "", har_path)
    with open(base + ".catalog.json", "w", encoding="utf-8") as fh:
        json.dump(items, fh, indent=2, ensure_ascii=False)

    lines = [f"# Deezer API catalog ({len(items)} unique calls)\n"]
    current = None
    for it in items:
        if it["group"] != current:
            current = it["group"]
            lines.append(f"\n## {current}\n")
        lines.append(f"### `{it['method']}`  ×{it['count']}")
        if it["request"]:
            lines.append("request:\n```json\n" + json.dumps(it["request"], indent=2, ensure_ascii=False)[:800] + "\n```")
        if it["response"]:
            lines.append("response shape:\n```json\n" + json.dumps(it["response"], indent=2, ensure_ascii=False)[:1500] + "\n```")
        lines.append("")
    with open(base + ".catalog.md", "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))

    print(f"{len(items)} unique Deezer calls found.")
    print(f"Wrote {base}.catalog.json and {base}.catalog.md")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: har_to_catalog.py <capture.har>", file=sys.stderr)
        sys.exit(2)
    main(sys.argv[1])
