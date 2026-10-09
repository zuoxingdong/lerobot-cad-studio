"""rps/campath@1 maths: a track row gives MuJoCo's own free-camera eye, forward and up, and the Blender
camera quaternion looks down -Z along them; lens and quaternion helpers."""

from __future__ import annotations

import math
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
RENDER = os.path.abspath(os.path.join(HERE, "..", "..", "render"))
import campath  # noqa: E402
import capture  # noqa: E402
import pose  # noqa: E402

ROWS = [[0.0, 0.49, 0.25, 20.0, -24.0, 1.4, 45.0], [1.1, -0.3, 0.6, -135.0, -60.0, 2.5, 30.0],
        [-0.7, 0.2, 0.1, 179.0, 10.0, 0.8, 60.0], [0.2, 0.1, 0.3, 90.0, -89.0, 3.0, 45.0]]


def test_rows_match_the_mujoco_free_camera():
    import mujoco

    m = mujoco.MjModel.from_xml_string("<mujoco><worldbody><geom type='plane' size='1 1 1'/></worldbody></mujoco>")
    d = mujoco.MjData(m)
    mujoco.mj_forward(m, d)
    scn, opt, pert = mujoco.MjvScene(m, maxgeom=10), mujoco.MjvOption(), mujoco.MjvPerturb()
    for row in ROWS:
        cam = mujoco.MjvCamera()
        cam.lookat[:], cam.azimuth, cam.elevation, cam.distance = row[:3], row[3], row[4], row[5]
        mujoco.mjv_updateScene(m, d, opt, pert, cam, mujoco.mjtCatBit.mjCAT_ALL, scn)
        eye, right, up, fwd = campath.basis(row)
        gl = scn.camera[0]
        head = (np.asarray(scn.camera[0].pos) + scn.camera[1].pos) / 2       # the two eyes sit +-ipd/2 apart
        assert np.allclose(eye, head, atol=1e-6) and np.allclose(fwd, gl.forward, atol=1e-6)
        assert np.allclose(up, gl.up, atol=1e-6)
        _, q = campath.pose(row)
        R = pose.quat_mat(q)
        assert np.allclose(R @ [0, 0, -1], fwd, atol=1e-9) and np.allclose(R @ [0, 1, 0], up, atol=1e-9)
        assert abs(np.linalg.norm(q) - 1) < 1e-12 and q[0] >= 0


def test_lens_and_track():
    assert abs(campath.lens_mm(45.0) - 12 / math.tan(math.radians(22.5))) < 1e-12
    for lens in (24.0, 50.0, 85.0):             # fovy = 2 atan(12 / lens) for a 24 mm-high frame
        assert abs(campath.lens_mm(math.degrees(2 * math.atan(12 / lens))) - lens) < 1e-9
    P, Q, D, L = campath.track(np.array(ROWS))
    assert P.shape == (4, 3) and Q.shape == (4, 4) and np.array_equal(D, [r[5] for r in ROWS]) and len(L) == 4
    assert all(Q[i] @ Q[i - 1] >= 0 for i in range(1, 4))


def test_quaternion_helpers():
    rng = np.random.default_rng(3)
    for _ in range(50):
        q = rng.normal(size=4)
        q /= np.linalg.norm(q)
        q = q if q[0] >= 0 else -q
        assert np.allclose(pose.mat_to_quat(pose.quat_mat(q)), q, atol=1e-9)
        p = rng.normal(size=4)
        p /= np.linalg.norm(p)
        assert np.allclose(pose.quat_mat(pose.quat_mul(q, p)), pose.quat_mat(q) @ pose.quat_mat(p), atol=1e-9)
    # the item frame: asset = R_o v + p_o, so F . asset = G . v for every v
    off = np.array([0.1, -0.2, 0.3, *(q := np.array([0.9, 0.1, -0.3, 0.2]) / np.linalg.norm([0.9, 0.1, -0.3, 0.2]))])
    g_pos, g_q = np.array([1.0, 0.49, 0.277]), np.array([0.7071067811865476, 0, 0, -0.7071067811865476])
    V = rng.normal(size=(20, 3))
    asset = V @ pose.quat_mat(off[3:]).T + off[:3]
    p, fq = pose.item_pose(g_pos, g_q, off)
    assert np.allclose(asset @ pose.quat_mat(fq).T + p, V @ pose.quat_mat(g_q).T + g_pos, atol=1e-12)


def test_subframe_camera_takes_the_short_way():
    C = np.zeros((8, 7))
    C[:4, 3], C[4:, 3] = 170.0, -170.0          # +20 degrees across the seam, not -340
    C[4:, 5] = 2.0
    out = capture.lerp_camera(C, 4)
    assert np.allclose(out[1:4, 3], [175.0, 180.0, 185.0]) and np.allclose(out[1:4, 5], [0.5, 1.0, 1.5])
    assert np.array_equal(out[5:], np.repeat(out[4:5], 3, 0))
