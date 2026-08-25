#!/usr/bin/env python3
"""Tiny uiautomator helper: dump the screen, find nodes by text, tap them."""
import re, subprocess, sys, time, xml.etree.ElementTree as ET

ADB = "/Users/je/Library/Android/sdk/platform-tools/adb"

def dump():
    subprocess.run([ADB, "shell", "uiautomator", "dump", "/sdcard/ui.xml"],
                   capture_output=True, timeout=40)
    raw = subprocess.run([ADB, "shell", "cat", "/sdcard/ui.xml"],
                         capture_output=True, timeout=40).stdout.decode("utf-8", "replace")
    return raw

def nodes(raw):
    out = []
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return out
    for n in root.iter("node"):
        t = (n.get("text") or "").strip()
        d = (n.get("content-desc") or "").strip()
        if not t and not d:
            continue
        b = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", n.get("bounds") or "")
        if not b:
            continue
        x1, y1, x2, y2 = map(int, b.groups())
        out.append({"text": t, "desc": d, "cx": (x1+x2)//2, "cy": (y1+y2)//2,
                    "bounds": (x1, y1, x2, y2)})
    return out

def find(ns, needle):
    n2 = needle.lower()
    for n in ns:
        if n2 in n["text"].lower() or n2 in n["desc"].lower():
            return n
    return None

def tap(x, y):
    subprocess.run([ADB, "shell", "input", "tap", str(x), str(y)], capture_output=True)

if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "list":
        for n in nodes(dump()):
            print(f"  ({n['cx']:>4},{n['cy']:>4})  {n['text'][:52]!r} | {n['desc'][:36]!r}")
    elif cmd == "tap":
        n = find(nodes(dump()), sys.argv[2])
        if not n:
            print("NOT FOUND:", sys.argv[2]); sys.exit(1)
        print(f"tapping {n['text'] or n['desc']!r} at ({n['cx']},{n['cy']})")
        tap(n["cx"], n["cy"])
        time.sleep(float(sys.argv[3]) if len(sys.argv) > 3 else 1.5)
    elif cmd == "has":
        n = find(nodes(dump()), sys.argv[2])
        print("FOUND" if n else "absent", ":", sys.argv[2])
