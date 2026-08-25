#!/usr/bin/env python3
"""Reports the AMO review state for this add-on. Reads credentials from
~/.amo-credentials and never prints them."""
import base64, hashlib, hmac, json, os, time, urllib.parse, urllib.request, urllib.error

def creds():
    out = {}
    with open(os.path.expanduser("~/.amo-credentials")) as f:
        for line in f:
            if "=" in line:
                k, v = line.strip().split("=", 1)
                out[k] = v
    return out["WEB_EXT_API_KEY"], out["WEB_EXT_API_SECRET"]

def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=")

def jwt(key, secret):
    now = int(time.time())
    header = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = b64(json.dumps({
        "iss": key, "jti": str(now), "iat": now, "exp": now + 60,
    }).encode())
    signing = header + b"." + payload
    sig = b64(hmac.new(secret.encode(), signing, hashlib.sha256).digest())
    return (signing + b"." + sig).decode()

def get(path):
    key, secret = creds()
    req = urllib.request.Request(
        f"https://addons.mozilla.org/api/v5/{path}",
        headers={"Authorization": f"JWT {jwt(key, secret)}", "User-Agent": "playlist-utils-status"})
    try:
        return json.load(urllib.request.urlopen(req, timeout=30))
    except urllib.error.HTTPError as e:
        return {"http_error": e.code, "body": e.read().decode()[:300]}

ADDON = "playlist-utils@johneric.local"
info = get(f"addons/addon/{urllib.parse.quote(ADDON, safe='')}/")
print("addon status :", info.get("status"))
print("slug         :", info.get("slug"))
print("listing url  :", info.get("url"))
print("is_disabled  :", info.get("is_disabled"))
cur = info.get("current_version") or {}
print("current ver  :", cur.get("version"), "| file status:",
      ((cur.get("file") or {}).get("status")))

vers = get(f"addons/addon/{urllib.parse.quote(ADDON, safe='')}/versions/?filter=all_with_unlisted")
for v in (vers.get("results") or [])[:6]:
    f = v.get("file") or {}
    print(f"  v{v.get('version'):<8} channel={v.get('channel'):<8} "
          f"file_status={f.get('status'):<10} approved={bool(f.get('approval_date') or f.get('is_signed'))}")
