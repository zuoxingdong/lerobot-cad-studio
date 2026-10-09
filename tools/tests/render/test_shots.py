"""rps/campath@1 shots: easing, time refs, the low-pass, determinism (subframe calls never change a frame),
cuts that hold across subframes, the capture's camera = the GL draft's, and the edit's tracks."""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
RENDER = os.path.join(STUDIO, "tools", "render")
FILM = os.path.join(RENDER, "film")
import campath  # noqa: E402
import capture  # noqa: E402
import videoedit as VE  # noqa: E402
import videoshots as VS  # noqa: E402

SHOTS = os.path.join(RENDER, "shots.json")
ART = ("establish", "grasp", "carry", "insert", "incubate", "repick", "transit", "place_reader", "read", "learn")
RUN = {"timestep": 0.002, "phases": [{"phase": "a", "step_start": 0, "step_end": 500}, {"phase": "grasp_x", "step_start": 500, "step_end": 900}],
       "outcome": {"instrument_events": [{"station": "inc", "state": "running", "t": 1.25}]}}


def test_ease_is_a_trapezoid():
    for e in (0.0, 0.2, 0.35, 0.5):
        u = np.linspace(0, 1, 2001)
        y = np.array([VS.ease(x, e) for x in u])
        assert y[0] == 0 and abs(y[-1] - 1) < 1e-12 and np.all(np.diff(y) >= -1e-15)
        v = np.diff(y) / np.diff(u)
        assert abs(v.max() - 1 / (1 - e)) < 2e-3 and np.abs(np.diff(v)).max() < 0.02      # continuous speed
    assert VS.ease(-1, 0.3) == 0 and VS.ease(2, 0.3) == 1


def test_time_refs():
    T = VS.Times(RUN)
    assert T(3) == 3.0 and T("a") == 0.0 and T("a.end") == 1.0 and T("grasp_x+0.5") == 1.5 and T("grasp_x - 0.25") == 0.75
    assert T("inc:running") == 1.25 and T("end") == 1.8 and T.phase_at(1.2) == "grasp_x"
    for bad in ("nope", "a+x", "inc:closing"):
        with pytest.raises(ValueError):
            T(bad)


def test_lens_is_the_contract_convention():
    for lens in (28.0, 35.0, 50.0, 85.0, 100.0):
        f = VS.fovy_deg(lens)
        assert abs(f - math.degrees(2 * math.atan(12 / lens))) < 1e-12 and abs(campath.lens_mm(f) - lens) < 1e-9


CARDS = {"title": {"s": 3.0, "title": "T", "sub": "a subtitle"}, "end": {"s": 4.0, "title": "T", "notes": ["n"]}}
INC = {"stations": [{"id": "inc", "cycle": {"run": 4}}]}


def test_card_text_fades_and_meets_black():
    E = VE.Edit({"cards": CARDS}, RUN, INC, 640, 360, 30)

    def peak(which, j):
        return int(E.card(which, j).max())
    for which, n in (("title", 90), ("end", 120)):
        lv = [peak(which, j) for j in range(n)]
        full = max(lv)
        assert full > 200 and lv[0] < 60 and lv[-1] <= 2                  # no text pop in, black at the join
        i = lv.index(full)
        assert all(a <= b + 1 for a, b in zip(lv[:i], lv[1:i + 1]))       # the text ramps up ...
        assert all(a >= b - 1 for a, b in zip(lv[i:], lv[i + 1:]))       # ... and down, never a jump
        assert max(abs(a - b) for a, b in zip(lv, lv[1:])) < 40
    bg, a = E.card_alpha("end", 0.0)
    assert bg == 0 and a == 0 and E.card_alpha("title", 1.5) == (1.0, 1.0)


def test_clock_shows_the_compressed_rate():
    E = VE.Edit({}, RUN, INC, 640, 360, 30, cards=False)
    assert E.stamp(1.0) == "01.00 s  ·  1×" and E.stamp(1.25) == "01.25 s  ·  ×450"
    assert E.stamp(5.2) == "05.20 s  ·  ×450" and E.stamp(5.25) == "05.25 s  ·  1×"
    assert VE.Edit({}, {"timestep": 0.002}, None, 640, 360, 30).stamp(3.0) == "03.00 s  ·  1×"


