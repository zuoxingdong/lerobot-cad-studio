"""The Sim tab's "Download MJCF zip" after a lab run (built headless by page-zip.mjs with the
page's own session module), unzipped and pushed through tools/sim/check.py."""

from __future__ import annotations

import json
import os
import re
import subprocess
import zipfile

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
import check  # noqa: E402


@pytest.fixture(scope="module")
def unzipped(tmp_path_factory):
    d = tmp_path_factory.mktemp("page")
    z = str(d / "lekiwi-pincopen-mjcf.zip")
    subprocess.run(["node", os.path.join(HERE, "page-zip.mjs"), z], cwd=STUDIO, check=True,
                   capture_output=True, text=True, timeout=900)
    out = str(d / "mjcf")
    with zipfile.ZipFile(z) as f:
        f.extractall(out)
    return out


def test_the_zip_carries_the_lab_run(unzipped):
    names = set(os.listdir(unzipped))
    assert {"scene.xml", "scene.json", "design.json", "report.json", "ctrl.f32", "meshes"} <= names
    rep = json.load(open(os.path.join(unzipped, "report.json"), encoding="utf-8"))
    assert rep["timing"]["task_wall_ms"] > 0
    assert rep["outcome"]["complete"] and rep["outcome"]["puck_path"] == ["lh", "inc", "reader"]
    assert [e["state"] for e in rep["outcome"]["instrument_events"] if e["station"] == "reader"][-1] == "done"
    assert os.path.getsize(os.path.join(unzipped, "ctrl.f32")) == 4 * rep["nu"] * rep["ctrl_log"]["rows"]


def test_check_py_passes_the_page_zip(unzipped):
    assert check.main([unzipped]) == 0
    md = open(os.path.join(unzipped, "report.md"), encoding="utf-8").read()
    n = re.search(r"\n(\d+) checks, 0 failed", md)
    assert n and int(n.group(1)) >= 58, md[-400:]
    assert "instrument events: native mirror = WASM log" in md and "puck final pose within 1 mm" in md
