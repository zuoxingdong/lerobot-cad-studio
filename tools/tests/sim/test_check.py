"""tools/sim/check.py on a fresh export: the JS pipeline end to end, then broken copies (a heavy base, a
stray exclude, a fingertip cover that touches the robot, a doctored instrument log)."""

from __future__ import annotations

import os
import re
import shutil
import subprocess

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
SIM = os.path.join(STUDIO, "tools", "sim")
import check  # noqa: E402


def node(*args):
    subprocess.run(["node", *args], cwd=STUDIO, check=True, capture_output=True, text=True, timeout=900)


@pytest.fixture(scope="module")
def out(tmp_path_factory):
    d = str(tmp_path_factory.mktemp("lab"))
    node(os.path.join(SIM, "export.mjs"), "--robot", "lekiwi-pincopen", "--out", d)
    node(os.path.join(SIM, "run-lab.mjs"), d)
    return d


def test_fresh_export_passes_every_check(out):
    assert check.main([out]) == 0
    md = open(os.path.join(out, "report.md"), encoding="utf-8").read()
    assert re.search(r"\n(\d+) checks, 0 failed", md), md[-400:]
    assert "instrument events: native mirror = WASM log" in md and "puck final pose within 1 mm" in md
    assert "outcome: puck seated lh -> inc -> reader" in md and "lid interlock" in md and "nav clearance" in md


def test_a_heavier_robot_fails_the_mass_band(out, tmp_path):
    bad = str(tmp_path / "heavy")
    shutil.copytree(out, bad)
    p = os.path.join(bad, "scene.xml")
    xml = open(p, encoding="utf-8").read()
    xml = re.sub(r'(<geom class="collision" name="col_base_plate_layer1-v5" mesh="[^"]+" mass=")[^"]+"', r'\g<1>2"', xml)
    open(p, "w", encoding="utf-8").write(xml)
    assert check.main([bad, "--no-lab"]) == 1
    md = open(os.path.join(bad, "report.md"), encoding="utf-8").read()
    assert "**FAIL** | mass | robot total" in md and "**FAIL** | mass | heaviest printed part" in md


def test_a_loop_closure_that_is_not_pinned_is_caught(out, tmp_path):
    bad = str(tmp_path / "unpinned")
    shutil.copytree(out, bad)
    p = os.path.join(bad, "scene.xml")
    xml = open(p, encoding="utf-8").read()
    # exclude a pair that is neither joint-sharing nor a pinned loop: the count check fails
    xml = xml.replace("</contact>", '    <exclude body1="pincopen_jaw_finger_L" body2="pincopen_jaw_finger_R"/>\n  </contact>')
    open(p, "w", encoding="utf-8").write(xml)
    assert check.main([bad, "--no-lab"]) == 1
    md = open(os.path.join(bad, "report.md"), encoding="utf-8").read()
    assert "**FAIL** | contact | excludes" in md


def test_a_cover_that_touches_the_robot_is_caught(out, tmp_path):
    bad = str(tmp_path / "cover")
    shutil.copytree(out, bad)
    p = os.path.join(bad, "scene.xml")
    xml = open(p, encoding="utf-8").read()
    assert xml.count('<geom contype="2" conaffinity="1" priority="1"') == 1
    xml = xml.replace('<geom contype="2" conaffinity="1" priority="1"', '<geom contype="2" conaffinity="5" priority="1"')
    open(p, "w", encoding="utf-8").write(xml)
    assert check.main([bad, "--no-lab"]) == 1
    md = open(os.path.join(bad, "report.md"), encoding="utf-8").read()
    assert "**FAIL** | pads | the covers touch the world, never the robot" in md


def test_a_doctored_instrument_log_fails_the_event_parity(out, tmp_path):
    import json

    bad = str(tmp_path / "events")
    shutil.copytree(out, bad)
    p = os.path.join(bad, "report.json")
    run = json.load(open(p, encoding="utf-8"))
    ev = run["outcome"]["instrument_events"]
    k = next(i for i, e in enumerate(ev) if e["station"] == "inc" and e["state"] == "running")
    ev[k]["t"] = round(ev[k]["t"] - 0.5, 3)          # the lid would have "run" 0.5 s early
    json.dump(run, open(p, "w", encoding="utf-8"))
    assert check.main([bad]) == 1
    md = open(os.path.join(bad, "report.md"), encoding="utf-8").read()
    assert "**FAIL** | lab | instrument events" in md


def test_a_zip_gets_its_report_beside_it_and_leaves_no_tempdir(out, tmp_path, capsys):
    import glob
    import tempfile
    import zipfile

    z = str(tmp_path / "robot-mjcf.zip")
    with zipfile.ZipFile(z, "w") as zf:
        for r, _, fs in os.walk(out):
            for f in fs:
                zf.write(os.path.join(r, f), os.path.relpath(os.path.join(r, f), out))
    before = set(glob.glob(os.path.join(tempfile.gettempdir(), "rps-check-*")))
    assert check.main([z, "--no-lab"]) == 0
    assert os.path.isfile(str(tmp_path / "robot-mjcf-report.md"))
    assert "report: " + str(tmp_path / "robot-mjcf-report.md") in capsys.readouterr().out
    assert set(glob.glob(os.path.join(tempfile.gettempdir(), "rps-check-*"))) == before

    empty = str(tmp_path / "empty.zip")
    with zipfile.ZipFile(empty, "w") as zf:
        zf.writestr("readme.txt", "no scene here")
    assert check.main([empty]) == 2
    assert "has no scene.xml" in capsys.readouterr().err
