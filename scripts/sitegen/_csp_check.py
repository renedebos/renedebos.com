"""Integrity check: the two Content-Security-Policy definitions must agree.

site_worker.js is the one that takes effect -- secure() calls headers.set()
on every response, which overwrites whatever _headers supplied. That makes
_headers easy to forget, and a stale copy is worse than no copy: two files
would state different security policies for the same site, with the dead one
looking authoritative to the next reader.

Parsed rather than duplicated here on purpose. Hardcoding the expected policy
would just add a third place to forget.
"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _worker_csp():
    """The CSP site_worker.js builds, with its `${...}` constants resolved."""
    src = open(os.path.join(ROOT, "site_worker.js")).read()
    consts = dict(re.findall(r'^const (\w+) = "([^"]*)";', src, re.M))
    block = re.search(r'"Content-Security-Policy":\s*\n(.*?)\n\};', src, re.S)
    if not block:
        return None, "site_worker.js: no Content-Security-Policy entry found"
    parts = re.findall(r'[`"]((?:[^`"\\]|\\.)*)[`"]', block.group(1))
    if not parts:
        return None, "site_worker.js: could not parse the CSP string pieces"
    csp = "".join(parts)

    missing = []

    def resolve(m):
        name = m.group(1)
        if name not in consts:
            missing.append(name)
            return m.group(0)
        return consts[name]

    csp = re.sub(r"\$\{(\w+)\}", resolve, csp)
    if missing:
        return None, f"site_worker.js: unresolved CSP constant(s): {', '.join(missing)}"
    return csp.strip(), None


def _headers_csp():
    for line in open(os.path.join(ROOT, "_headers")):
        if "Content-Security-Policy:" in line:
            return line.split("Content-Security-Policy:", 1)[1].strip(), None
    return None, "_headers: no Content-Security-Policy line found"


def check_csp_in_sync():
    """[] when the two definitions match, else a list of error strings."""
    worker, err1 = _worker_csp()
    headers, err2 = _headers_csp()
    if err1 or err2:
        return [e for e in (err1, err2) if e]
    if worker == headers:
        return []
    return ["site_worker.js and _headers define different CSPs "
            "(site_worker.js is the one that takes effect):",
            f"  site_worker.js: {worker}",
            f"  _headers      : {headers}"]
