"""The film's camera leads in real Blender (skipped without one): over a whole-run capture, no lead or plug on a
camera's own body (or one welded to it) enters that camera's view frustum within 150 mm of its lens, the
USB leads keep their rest length, and a point 50 mm in front of each lens is caught.
A lead on another link (the arm a camera looks at) may be seen. tools/tests/ui/cable-frustum.test.mjs checks
the web copy the same way."""

from __future__ import annotations

import json
import os
import subprocess

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
RENDER = os.path.join(STUDIO, "tools", "render")
import blender as BL  # noqa: E402
import capture  # noqa: E402

CHECK = '''
import json, sys
from types import SimpleNamespace
import numpy as np
sys.path.insert(0, %(blender)r)
import build as BUILD, cables as CAB, pose
cap, NEAR = %(cap)r, 0.15
B = BUILD.Build(SimpleNamespace(cap=cap, decor=%(decor)r, looks=%(looks)r))
P = CAB.Parts(B)
A = CAB.anchors(P)
RC = np.load(cap + "/capture.npz")["robot_cameras"]
cams = B.cap["robot_cameras"]
body_of = {k: v["body"] for k, v in json.load(open(%(scene)r))["cameras"].items()}

def rows(body):
    n = next(n for n in P.g if P.body(n) == body)
    X = B.rows(P.g[n])
    return X[:, 0:3], CAB.quats(X[:, 3:7])

def welded(body):
    p0, R0 = rows(body)
    out = set()
    for b in {P.body(n) for n in P.g}:
        p, R = rows(b)
        rel = np.einsum("nji,njk->nik", R0, R)
        off = np.einsum("nji,nj->ni", R0, p - p0)
        if np.abs(rel - rel[0]).max() < 1e-5 and np.abs(off - off[0]).max() < 1e-6:
            out.add(b)
    return out

def pose_mats(Q):
    return np.stack([pose.quat_mat(q) for q in Q])

def basis(n, m):
    """[m, n] weights of a clamped uniform cubic B-spline (Blender's endpoint NURBS, order 4)"""
    p = min(3, n - 1); span = n - p; out = np.zeros((m, n))
    kn = lambda i: min(max(i - p, 0), span)
    for s in range(m):
        u = span * s / (m - 1); k = min(int(u) + p, n - 1)
        d = [np.eye(n)[j + k - p] for j in range(p + 1)]
        for r in range(1, p + 1):
            for j in range(p, r - 1, -1):
                i = j + k - p; a0, a1 = kn(i), kn(i + p - r + 1)
                a = (u - a0) / (a1 - a0) if a1 > a0 else 0.0
                d[j] = (1 - a) * d[j - 1] + a * d[j]
        out[s] = d[p]
    return out

def span_bodies(kb, m):
    """per sample: the bodies of the knots that shape it"""
    n = len(kb); p = min(3, n - 1)
    ks = [min(int((n - p) * s / (m - 1)) + p, n - 1) for s in range(m)]
    return [set(x for j in range(k - p, k + 1) for x in kb[j]) for k in ks]

def leads(A):
    """per lead: [F, S, 3] points (the tube's centre, then the far plug), their bodies and radii"""
    out = []
    for k, c in enumerate(B.table["cables"]):
        S, sock, turn, T = CAB.lead(P, A, c)
        n, m = T.shape[1], 8 * (T.shape[1] - 1) + 1
        C = np.einsum("sk,fkc->fsc", basis(n, m), T)
        L, w, t = CAB.plug_dims(c["d_mm"] * 0.001, CAB.plug_sizes(c)[1])
        pts = [sock[0], sock[0] + sock[1] * 2 * L] + ([S[-1][0]] if turn is not None else [])
        Q = np.stack([P.ride(sock[2], q) for q in pts], 1)
        far = c["via"][-1]
        out.append(dict(k=k, far=far if isinstance(far, str) else "", C=np.concatenate([C, Q], 1), m=m,
                        bodies=span_bodies(CAB.knot_bodies(P, T), m) + [{P.body(sock[2])}] * len(pts),
                        r=np.array([c["d_mm"] * 0.0005] * m + [float(np.hypot(w, t))] * len(pts))))
    return out

def hits(D):
    """{"camera|lead": frames, closest mm} of the points on a camera's own bodies in its near frustum"""
    res = {}
    for ci, cm in enumerate(cams):
        own = welded(body_of[cm["name"]])
        tv = np.tan(np.radians(cm["fovy"]) / 2); th = tv * 4 / 3
        for Ld in D:
            mask = np.array([bool(b & own) for b in Ld["bodies"]])
            if not mask.any():
                continue
            r = Ld["r"][mask]
            for f in range(len(RC)):
                o, R = RC[f, ci, :3], pose.quat_mat(RC[f, ci, 3:7])
                Q = (Ld["C"][f, mask] - o) @ R
                dep, d = -Q[:, 2], np.linalg.norm(Q, axis=1)
                inn = ((dep > -r) & (np.abs(Q[:, 0]) - dep * th <= r * np.hypot(1, th)) &
                       (np.abs(Q[:, 1]) - dep * tv <= r * np.hypot(1, tv)) & (d <= NEAR + r))
                if inn.any():
                    h = res.setdefault("%%s|%%d" %% (cm["name"], Ld["k"]), dict(frames=0, mm=1e9))
                    h["frames"] += 1
                    h["mm"] = min(h["mm"], float(d[inn].min() * 1000))
    return res

new = leads(A)
stretch = {}
for Ld in new:
    if Ld["far"].startswith("@cam_"):
        ln = np.linalg.norm(np.diff(Ld["C"][:, :Ld["m"]], axis=1), axis=2).sum(1)
        stretch[Ld["far"]] = [float(ln.min() / ln[0]), float(ln.max() / ln[0])]
probe = [dict(k=-1 - ci, C=(RC[:, ci, :3] + np.einsum("nij,j->ni", pose_mats(RC[:, ci, 3:7]), [0.0, 0.0, -0.05]))[:, None],
              bodies=[{body_of[cm["name"]]}], r=np.array([0.002])) for ci, cm in enumerate(cams)]
print("RESULT " + json.dumps(dict(new=hits(new), probe=hits(probe), stretch=stretch, frames=len(RC),
                                  cams=sorted(k for k in A if k.startswith("cam_")))))
'''