def test_repo_shots_follow_the_art_direction(lab):
    import mujoco

    run, meta = (json.load(open(os.path.join(lab, f))) for f in ("report.json", "scene.json"))
    S = VS.Shots(meta, SHOTS, run, mujoco.MjModel.from_xml_path(os.path.join(lab, "scene.xml")))
    ids = [s.id for s in S.shots]
    assert all(a in ids for a in ART) and S.lint() == []
    assert all(b.t0 > a.t0 for a, b in zip(S.shots, S.shots[1:])) and S.shots[0].t0 == 0
    E = VE.Edit(json.load(open(SHOTS)), run, meta["lab"])
    starts = [s.t0 for s in S.shots]
    for a, b, cam in E.pips:                    # an inset never spans a cut
        assert cam in ("front", "wrist", "top") and S.index(a) == S.index(b - 1e-6), (a, b, cam)
    inc = next(c for c in E.caps if c[4] == "incubation")      # the one compression is captioned throughout
    t_run = S.times("inc:running")
    cycle = next(s for s in meta["lab"]["stations"] if s["id"] == "inc")["cycle"]
    assert inc[0] <= t_run and inc[1] >= t_run + cycle["run"] and "×450" in inc[3].format(**E.vars)
    assert E.clock(t_run) == "modelled time 00:00 / 30:00" and E.clock(t_run + 4.0) == "modelled time 30:00 / 30:00"
    assert len(starts) == len(set(starts))


def replay(lab, seconds, calls):
    """run the lab for `seconds`; per frame call calls(shots, d, t, frame index); returns the Shots"""
    import mujoco

    run, meta = (json.load(open(os.path.join(lab, f))) for f in ("report.json", "scene.json"))
    m = mujoco.MjModel.from_xml_path(os.path.join(lab, "scene.xml"))
    d = mujoco.MjData(m)
    mujoco.mj_forward(m, d)
    ctrl = np.fromfile(os.path.join(lab, "ctrl.f32"), "<f4").reshape(-1, m.nu)
    S, k = VS.Shots(meta, SHOTS, run, m), 0
    for i in range(int(seconds * 30)):
        while k < int(round(i / (30 * 0.002))):
            d.ctrl[:] = ctrl[k]
            mujoco.mj_step(m, d)
            k += 1
        calls(S, d, k * 0.002, i)
    return S


def test_subframe_calls_never_change_the_frames(lab):
    plain, mixed = [], []

    def a(S, d, t, i):
        S.camera(d, t)
        plain.append(S.row() + list(S.optics))

    def b(S, d, t, i):
        S.camera(d, t + 0.004, commit=False)
        S.camera(d, t)
        mixed.append(S.row() + list(S.optics))
        S.camera(d, t + 0.008, shot_t=t + 1 / 30, commit=False)
    replay(lab, 14.0, a)
    replay(lab, 14.0, b)
    assert np.array_equal(plain, mixed)                        # deterministic, and commit=False is read-only


def test_mounted_anchors_low_pass():
    class D:
        xpos = np.zeros((2, 3))

    class M:
        def body(self, n):
            return type("B", (), {"id": 1})()
    S = VS.Shots.__new__(VS.Shots)
    S.A, S.lp, S.tau = VS.Anchors.__new__(VS.Anchors), {}, 0.5
    S.A.m, S.A.fixed = M(), {}
    d = D()
    S._anchor("base", d, 0.0, True)
    d.xpos[1] = [1.0, 0, 0]
    assert abs(S._anchor("base", d, 0.5, False)[0][0] - (1 - math.exp(-1))) < 1e-12
    assert S.lp["base"][1][0] == 0.0                             # a read did not advance it
    assert abs(S._anchor("base", d, 0.5, True)[0][0] - (1 - math.exp(-1))) < 1e-12


