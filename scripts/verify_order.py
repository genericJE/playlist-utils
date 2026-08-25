#!/usr/bin/env python3
"""Fetches exact publish dates for a playlist and diffs them against the order
the extension actually applied on the device."""
import json, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"
CTX = {"client": {"clientName": "WEB", "clientVersion": "2.20260824.10.00", "hl": "en", "gl": "US"}}

def fetch(vid):
    body = json.dumps({"context": CTX, "videoId": vid}).encode()
    req = urllib.request.Request(
        f"https://www.youtube.com/youtubei/v1/player?key={KEY}&prettyPrint=false",
        data=body, headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
    try:
        j = json.load(urllib.request.urlopen(req, timeout=25))
    except Exception as e:
        return vid, {"error": str(e)}
    mf = (j.get("microformat") or {}).get("playerMicroformatRenderer") or {}
    return vid, {
        "publishDate": mf.get("publishDate"),
        "uploadDate": mf.get("uploadDate"),
        "viewCount": mf.get("viewCount"),
        "status": (j.get("playabilityStatus") or {}).get("status"),
        "title": ((mf.get("title") or {}).get("simpleText") or "")[:46],
    }

sc = sys.argv[1]
rows = json.loads(json.load(open(f"{sc}/phone_order2.json"))["result"])
ids = [r["id"] for r in rows]

with ThreadPoolExecutor(max_workers=8) as ex:
    meta = dict(ex.map(fetch, ids))
json.dump(meta, open(f"{sc}/truth.json", "w"), indent=1)

errors = [v for v in ids if meta[v].get("error") or not meta[v].get("publishDate")]
print(f"fetched {len(ids)} | failures: {len(errors)}")
if errors:
    for v in errors[:5]:
        print("   ", v, meta[v])

# Replicate the extension's comparator exactly: stable ascending by date over
# DOM order, then reversed for chrono-flipped.
by_dom = sorted(rows, key=lambda r: r["domIndex"])
asc = sorted(by_dom, key=lambda r: meta[r["id"]]["publishDate"])
expected = list(reversed(asc))
actual = sorted(rows, key=lambda r: r["order"])

mismatches = [(i, e, a) for i, (e, a) in enumerate(zip(expected, actual)) if e["id"] != a["id"]]
print(f"positions compared: {len(actual)} | mismatches: {len(mismatches)}")
for i, e, a in mismatches[:10]:
    print(f"  pos {i}: expected {e['id']} ({meta[e['id']]['publishDate'][:10]}) got {a['id']} ({meta[a['id']]['publishDate'][:10]})")

# Is the applied order monotonically non-increasing by date?
dates = [meta[r["id"]]["publishDate"] for r in actual]
bad = [i for i in range(len(dates) - 1) if dates[i] < dates[i + 1]]
print(f"date-order violations in applied list: {len(bad)}")

# Do publishDate and uploadDate ever disagree?
diff = [v for v in ids if meta[v].get("uploadDate") and meta[v]["uploadDate"][:10] != meta[v]["publishDate"][:10]]
print(f"videos where uploadDate != publishDate: {len(diff)}")
for v in diff[:5]:
    print("   ", v, meta[v]["publishDate"][:10], "vs upload", meta[v]["uploadDate"][:10], meta[v]["title"])
