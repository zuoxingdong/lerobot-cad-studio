"""export.mjs --visual changes no physics; video.py writes the MP4 it says it does; its liquid and wheel
spin (videofx.py) agree with the page's (sim-liquid.js, sim-wheels.js)."""

from __future__ import annotations

import math
import os
import shutil
import subprocess
import sys

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
SIM, FILM = os.path.join(STUDIO, "tools", "sim"), os.path.join(STUDIO, "tools", "render", "film")
import check  # noqa: E402
import video  # noqa: E402
import videofx  # noqa: E402

pytestmark = pytest.mark.slow                   # two lab exports and a lab run


def node(*args):
    subprocess.run(["node", *args], cwd=STUDIO, check=True, capture_output=True, text=True, timeout=900)


@pytest.fixture(scope="module")
def pair(tmp_path_factory):
    """(plain export with a lab run, the same export with visuals and that run copied in)"""
    plain, vis = str(tmp_path_factory.mktemp("plain")), str(tmp_path_factory.mktemp("visual"))
    node(os.path.join(SIM, "export.mjs"), "--robot", "lekiwi-pincopen", "--out", plain)
    node(os.path.join(SIM, "export.mjs"), "--robot", "lekiwi-pincopen", "--visual", "--out", vis)
    node(os.path.join(SIM, "run-lab.mjs"), plain)
    for f in ("ctrl.f32", "report.json"):
        shutil.copy(os.path.join(plain, f), vis)
    return plain, vis


def test_visual_geoms_change_no_physics(pair):
    import mujoco

    ms = [mujoco.MjModel.from_xml_path(os.path.join(p, "scene.xml")) for p in pair]
    assert ms[1].ngeom > ms[0].ngeom and ms[1].nbody == ms[0].nbody
    vis = [g for g in range(ms[1].ngeom) if ms[1].geom(g).name.startswith("vis_")]
    assert len(vis) == sum(1 for i in range(ms[0].nmesh) if not ms[0].mesh(i).name.startswith(("decor_", "pad_")))
    assert all(ms[1].geom_contype[g] == 0 and ms[1].geom_conaffinity[g] == 0 and ms[1].geom_group[g] == 1 for g in vis)
    assert all(ms[1].geom_group[g] == 3 for g in range(ms[1].ngeom) if ms[1].geom(g).name.startswith(("col_", "pad_")))
    liq = [g for g in range(ms[1].ngeom) if ms[1].geom(g).name.startswith(("puck_1_liquid_", "puck_1_meniscus_"))]
    assert len(liq) == 8 and all(ms[1].geom_group[g] == 1 and ms[1].geom_contype[g] == 0 and ms[1].geom_conaffinity[g] == 0
                                 and ms[1].geom_bodyid[g] == ms[1].body("puck_1").id for g in liq)
    for k in ("body_mass", "body_inertia", "body_ipos", "body_iquat"):
        assert np.array_equal(getattr(ms[0], k), getattr(ms[1], k)), k
    ctrl = np.fromfile(os.path.join(pair[0], "ctrl.f32"), dtype="<f4").reshape(-1, ms[0].nu)
    ds = [mujoco.MjData(m) for m in ms]
    for m, d in zip(ms, ds):
        mujoco.mj_resetData(m, d)
        mujoco.mj_forward(m, d)
    worst = 0.0
    for row in ctrl:
        for m, d in zip(ms, ds):
            d.ctrl[:] = row
            mujoco.mj_step(m, d)
        worst = max(worst, float(np.max(np.abs(ds[0].qpos - ds[1].qpos))))
    assert worst <= 1e-9, "qpos differs by %g over the lab run" % worst


def test_check_passes_with_visuals(pair):
    assert check.main([pair[1]]) == 0


