"""capture.py records exactly the scene video.py draws (after its posers and effects), its subframes land on
the integer frames, and a mesh geom's asset offset gives back the decor item frame."""

from __future__ import annotations

import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
RENDER = os.path.join(STUDIO, "tools", "render")
import capture  # noqa: E402
import pose  # noqa: E402
import video  # noqa: E402

SAMPLES = (0, 390, 870, 1500, 1740)        # start, the carry, the incubator lid, the reader run
UPTO = (max(SAMPLES) + 1) / 30              # s: both runs stop after the last sample


def fake_video(monkeypatch, lab, frames):
    """run video.render with the GL renderer and the encoder swapped for recorders; returns
    {frame: (geom ids, rows, camera [lookat, az, el, dist], scene matrices)} of the main view"""
    import mujoco

    seen = {}

    class Renderer:
        made = []

        def __init__(self, m, h, w, max_geom=10000):
            self.m, self.scene, self.calls = m, mujoco.MjvScene(m, maxgeom=max_geom), 0
            self.pert, self.cam = mujoco.MjvPerturb(), None
            Renderer.made.append(self)

        def update_scene(self, d, camera=-1, scene_option=None):
            cam = camera
            if not isinstance(camera, mujoco.MjvCamera):
                cam = mujoco.MjvCamera()
                if isinstance(camera, str):
                    cam.type, cam.fixedcamid = mujoco.mjtCamera.mjCAMERA_FIXED, self.m.camera(camera).id
            mujoco.mjv_updateScene(self.m, d, scene_option or mujoco.MjvOption(), self.pert, cam,
                                   mujoco.mjtCatBit.mjCAT_ALL, self.scene)
            self.cam = cam

        def render(self):
            j, self.calls = self.calls - 1, self.calls + 1          # call 0 is the warm-up frame
            if self is Renderer.made[0] and j in frames:
                c = self.cam
                mats = np.array([self.scene.geoms[k].mat for k in range(self.scene.ngeom)
                                 if self.scene.geoms[k].objtype == mujoco.mjtObj.mjOBJ_GEOM]).reshape(-1, 3, 3)
                seen[j] = (*capture.scene_rows(mujoco, self.scene), [*c.lookat, c.azimuth, c.elevation, c.distance], mats)
            return np.zeros((1, 1, 3), np.uint8)

        def close(self):
            pass

    class Encoder:
        def __init__(self, cmd, stdin=None):
            open(cmd[-1], "wb").close()
            self.stdin, self.returncode = self, 0

        def write(self, b):
            pass

        def close(self):
            pass

        def wait(self):
            return 0

    monkeypatch.setenv("MUJOCO_GL", "egl")
    monkeypatch.setenv("PYOPENGL_PLATFORM", "egl")
    monkeypatch.setattr(mujoco, "Renderer", Renderer)
    monkeypatch.setattr(video, "gl_backend", lambda: "egl")
    monkeypatch.setattr(video, "ffmpeg_exe", lambda: "ffmpeg")
    monkeypatch.setattr(video.subprocess, "Popen", Encoder)
    monkeypatch.setattr(video.Layout, "compose", lambda self, *a, **k: np.zeros(1, np.uint8))
    video.render(lab, os.path.join(lab, "ctrl.f32"), 30, (1920, 1080), os.path.join(lab, "fake.mp4"), UPTO)
    return seen