def test_capture_camera_is_the_draft_camera_and_holds_across_cuts(lab):
    frames = []

    def rec(S, d, t, i):
        S.camera(d, t)
        frames.append((S.row(), S.shot.id))
    replay(lab, 13.5, rec)
    doc, Z, _ = capture.capture(lab, os.path.join(lab, "ctrl.f32"), 30, 4, 12.5, 1.0, 16 / 9, SHOTS)
    f0, sub = doc["frame0"], doc["sub"]
    C, Op, R = Z["camera"], Z["optics"], Z["robot_cameras"]
    assert doc["camera"]["source"] == "shots" and Op.shape == (len(C), 3) and R.shape == (len(C), 3, 7)
    assert [c["name"] for c in doc["robot_cameras"]] == ["front", "wrist", "top"]
    assert np.allclose(np.linalg.norm(R[..., 3:], axis=-1), 1)
    assert np.array_equal(C[::sub], np.array([r for r, _ in frames[f0:f0 + len(C) // sub]]))
    cut = next(i for i in range(f0 + 1, len(frames)) if frames[i][1] != frames[i - 1][1])      # carry at 12.77 s
    j = (cut - 1 - f0) * sub
    step = np.abs(np.diff(C[j:j + sub + 1, :3], axis=0)).max(1)
    assert step[1] > 0.1 and step[0] < 0.01 and step[2:].max() < 0.01          # the jump sits between .25 and .5


def test_edit_is_deterministic(lab):
    run = json.load(open(os.path.join(lab, "report.json")))
    E = VE.Edit(json.load(open(SHOTS)), run, None, 640, 360, 30)
    rng = np.random.default_rng(0)
    img, pip = (rng.integers(0, 255, s, np.uint8) for s in ((360, 640, 3), (480, 640, 3)))
    a, b, c = E.compose(img, 9.0, 5, ("wrist", pip)), E.compose(img, 9.0, 5, ("wrist", pip)), E.compose(img, 9.0, 6, ("wrist", pip))
    assert a.shape == (360, 640, 3) and np.array_equal(a, b) and not np.array_equal(a, c)     # grain per frame
    w = VE.webcam(pip, "front", 3.0, 1)
    assert w.shape == (480, 640, 3) and np.array_equal(w, VE.webcam(pip, "front", 3.0, 1))
    assert E.card("title", 45).shape == (360, 640, 3)


def test_overlay_text_fades_with_its_layer(lab):
    """the inset tag and the caption text carry the inset / caption opacity (no text without its chip)"""
    run = json.load(open(os.path.join(lab, "report.json")))
    E = VE.Edit(json.load(open(SHOTS)), run, None, 1920, 1080, 30, look=False, cards=False)
    a, _, cam = E.pips[0]
    img, pip = np.full((1080, 1920, 3), 200, np.uint8), (cam, np.full((480, 640, 3), 60, np.uint8))
    x, y = E.pip_xy

    def tag(t):
        return 200 - E.compose(img, t, 0, pip)[y + 12:y + 30, x + 18:x + 70].min()
    assert tag(a + 0.02) < 0.1 * tag(a + 1.0) and tag(a + 0.1) < 0.5 * tag(a + 1.0)
    c0 = E.caps[1][0]

    def text(t):
        return int(E.compose(img, t, 0, None)[1080 - 150:1080 - 96, 96:600].max())
    assert text(c0 + 0.02) <= 200 < text(c0 + 1.0)


@pytest.mark.gl
def test_video_campath_draft(lab, tmp_path):
    import video

    try:
        video.gl_backend()
    except SystemExit as e:
        pytest.skip(str(e))
    mp4 = str(tmp_path / "draft.mp4")
    subprocess.run([sys.executable, os.path.join(FILM, "video.py"), lab, "--campath", SHOTS, "--seconds", "1", "--size", "640x360",
                    "--mp4", mp4], check=True, capture_output=True, timeout=300)
    T = np.load(str(tmp_path / "draft_track.npy"))
    assert os.path.getsize(mp4) > 10000 and T.shape == (30, 10)
