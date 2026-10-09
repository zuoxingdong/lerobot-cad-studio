"""The rps/lab@2 workcell in native MuJoCo: a fresh export compiles, carries the fixtures and the
puck the sidecar names, and a puck dropped into each nest settles seated."""

from __future__ import annotations

import json
import math
import os
import subprocess

import mujoco
import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))


@pytest.fixture(scope="module")
def out(tmp_path_factory):
    d = str(tmp_path_factory.mktemp("lab2"))
    subprocess.run(["node", os.path.join(STUDIO, "tools", "sim", "export.mjs"), "--robot", "lekiwi-pincopen", "--out", d],
                   cwd=STUDIO, check=True, capture_output=True, text=True, timeout=900)
    m = mujoco.MjModel.from_xml_path(os.path.join(d, "scene.xml"))
    with open(os.path.join(d, "scene.json"), encoding="utf-8") as fh:
        return m, json.load(fh)


def test_fixtures_and_puck_are_named_as_the_sidecar_says(out):
    m, meta = out
    lab = meta["lab"]
    assert lab["schema"] == "rps/lab@2" and abs(lab["T_mm"] - 277.33) < 1e-9
    for st in lab["stations"]:
        assert mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, st["body"]) > 0
        for g in ["plinth", "body"] + ["c%d" % k for k in range(1, 5)] + ["l%d" % k for k in range(1, 5)]:
            assert mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, "%s_%s" % (st["body"], g)) >= 0, g
    p = lab["props"][0]
    b = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, p["body"])
    assert abs(m.body_mass[b] - p["mass_kg"]) < 1e-9
    assert abs(m.body_ipos[b][2] * 1000 - 30.0) < 0.1
    for a in lab["anim"]:
        for g in a["geoms"]:
            assert mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, g) >= 0, g


@pytest.mark.parametrize("sid", ["lh", "inc", "reader"])
def test_a_dropped_puck_settles_seated(out, sid):
    m, meta = out
    st = next(s for s in meta["lab"]["stations"] if s["id"] == sid)
    d = mujoco.MjData(m)
    qa = m.jnt_qposadr[mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, "puck_1_free")]
    b = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, "puck_1")
    x, y = st["nest"]["xy"]
    d.qpos[qa:qa + 7] = [x / 1000, y / 1000, (st["nest"]["top_z"] + 20) / 1000, 1, 0, 0, 0]
    for _ in range(int(3.0 / m.opt.timestep)):
        mujoco.mj_step(m, d)
    p = d.xpos[b] * 1000
    tilt = math.degrees(math.acos(min(1.0, d.xmat[b][8])))
    assert math.hypot(p[0] - x, p[1] - y) <= 2.5 and p[2] - st["nest"]["floor_z"] <= 2.5 and tilt < 5, (p, tilt)
    assert np.linalg.norm(d.qvel[m.jnt_dofadr[mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, "puck_1_free")]:][:3]) < 1e-3