def test_capture_is_the_video_scene(lab, monkeypatch):
    import videocam
    # both runs share the Director; its sight-line rays (most of the run time) are left out of both
    monkeypatch.setattr(videocam.Director, "_blocked", lambda self, d, eye, pts, sid: 0)
    seen = fake_video(monkeypatch, lab, SAMPLES)
    assert sorted(seen) == list(SAMPLES)
    L = video.Layout(1920, 1080)
    doc, Z, _ = capture.capture(lab, os.path.join(lab, "ctrl.f32"), fps=30, sub=2, seconds=UPTO, aspect=L.mw / 1080)
    assert doc["schema"] == "rps/capture@1" and doc["sub"] == 2 and doc["frames"] > max(SAMPLES)
    assert Z["track"].shape == (2 * doc["frames"], len(Z["moving"]), 17) and Z["track"].dtype == np.float32
    assert [g["id"] for g in doc["geoms"]] == seen[0][0]
    mov = np.zeros(len(doc["geoms"]), bool)
    mov[Z["moving"]] = True
    assert mov.sum() > 100 and all(g["moving"] == mov[g["i"]] for g in doc["geoms"])
    plane = np.array([g["type"] == "plane" for g in doc["geoms"]])
    assert plane.sum() == 1 and not mov[plane].any()     # stored at its model pose, not under the camera
    for f in SAMPLES:
        ids, rows, cam, _ = seen[f]
        assert ids == seen[0][0]
        rows[plane] = Z["first"][plane]
        # moving geoms bit-exact in float32; static ones are frame0's float64 rows
        assert np.array_equal(Z["track"][2 * f], rows[mov].astype(np.float32)), "frame %d moving rows" % f
        assert np.array_equal(Z["first"][~mov], rows[~mov]), "frame %d static rows" % f
        assert np.array_equal(Z["camera"][2 * f, :6], cam), "frame %d camera" % f
    assert np.all(np.diff(Z["t"]) >= 0)
    # the shear split: a liquid column's scene matrix comes back from R and (sx, sy)
    _, rows, _, mats = seen[390]
    liq = next(g["i"] for g in doc["geoms"] if g["name"] == "puck_1_liquid_1")
    Sh = np.array([[1, 0, 0], [0, 1, 0], [rows[liq, 7], rows[liq, 8], 1]])
    assert "shear" in doc["geoms"][liq]["channels"] and abs(rows[liq, 7]) + abs(rows[liq, 8]) > 1e-4
    assert np.abs(pose.quat_mat(rows[liq, 3:7]) @ Sh - mats[liq]).max() < 1e-6


def test_subframes_hold_the_frames(lab):
    ctrl = os.path.join(lab, "ctrl.f32")
    d1, z1, _ = capture.capture(lab, ctrl, fps=30, sub=1, t0=12.0, seconds=1.0)
    d4, z4, _ = capture.capture(lab, ctrl, fps=30, sub=4, t0=12.0, seconds=1.0)
    assert d1["frames"] == d4["frames"] == 30 and d1["frame0"] == d4["frame0"] == 360
    assert len(z4["t"]) == 120 and np.all(np.diff(z4["t"]) > 0)
    for i in (0, 11, 29):
        a, b = capture.frame_rows(d1, z1, i), capture.frame_rows(d4, z4, 4 * i)
        assert np.array_equal(a.astype(np.float32), b.astype(np.float32)), "frame %d" % i
        assert np.array_equal(z1["camera"][i], z4["camera"][4 * i])
    # subframe cameras interpolate between the frames (azimuth the short way)
    c = z4["camera"]
    assert np.allclose(c[1, :3], c[0, :3] + (c[4, :3] - c[0, :3]) / 4)
    assert np.array_equal(c[-3:], np.repeat(c[-4:-3], 3, 0))


def test_asset_offset_gives_the_item_frame(lab):
    """world = F . asset, with F = pose.item_pose(geom pose, meshes.npz o<id>) and asset = the .msh file"""
    doc, Z, M = capture.capture(lab, os.path.join(lab, "ctrl.f32"), fps=30, sub=1, seconds=0.2)
    for name in ("decor_inc_body", "decor_inc_lid", "decor_nest_8", "decor_reader_hood"):
        g = next(g for g in doc["geoms"] if g["mesh"] == name)
        raw = open(os.path.join(lab, "meshes", name + ".msh"), "rb").read()
        nv = int(np.frombuffer(raw[:4], np.int32)[0])
        asset = np.frombuffer(raw[16:16 + 12 * nv], np.float32).reshape(-1, 3).astype(np.float64) * 0.001
        row = Z["first"][g["i"]]
        world = M["v%d" % g["mesh_id"]].astype(np.float64) @ pose.quat_mat(row[3:7]).T + row[0:3]
        p, q = pose.item_pose(row[0:3], row[3:7], M["o%d" % g["mesh_id"]])
        assert np.abs(asset @ pose.quat_mat(q).T + p - world).max() < 1e-6, name
