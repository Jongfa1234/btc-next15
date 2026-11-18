#!/usr/bin/env python3
"""Recompute the sha256 hashes of index.html's inline scripts in its Content-Security-Policy.
Run after any change to a <script> block, or the browser will refuse to run it."""
import base64, hashlib, re, sys
p = sys.argv[1] if len(sys.argv) > 1 else "index.html"
s = open(p, encoding="utf-8").read()
bodies = re.findall(r"<script(?: id=\"model\")?>([\s\S]*?)</script>", s)
hashes = " ".join("'sha256-%s'" % base64.b64encode(hashlib.sha256(b.encode()).digest()).decode() for b in bodies)
s, n = re.subn(r"script-src [^;]*;", "script-src %s;" % hashes, s, count=1)
if n != 1: sys.exit("No script-src found in the CSP meta tag")
open(p, "w", encoding="utf-8").write(s)
print("Updated %d script hashes" % len(bodies))
