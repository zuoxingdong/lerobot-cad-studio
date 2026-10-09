"""The frozen showcase lab in site/lab: the manifest sha256s, KTX2, meshopt GLBs, the probe, the budgets,
the credits. These files are committed output; nothing in the studio rebuilds them."""

from __future__ import annotations

import glob
import hashlib
import json
import os
import struct

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
RENDER = os.path.join(STUDIO, "tools", "render")

WEB = os.path.join(STUDIO, "site", "lab")
MAN = os.path.join(WEB, "manifest.json")


def manifest():
    if not os.path.exists(MAN):
        pytest.skip("no web assets")
    M = json.load(open(MAN))
    assert M.get("stand_in") is False, "the committed manifest is an unbaked stand-in"
    return M


def test_committed_files_match_the_manifest():
    M = manifest()
    for f in M["files"]:
        buf = open(os.path.join(WEB, f["name"]), "rb").read()
        assert len(buf) == f["bytes"] and hashlib.sha256(buf).hexdigest()[:16] == f["sha256"], f["name"]


def test_formats():
    M = manifest()
    for lm in M["lightmaps"]:
        head = open(os.path.join(WEB, lm["file"]), "rb").read(80)
        assert head[:12] == b"\xabKTX 20\xbb\r\n\x1a\n", lm["file"]
        w, h, levels, scheme = struct.unpack("<II", head[20:28]) + struct.unpack("<II", head[40:48])
        assert w == h == lm["res"] and levels > 1, lm["file"]
        assert scheme == (2 if lm["codec"] == "uastc" else 1), lm["file"]          # zstd / BasisLZ
        if lm.get("normal"):
            nb = open(os.path.join(WEB, lm["normal"]["file"]), "rb").read()
            assert nb[:12] == head[:12] and struct.unpack("<II", nb[20:28]) == (lm["normal"]["res"],) * 2
            dfd = struct.unpack("<I", nb[48:52])[0]
            assert nb[dfd + 14] == 1, "the normal map is not linear"                   # KHR_DF_TRANSFER_LINEAR
    for name in (M["lab"]["file"], M["movers"]["file"]):
        data = open(os.path.join(WEB, name), "rb").read()
        n = struct.unpack("<I", data[12:16])[0]
        doc = json.loads(data[20:20 + n])
        assert "EXT_meshopt_compression" in doc.get("extensionsRequired", []), name
        if name == M["lab"]["file"]:
            lit = {n["name"] for n in doc["nodes"] if M["lab"]["nodes"][n["name"]].get("lm") is not None}
            meshes = {doc["meshes"][n["mesh"]]["name"] for n in doc["nodes"] if n["name"] in lit}
            assert lit and all("TEXCOORD_0" in m["primitives"][0]["attributes"] for m in doc["meshes"] if m["name"] in meshes)
    assert open(os.path.join(WEB, M["probe"]["file"]), "rb").read(10) == b"#?RADIANCE"


def test_budgets_and_credits():
    M = manifest()
    by = {}
    for f in M["files"]:
        by[f["role"]] = by.get(f["role"], 0) + f["bytes"]
    assert by["lab"] <= 1.5e6 and by["lightmap"] <= 12e6 and by["probe"] <= 0.8e6 and by["run"] <= 2e6
    disk = sum(os.path.getsize(p) for d in (WEB, os.path.join(STUDIO, "site", "vendor", "basis"))
               for p in glob.glob(os.path.join(d, "*")))
    assert disk <= 18e6, "deployed lab assets %d B" % disk
    credits = open(os.path.join(WEB, "ATTRIBUTION.md")).read().splitlines()
    lock = json.load(open(os.path.join(RENDER, "assets.lock.json")))["assets"]
    rows = ["| [%s](%s) | %s | %s | %s | %s |" % (a["id"], a["page"], a["source"], a["author"], a["license"],
                                                ", ".join(a.get("used_by") or [])) for a in lock]
    assert [r for r in credits if r.startswith("| [")] == rows, "site/lab/ATTRIBUTION.md does not credit the assets in assets.lock.json"
    assert all(a["license"].startswith(("CC0", "CC-BY")) for a in lock)
