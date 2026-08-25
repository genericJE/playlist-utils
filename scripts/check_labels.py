#!/usr/bin/env python3
"""Compares each row's "X ago" label against the exact publish date, and pulls
an independent date string from the `next` endpoint for the disputed videos."""
import json, re, sys
from datetime import datetime, timezone

import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import innertube
sc = sys.argv[1]
rows = json.loads(json.load(open(f"{sc}/phone_order2.json"))["result"])
meta = json.load(open(f"{sc}/truth.json"))
now = datetime.now(timezone.utc)

def months_between(then, now_):
    m = (now_.year - then.year) * 12 + (now_.month - then.month)
    if now_.day < then.day:
        m -= 1
    return m

def expected_label(iso):
    then = datetime.fromisoformat(iso)
    days = (now - then).days
    if days < 7:  return f"{days} days"
    if days < 30: return f"{days // 7} weeks"
    m = months_between(then, now)
    if m < 12:    return f"{m} months"
    return f"{m // 12} years"

def norm(label):
    if not label: return None
    n = re.match(r"(\d+)\s*(\w+)", label)
    return f"{n.group(1)} {n.group(2).rstrip('s')}s" if n else label

bad = []
for r in rows:
    exp = expected_label(meta[r["id"]]["publishDate"])
    got = norm(r["ago"])
    if norm(exp) != got:
        bad.append((r, exp, got))

print(f"rows: {len(rows)} | label disagrees with exact date: {len(bad)}")
for r, exp, got in bad:
    st = meta[r["id"]]["status"]
    print(f"  {r['id']} {meta[r['id']]['publishDate'][:10]} label={got!r} expected={exp!r} status={st} :: {r['title']}")

def next_date(vid):
    j = json.loads(innertube.call("next", vid, timeout=25))
    hits = set(re.findall(r'"(?:dateText|publishDate|relativeDateText)":\{"simpleText":"([^"]+)"', json.dumps(j)))
    hits |= set(re.findall(r'"publishDate":"([^"]+)"', json.dumps(j)))
    return sorted(hits)[:6]

print("\nindependent `next` endpoint dates for the disputed rows and neighbours:")
for vid in ["7vHEeb3NDY0", "FxxaCM4aEVY", "JlHlR2No6lk", "AWUH2y4gyEU", "AAHBjv3oLe8"]:
    if vid in meta:
        print(f"  {vid} micro={meta[vid]['publishDate'][:10]} status={meta[vid]['status']:<10} next={next_date(vid)} :: {meta[vid]['title']}")
