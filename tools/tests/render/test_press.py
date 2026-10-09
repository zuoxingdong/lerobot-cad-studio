"""press.planes: two covers closed past their touch are clamped at the mid-plane, EPS short of it, in each cover's
own (rotated, scaled) frame; covers apart get no plane.  The page's twin, robot-look.js coverPress, finds the same
planes (node runs it)."""

from __future__ import annotations

import json
import os
import subprocess

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
import press  # noqa: E402


def box(lo, hi, n=6):
    g = [np.linspace(a, b, n) for a, b in zip(lo, hi)]
    return np.stack(np.meshgrid(*g), -1).reshape(-1, 3)


def pose(t, ang=0.0, s=1.0):
    c, k = np.cos(ang), np.sin(ang)
    M = np.eye(4)
    M[:3, :3] = s * np.array([[c, -k, 0], [k, c, 0], [0, 0, 1]])
    M[:3, 3] = t
    return M


def clamp(V, u, w):
    return V - u * np.maximum(V @ u - w, 0)[:, None]


def test_closed_covers_meet_short_of_the_mid_plane():
    VA = box((-0.006, -0.004, -0.01), (0.006, 0.004, 0.01))           # metres, a 12 mm wide tip
    VB = box((-6.0, -4.0, -10.0), (6.0, 4.0, 10.0))                   # the same in mm, scaled to metres
    gaps = (0.008, 0.03, 0.05)                                         # centres apart: crossing, then clear
    MA = np.stack([pose((0, 0, 0), 0.3) for _ in gaps])
    MB = np.stack([pose((g, 0.001, 0), -0.2, 0.001) for g in gaps])
    uA, wA, uB, wB, on = press.planes(VA, VB, MA, MB)
    assert on.tolist() == [True, False, False]
    assert (wA[1:] == press.FAR).all() and (wB[1:] == press.FAR).all()
    WA = (MA[0, :3, :3] @ clamp(VA, uA[0], wA[0]).T).T + MA[0, :3, 3]
    WB = (MB[0, :3, :3] @ clamp(VB, uB[0], wB[0]).T).T + MB[0, :3, 3]
    ca, cb = (MA[0, :3, :3] @ VA.mean(0) + MA[0, :3, 3]), (MB[0, :3, :3] @ VB.mean(0) + MB[0, :3, 3])
    n = (cb - ca) / np.linalg.norm(cb - ca)
    gap = (WB @ n).min() - (WA @ n).max()
    assert abs(gap - 2 * press.EPS) < 1e-9, gap                       # flat faces 0.1 mm apart
    hA, hB = (((MA[0, :3, :3] @ VA.T).T + MA[0, :3, 3]) @ n).max(), (((MB[0, :3, :3] @ VB.T).T + MB[0, :3, 3]) @ n).min()
    assert abs((WA @ n).max() - ((hA + hB) / 2 - press.EPS)) < 1e-9
    assert np.allclose(np.linalg.norm(uA, axis=1), 1) and np.allclose(np.linalg.norm(uB, axis=1), 1)


def test_frames_are_batched():
    V = box((-1, -1, -1), (1, 1, 1), 3) * 0.005
    F = press.CHUNK * 2 + 7
    MA = np.stack([pose((0, 0, 0)) for _ in range(F)])
    MB = np.stack([pose((0.0095 if i % 2 else 0.02, 0, 0)) for i in range(F)])
    on = press.planes(V, V, MA, MB)[4]
    assert on.tolist() == [bool(i % 2) for i in range(F)]


PAGE = r"""
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fabric, coverPress, PRESS_EPS } from './src/ui/robot-look.js';
const [VA, VB, MA, MB] = process.argv.slice(1).map((a) => JSON.parse(a));
const lib = JSON.parse(readFileSync('tools/render/looks.json', 'utf8')).library;
const mesh = (V) => {
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(V.flat()), 3));
  const o = new THREE.Mesh(g, fabric(new THREE.MeshPhysicalMaterial(), lib.nitrile_coat, new THREE.Matrix4()));
  o.matrixAutoUpdate = false;
  return o;
};
const A = mesh(VA), B = mesh(VB), press = coverPress([{ mesh: A, key: 'a' }, { mesh: B, key: 'b' }], PRESS_EPS);
const plane = (o) => { const P = THREE.ShaderLib.physical, sh = { uniforms: {}, vertexShader: P.vertexShader, fragmentShader: P.fragmentShader };
  o.material.onBeforeCompile(sh); return sh.uniforms.rpsPress.value.toArray(); };
const out = MA.map((ma, f) => {
  A.matrix.set(...ma.flat()); B.matrix.set(...MB[f].flat());
  press();
  return [plane(A), plane(B)];
});
console.log(JSON.stringify({ eps: PRESS_EPS, planes: out }));
"""


def test_the_page_finds_the_same_planes():
    """same verts (float32, as the page holds them), same poses: the same plane per cover, or none on both sides"""
    VA = box((-0.006, -0.004, -0.01), (0.006, 0.004, 0.01)).astype(np.float32).astype(float)
    VB = box((-5.0, -4.5, -9.0), (7.0, 4.0, 10.0)).astype(np.float32).astype(float)       # mm, posed at 1/1000
    gaps = (0.004, 0.008, 0.0115, 0.0121, 0.03)
    MA = np.stack([pose((0, 0.0005 * i, 0), 0.3 - 0.1 * i) for i, _ in enumerate(gaps)])
    MB = np.stack([pose((g, 0.001, 0.0002 * i), -0.2 + 0.05 * i, 0.001) for i, g in enumerate(gaps)])
    r = subprocess.run(["node", "--input-type=module", "-e", PAGE, *(json.dumps(x.tolist()) for x in (VA, VB, MA, MB))],
                       cwd=STUDIO, check=True, capture_output=True, text=True, timeout=120)
    page = json.loads(r.stdout)
    assert page["eps"] == press.EPS
    uA, wA, uB, wB, on = press.planes(VA, VB, MA, MB)
    assert on.sum() >= 2 and not on[-1], on                                     # crossing, and apart
    for f, (a, b) in enumerate(page["planes"]):
        if not on[f]:
            assert a[3] == b[3] == 1e9, (f, a, b)                                 # the page's "no plane"
            continue
        for got, u, w in ((a, uA[f], wA[f]), (b, uB[f], wB[f])):
            assert np.allclose(got[:3], u, atol=1e-9) and abs(got[3] - w) < 1e-9, (f, got, u, w)
