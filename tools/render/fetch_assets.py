#!/usr/bin/env python3
"""Fetch the CC0 textures and HDRIs in assets.lock.json into out/work/cache/render/<id>/, sha256-verified.

    fetch_assets.py                 fetch what is missing, verify every download, reuse the cache
    fetch_assets.py --check         verify the lock (licences, fields) and the cache, fetch nothing
    fetch_assets.py --pin           fill in the sha256 of entries that have none (adding an asset)

A zip keeps only the files the entry lists under `maps`. A cache dir is valid when its .sha256 stamp
matches the lock and every listed file exists; --check also re-hashes each file against .files.json,
the sha256s recorded at unpack.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import shutil
import sys
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
LOCK = os.path.join(HERE, "assets.lock.json")
sys.path.append(os.path.dirname(HERE))
import paths  # noqa: E402

CACHE = os.path.join(paths.CACHE, "render")
FREE = ("CC0-1.0", "CC-BY-4.0")
FIELDS = ("id", "source", "url", "res", "sha256", "license", "author", "used_by", "maps")
UA = "rps-fetch-assets/1"


def load(path=LOCK):
    return json.load(open(path, encoding="utf-8"))


def problems(lock):
    """lock-file errors: missing fields, a non-free licence, duplicate ids, non-https urls"""
    bad, seen = [], set()
    for e in lock.get("assets", []):
        tag = e.get("id", "?")
        bad += ["%s: no %s" % (tag, f) for f in FIELDS if f not in e]
        if e.get("license") not in FREE:
            bad.append("%s: licence %r is not CC0/CC-BY" % (tag, e.get("license")))
        if tag in seen:
            bad.append("%s: duplicate id" % tag)
        seen.add(tag)
        if not str(e.get("url", "")).startswith("https://"):
            bad.append("%s: url is not https" % tag)
        for f in (e.get("maps") or {}).values():
            if os.path.isabs(f) or ".." in f.replace("\\", "/").split("/"):
                bad.append("%s: map %r leaves the cache dir" % (tag, f))
    return bad


def path(entry, role, cache=CACHE):
    """the cached file of a map role ('rough', 'normal', 'hdr', ...)"""
    return os.path.join(cache, entry["id"], entry["maps"][role])


def file_sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for b in iter(lambda: fh.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def record(d, names):
    with open(os.path.join(d, ".files.json"), "w") as fh:
        json.dump({n: file_sha(os.path.join(d, n)) for n in sorted(names)}, fh, indent=1)


def valid(entry, cache=CACHE, deep=False):
    """the stamp matches and every map exists; deep: and each map's bytes match .files.json"""
    d = os.path.join(cache, entry["id"])
    stamp = os.path.join(d, ".sha256")
    if not os.path.exists(stamp) or open(stamp).read().strip() != entry.get("sha256"):
        return False
    if not all(os.path.exists(os.path.join(d, f)) for f in entry["maps"].values()):
        return False
    if not deep:
        return True
    try:
        got = json.load(open(os.path.join(d, ".files.json")))
    except (OSError, ValueError):
        return False
    return all(got.get(f) == file_sha(os.path.join(d, f)) for f in entry["maps"].values())


def download(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def unpack(entry, blob, cache=CACHE):
    d = os.path.join(cache, entry["id"])
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d)
    names = set(entry["maps"].values())
    if entry["url"].split("?")[-1].endswith(".zip") or blob[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            for n in names:
                os.makedirs(os.path.dirname(os.path.join(d, n)), exist_ok=True)
                with z.open(n) as src, open(os.path.join(d, n), "wb") as dst:
                    shutil.copyfileobj(src, dst)
    else:
        (n,) = names
        os.makedirs(os.path.dirname(os.path.join(d, n)), exist_ok=True)
        open(os.path.join(d, n), "wb").write(blob)
    record(d, names)
    open(os.path.join(d, ".sha256"), "w").write(entry["sha256"])


def fetch(lock, cache=CACHE, pin=False, log=print):
    got = reused = 0
    for e in lock["assets"]:
        if e.get("sha256") and valid(e, cache):
            d = os.path.join(cache, e["id"])
            if not os.path.exists(os.path.join(d, ".files.json")):
                record(d, e["maps"].values())           # a cache from before the per-file record
            reused += 1
            continue
        blob = download(e["url"])
        h = hashlib.sha256(blob).hexdigest()
        if not e.get("sha256") and pin:
            e["sha256"] = h
        if h != e.get("sha256"):
            raise SystemExit("fetch_assets: %s sha256 %s != lock %s" % (e["id"], h, e.get("sha256")))
        unpack(e, blob, cache)
        got += 1
        log("fetched %s (%.1f MB)" % (e["id"], len(blob) / 1e6))
    return got, reused


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--pin", action="store_true")
    ap.add_argument("--lock", default=LOCK)
    ap.add_argument("--cache", default=CACHE)
    a = ap.parse_args(argv)
    lock = load(a.lock)
    bad = problems(lock)
    if a.pin:
        bad = [b for b in bad if not b.endswith("no sha256")]
    if bad:
        raise SystemExit("fetch_assets: lock errors:\n  " + "\n  ".join(bad))
    if a.check:
        missing = [e["id"] for e in lock["assets"] if not valid(e, a.cache, deep=True)]
        print("fetch_assets: lock ok (%d assets); cache %s" % (
            len(lock["assets"]), "ok" if not missing else "missing or changed (fetch_assets.py refetches): " + ", ".join(missing)))
        return 1 if missing else 0
    got, reused = fetch(lock, a.cache, a.pin)
    if a.pin:
        with open(a.lock, "w", encoding="utf-8") as fh:
            json.dump(lock, fh, indent=1)
            fh.write("\n")
    print("fetch_assets: %d fetched, %d reused -> %s" % (got, reused, os.path.relpath(a.cache, os.getcwd())))
    return 0


if __name__ == "__main__":
    sys.exit(main())
