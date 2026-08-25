#!/usr/bin/env python3
"""Reads YouTube's InnerTube config from the page it already serves.

Nothing is hardcoded: the key lives in youtube.com's own markup, which is where
the extension reads it from too.
"""
import functools
import json
import re
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126 Safari/537.36")


@functools.lru_cache(maxsize=1)
def config():
    req = urllib.request.Request(
        "https://www.youtube.com/",
        headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
    html = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")

    key = re.search(r'"INNERTUBE_API_KEY":"([^"]+)"', html)
    version = re.search(r'"INNERTUBE_CLIENT_VERSION":"([^"]+)"', html)
    if not key:
        raise RuntimeError("could not read INNERTUBE_API_KEY from youtube.com")
    return {
        "key": key.group(1),
        "client_version": version.group(1) if version else "2.20240101.00.00",
    }


def context():
    return {"client": {"clientName": "WEB",
                       "clientVersion": config()["client_version"],
                       "hl": "en", "gl": "US"}}


def call(endpoint, video_id, timeout=30):
    """POSTs to an InnerTube endpoint and returns the raw response text."""
    body = json.dumps({"context": context(), "videoId": video_id}).encode()
    req = urllib.request.Request(
        f"https://www.youtube.com/youtubei/v1/{endpoint}"
        f"?key={config()['key']}&prettyPrint=false",
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": UA})
    return urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8", "replace")