def test_one_second_clip_at_the_default_1080p(pair, tmp_path):
    try:
        video.gl_backend()
    except SystemExit as e:
        pytest.skip(str(e))
    import imageio_ffmpeg

    def clip(mp4):          # a child process: MUJOCO_GL must be set before mujoco is first imported
        subprocess.run([sys.executable, os.path.join(FILM, "video.py"), pair[1], "--seconds", "1", "--mp4", mp4],
                       check=True, timeout=600)

    mp4 = str(tmp_path / "clip.mp4")
    clip(mp4)
    assert os.path.getsize(mp4) > 10_000
    frames, _ = imageio_ffmpeg.count_frames_and_secs(mp4)
    assert frames == 30
    meta = next(imageio_ffmpeg.read_frames(mp4))
    assert tuple(meta["size"]) == (1920, 1080) == tuple(int(v) for v in video.SIZE.split("x"))
    info = subprocess.run([video.ffmpeg_exe(), "-hide_banner", "-i", mp4], capture_output=True, text=True).stderr
    assert "yuv420p(tv, bt709" in info, info           # BT.709 matrix, tagged
    again = str(tmp_path / "again.mp4")
    clip(again)
    assert open(mp4, "rb").read() == open(again, "rb").read(), "same input, different MP4"


JS_TRACE = """
import fs from 'node:fs';
import { createLiquid } from './src/features/sim-liquid.js';
import { wheelRates } from './src/features/sim-wheels.js';
const [spec, wheels, bin] = [JSON.parse(process.argv[1]), JSON.parse(process.argv[2]), process.argv[3]];
const a = new Float64Array(fs.readFileSync(bin).buffer.slice(0)), L = createLiquid(spec), out = [];
for (let r = 0; r * 13 < a.length; r++) {
  const o = 13 * r;
  L.sample(a[o], [a[o + 1], a[o + 2], a[o + 3]], a.subarray(o + 4, o + 13));
  if (r % 10 === 0) out.push(L.surfaces().map((s) => s.slope));
}
const v = [[0, 0.2, 0], [0.2, 0, 0], [0, 0, 1], [0.13, -0.07, 0.4]];
console.log(JSON.stringify({ slopes: out, wheels: v.map((x) => wheelRates(wheels, ...x)) }));
"""


def test_liquid_and_wheels_agree_with_the_page(pair, tmp_path):
    """the lab run's puck trajectory through videofx.py and sim-liquid.js: surfaces within 0.1 deg"""
    import json
    import mujoco

    out = pair[1]
    meta = json.load(open(os.path.join(out, "scene.json"), encoding="utf-8"))
    m = mujoco.MjModel.from_xml_path(os.path.join(out, "scene.xml"))
    d = mujoco.MjData(m)
    ctrl = np.fromfile(os.path.join(out, "ctrl.f32"), dtype="<f4").reshape(-1, m.nu)
    spec, pk = meta["lab"]["props"][0]["liquid"], m.body("puck_1").id
    L, rows, py = videofx.Liquid(spec), [], []
    mujoco.mj_resetData(m, d)
    for k, row in enumerate(ctrl[:12000]):            # to the seat in the incubator: lift-off, carry, touch-down
        d.ctrl[:] = row
        mujoco.mj_step(m, d)
        rows.append([d.time, *d.xpos[pk], *d.xmat[pk]])
        L.sample(d.time, d.xpos[pk].tolist(), d.xmat[pk].tolist())
        if k % 10 == 0:
            py.append(L.surfaces())
    bin_ = str(tmp_path / "puck.f64")
    np.asarray(rows, "<f8").tofile(bin_)
    r = subprocess.run(["node", "--input-type=module", "-e", JS_TRACE, json.dumps(spec), json.dumps(meta["wheels"]), bin_],
                       cwd=STUDIO, check=True, capture_output=True, text=True, timeout=300)
    js = json.loads(r.stdout)
    assert len(js["slopes"]) == len(py)

    def normal(s):
        n = np.array([-s[0], -s[1], 1.0])
        return n / np.linalg.norm(n)
    worst = max(math.degrees(math.acos(min(1.0, float(normal(a) @ normal(b)))))
                for P, J in zip(py, js["slopes"]) for a, b in zip(P, J))
    peak = max(math.degrees(math.atan(math.hypot(*s))) for P in py for s in P)
    print("liquid: JS vs Python worst %.2e deg over %d samples, peak lean %.1f deg" % (worst, len(py), peak))
    assert worst < 0.1, "JS and Python surfaces differ by %.4f deg" % worst
    assert peak > 2.0, "the carry should lean the surface (peak %.2f deg)" % peak
    for v, w in zip([[0, 0.2, 0], [0.2, 0, 0], [0, 0, 1], [0.13, -0.07, 0.4]], js["wheels"]):
        assert np.allclose(videofx.wheel_rates(meta["wheels"], *v), w, atol=1e-12)
