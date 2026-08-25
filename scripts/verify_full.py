#!/usr/bin/env python3
"""Full diff of the device's applied order against independently fetched dates.

Mirrors the extension's own rule: sort by upload date, except where YouTube's
"x ago" label contradicts it, in which case use the displayed publish date.
"""
import json, re, sys
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor

import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import innertube
MONTHS = {m: i for i, m in enumerate(
    ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"])}
UNITS = [(r"^sec", 1e3), (r"^min", 6e4), (r"^(hour|hr)", 3.6e6), (r"^day", 8.64e7),
         (r"^(week|wk)", 6.048e8), (r"^(mon|mo$)", 2.629746e9), (r"^(year|yr)", 3.1556952e10)]

sc = sys.argv[1]
rows = json.loads(json.load(open(f"{sc}/phone_order4.json"))["result"])
truth = json.load(open(f"{sc}/truth.json"))
now_ms = datetime.now(timezone.utc).timestamp() * 1000

def unit_ms(u):
    for pat, ms in UNITS:
        if re.search(pat, u): return ms
    return None

def contradicts(exact_ms, label):
    if not label: return False
    m = re.match(r"(\d+)\s*(\w+)", label)
    if not m: return False
    ms = unit_ms(m.group(2).lower())
    if ms is None: return False
    n, age = int(m.group(1)), now_ms - exact_ms
    slack = 3 * 86400000
    return age < n * ms - slack or age > (n + 1) * ms + slack

def parse_date_text(t):
    m = re.search(r"([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})", t or "")
    if not m: return None
    mon = MONTHS.get(m.group(1)[:3].lower())
    if mon is None: return None
    return datetime(int(m.group(3)), mon + 1, int(m.group(2)), 12, tzinfo=timezone.utc).timestamp() * 1000

def displayed(vid):
    raw = innertube.call("next", vid)
    for pat in [r'"dateText":\{"simpleText":"([^"]+)"', r'"publishDate":\{"runs":\[\{"text":"([^"]+)"']:
        m = re.search(pat, raw)
        if m:
            v = parse_date_text(m.group(1))
            if v: return vid, v
    return vid, None

upload_ms = {r["id"]: datetime.fromisoformat(truth[r["id"]]["publishDate"]).timestamp() * 1000 for r in rows}
suspects = [r["id"] for r in rows if contradicts(upload_ms[r["id"]], r["ago"])]
print(f"videos whose label contradicts the upload date: {len(suspects)} -> {suspects}")

with ThreadPoolExecutor(max_workers=4) as ex:
    refined = dict(ex.map(displayed, suspects))
for v, d in refined.items():
    if d: print(f"   {v}: upload {datetime.fromtimestamp(upload_ms[v]/1000, timezone.utc).date()}"
                f" -> displayed {datetime.fromtimestamp(d/1000, timezone.utc).date()}")

effective = {vid: (refined.get(vid) or ms) for vid, ms in upload_ms.items()}
by_dom = sorted(rows, key=lambda r: r["domIndex"])
expected = list(reversed(sorted(by_dom, key=lambda r: effective[r["id"]])))
actual = sorted(rows, key=lambda r: r["order"])

bad = [(i, e["id"], a["id"]) for i, (e, a) in enumerate(zip(expected, actual)) if e["id"] != a["id"]]
print(f"\npositions compared: {len(actual)}  mismatches: {len(bad)}")
for i, e, a in bad[:10]: print(f"   pos {i}: expected {e} got {a}")

seq = [effective[r["id"]] for r in actual]
viol = [i for i in range(len(seq)-1) if seq[i] < seq[i+1]]
print(f"date-order violations: {len(viol)}")
print(f"label/date disagreements remaining: "
      f"{sum(1 for r in actual if contradicts(effective[r['id']], r['ago']))}")