@pytest.mark.blender
def test_camera_leads_stay_out_of_their_own_view(lab, tmp_path):
    try:
        BL.find_blender()
    except SystemExit as e:
        pytest.skip(str(e))
    cap = str(tmp_path / "cap")
    capture.write(cap, *capture.capture(lab, os.path.join(lab, "ctrl.f32"), fps=6, sub=1))
    models = json.load(open(os.path.join(RENDER, "models.json")))
    models["models"] = [m for m in models["models"] if m["model"] in ("robot_dress", "robot_kit")]
    (tmp_path / "models.json").write_text(json.dumps(models))
    blend = str(tmp_path / "lab.blend")
    assert BL.run("build", ["--cap", cap, "--out", blend, "--models", str(tmp_path / "models.json")]) == 0
    (tmp_path / "check.py").write_text(CHECK % dict(
        blender=os.path.join(RENDER, "blender"), cap=cap, scene=os.path.join(lab, "scene.json"),
        decor=os.path.join(STUDIO, "assets", "scenes", "lab", "decor.json"), looks=os.path.join(RENDER, "looks.json")))
    r = subprocess.run(BL.command(str(tmp_path / "check.py"), [], blend, timeout=900), capture_output=True, text=True,
                       timeout=3600)
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-2000:]
    res = json.loads(next(ln for ln in r.stdout.splitlines() if ln.startswith("RESULT "))[7:])
    assert res["cams"] == ["cam_base", "cam_front", "cam_wroll"] and res["frames"] > 300, res
    assert res["new"] == {}, res["new"]                        # "<camera>|<lead>": frames, closest mm
    assert sorted(res["probe"]) == ["front|-1", "top|-3", "wrist|-2"], res["probe"]   # 50 mm in front of each lens
    for far, (lo, hi) in res["stretch"].items():               # no taut or stretched lead through a joint
        assert lo > 0.98 and hi < 1.15, (far, lo, hi)
