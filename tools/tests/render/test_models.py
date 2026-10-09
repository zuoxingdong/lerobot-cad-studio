"""The hi-fi lab models (tools/render/blender/models) in real Blender, skipped without one: check_fit.py
on a fresh visual export keeps every fixture shell and the fingertip covers' grip face within 0.2 mm of
their MJCF collision geoms, the reach corridors, routes and sight lines clear, no overlapping floor tape,
the robot dress present in both LODs, the triangle budgets, and a byte-stable rebuild."""

from __future__ import annotations

import json
import os

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
RENDER = os.path.abspath(os.path.join(HERE, "..", "..", "render"))
import blender as BL  # noqa: E402


def check(lab, path, lod):
    try:
        BL.find_blender()
    except SystemExit as e:
        pytest.skip(str(e))
    code = BL.run("models/check_fit", ["--export", lab, "--lod", lod, "--json", str(path)])
    assert code == 0 and path.exists()
    return json.loads(path.read_text())


pytestmark = pytest.mark.blender


def test_models_fit_the_fixtures(lab, tmp_path):
    R = check(lab, tmp_path / "render.json", "render")
    F = R["fixtures"]
    assert {k for k in F if k.startswith("puck")} == {"puck_side", "puck_top"} and len(F) == 17, sorted(F)
    assert not {k: v for k, v in F.items() if v["fails"] or not v["rays"]}, F
    assert all(abs(v["worst_mm"]) <= 0.2 for k, v in F.items() if not k.endswith("_sides")), F
    P = R["pads"]
    assert len(P) == 2 and all(v["rays"] > 300 and not v["fails"] and abs(v["worst_mm"]) <= 0.2 for v in P.values()), P
    assert all(v["verts_inside"] == 0 for v in R["corridor"].values()), R["corridor"]
    assert all(v["ok"] for v in R["body_box"].values()), R["body_box"]
    assert all(v["ok"] for v in R["routes"].values()), R["routes"]
    assert all(all(v.values()) for v in R["sight"].values()), R["sight"]
    assert R["tape"]["cells"] > 1000 and R["tape"]["overlap_cells"] == 0, R["tape"]
    assert {"robot_dress", "omniwheel"} <= set(R["tris"]), sorted(R["tris"])
    assert R["pass"] and R["tris_total"] <= 1_500_000


def test_web_lod_budget_and_stable_rebuild(lab, tmp_path):
    a = check(lab, tmp_path / "web1.json", "web")
    b = check(lab, tmp_path / "web2.json", "web")
    assert a["tris_total"] <= 150_000, a["tris"]
    assert 0 < a["tris"]["robot_dress"] + a["tris"]["omniwheel"] <= 20_000, a["tris"]
    assert 0 < a["tris"]["robot_kit"] <= 8_000, a["tris"]
    assert a["hash"] == b["hash"], {k: v for k, v in a["hashes"].items() if b["hashes"].get(k) != v}
