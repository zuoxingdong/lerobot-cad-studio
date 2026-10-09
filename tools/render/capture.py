#!/usr/bin/env python3
"""Replay a ctrl log natively and record every drawn geom per (sub)frame after video.py's posers and
effects, plus the camera track (rps/capture@1). Runs in the uv sim env.

    capture.py <export dir> [--ctrl f] [--fps 30] [--sub 4] [--t0 s] [--seconds s] [--aspect 16/9]
               [--campath shots.json] --dst dir

--campath evaluates videoshots.Shots on every subframe (plus `optics`); the robot cameras' poses are
always kept (`robot_cameras`, MuJoCo's camera frame: -Z forward, +Y up, as Blender's).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "film"))
import video as VID  # noqa: E402
import videocam as VC  # noqa: E402
import videofx as FX  # noqa: E402
import videopose as VP  # noqa: E402
import videoshots as VS  # noqa: E402

SCHEMA = "rps/capture@1"
ROW = "pos3 quat4(wxyz) shear2 size3 rgba4 emission1"
CHANNELS = (("pos", slice(0, 3)), ("quat", slice(3, 7)), ("shear", slice(7, 9)),
            ("size", slice(9, 12)), ("rgba", slice(12, 16)), ("emission", slice(16, 17)))
MOVE_EPS = 1e-7
SHEAR_EPS = 1e-6        # below it, a shear is float32 rotation noise


def split(M):
    """M = R @ [[1,0,0],[0,1,0],[sx,sy,1]] (videofx's liquid shear; 0 for a rotation), for [..., 3, 3]"""
    z = M[..., :, 2] / np.linalg.norm(M[..., :, 2], axis=-1, keepdims=True)
    sx, sy = np.einsum("...i,...i", M[..., :, 0], z), np.einsum("...i,...i", M[..., :, 1], z)
    R = np.stack([M[..., :, 0] - sx[..., None] * z, M[..., :, 1] - sy[..., None] * z, z], -1)
    U, _, Vt = np.linalg.svd(R)
    return U @ Vt, sx, sy


def scene_rows(mujoco, scn):
    """(geom ids in scene order, [G,17] rows) for the scene's geoms of type GEOM"""
    GEOM = mujoco.mjtObj.mjOBJ_GEOM
    gs = [scn.geoms[j] for j in range(scn.ngeom)]
    gs = [g for g in gs if g.objtype == GEOM]
    X = np.empty((len(gs), 17))
    M = np.array([g.mat for g in gs], float).reshape(-1, 3, 3)
    R, X[:, 7], X[:, 8] = split(M)
    X[:, 7:9][np.abs(X[:, 7:9]).max(1) < SHEAR_EPS] = 0.0
    for n, g in enumerate(gs):
        X[n, 0:3], X[n, 9:12], X[n, 12:16], X[n, 16] = g.pos, g.size, g.rgba, g.emission
        mujoco.mju_mat2Quat(X[n, 3:7], R[n].reshape(9))
    return [int(g.objid) for g in gs], X


def lerp_camera(C, sub):
    """fill subframe camera rows between integer frames (azimuth the short way); the last frame holds"""
    C = C.copy()
    n = len(C) // sub
    for i in range(n - 1):
        a, b = C[i * sub], C[(i + 1) * sub].copy()
        b[3] = a[3] + ((b[3] - a[3] + 180.0) % 360.0 - 180.0)
        for s in range(1, sub):
            C[i * sub + s] = a + (b - a) * (s / sub)
    C[(n - 1) * sub + 1:] = C[(n - 1) * sub]
    return C


def camera_source(mujoco, m, meta, fps, campath, run, aspect):
    if not campath:
        return VC.Director(mujoco, m, meta, fps)
    return VS.Shots(meta, campath, run, m, aspect=aspect, mujoco=mujoco)


def robot_cams(mujoco, m, meta):
    """[(name, camera id, fovy, near m)] of the robot's cameras (the inset views)"""
    names = [m.camera(i).name for i in range(m.ncam)]
    return [(c, names.index(c), float(m.cam_fovy[names.index(c)]), ((meta.get("cameras") or {}).get(c) or {}).get("near_mm", 10) / 1000)
            for c in VID.CAMS if c in names]


def capture(out, ctrl_path, fps=30, sub=1, t0=0.0, seconds=None, aspect=16 / 9, campath=None):
    """returns (capture.json doc, arrays for capture.npz, arrays for meshes.npz)"""
    import mujoco

    run = json.load(open(os.path.join(os.path.dirname(ctrl_path), "report.json"), encoding="utf-8"))
    meta = json.load(open(os.path.join(out, "scene.json"), encoding="utf-8"))
    if run.get("design_hash") != meta.get("design_hash"):
        raise SystemExit("capture: %s is a run of another model" % ctrl_path)
    m = mujoco.MjModel.from_xml_path(os.path.join(out, "scene.xml"))
    ctrl = np.fromfile(ctrl_path, dtype="<f4").reshape(-1, m.nu)
    d = mujoco.MjData(m)
    mujoco.mj_resetData(m, d)
    mujoco.mj_forward(m, d)
    opt = mujoco.MjvOption()
    opt.geomgroup[:] = VID.SHOW_GROUPS
    scn, pert = mujoco.MjvScene(m, maxgeom=20000), mujoco.MjvPerturb()
    lab = VP.lab_doc(meta)
    tl = VP.Timeline(lab, (run.get("outcome") or {}).get("instrument_events"))
    poser, fx = VP.Poser(mujoco, m, lab), FX.Effects(mujoco, m, meta)
    cams = camera_source(mujoco, m, meta, fps, campath, run, aspect)
    shots = isinstance(cams, VS.Shots)
    rcams, rc_rows, optics = robot_cams(mujoco, m, meta), [], []
    phase_at = [(p["step_start"], p["step_end"], p["phase"]) for p in run.get("phases", [])]
    dt = float(m.opt.timestep)
    steps = len(ctrl)
    total = int(math.floor(steps * dt * fps + 1e-9))
    f0 = int(round(t0 * fps))
    f1 = total if seconds is None else min(total, f0 + int(round(seconds * fps)))
    if f1 <= f0:
        raise SystemExit("capture: empty range (%d frames in the run)" % total)
    order, planes, first, dyn, rows, cam_rows, ts, k, cam = None, [], None, None, [], [], [], 0, None
    frame_t = lambda j: min(steps, int(round(j / (fps * dt)))) * dt  # noqa: E731
    for i in range(f1):
        for s in range(sub if i >= f0 else 1):
            want = min(steps, int(round((i + s / sub) / (fps * dt))))
            while k < want:
                d.ctrl[:] = ctrl[k]
                mujoco.mj_step(m, d)
                fx.step(d)
                k += 1
            st, loop = tl.at(k * dt)
            if s == 0:        # the camera spring steps once per frame, as in video.py
                phase = next((n for a, b, n in phase_at if a <= k < b), None)
                cam = cams.camera(d, k * dt) if shots else cams.update(d, phase, st, aspect)
            elif shots:         # a subframe takes the shot of its nearest frame, so blur never spans a cut
                cam = cams.camera(d, k * dt, shot_t=frame_t(i + (2 * s >= sub)), commit=False)
            if i < f0:
                continue
            mujoco.mjv_updateScene(m, d, opt, pert, cam, mujoco.mjtCatBit.mjCAT_ALL, scn)
            poser.apply(scn, st, loop, k * dt)
            fx.apply(scn, d, st)
            ids, row = scene_rows(mujoco, scn)
            if order is None:
                planes = [(n, g) for n, g in enumerate(ids) if m.geom_type[g] == mujoco.mjtGeom.mjGEOM_PLANE]
            for n, g in planes:     # mjv re-centres a plane under the previous camera: keep its model pose
                row[n, 0:3] = d.geom_xpos[g]
                mujoco.mju_mat2Quat(row[n, 3:7], d.geom_xmat[g])
            if order is None:
                order, first, dyn = ids, row, np.zeros(row.shape, bool)
            assert ids == order, "capture: the scene's geom order changed"
            dyn |= np.abs(row - first) > MOVE_EPS
            rows.append(row.astype(np.float32))
            fovy = float(getattr(cams, "fovy", VC.FOVY))
            cam_rows.append([*cam.lookat, cam.azimuth, cam.elevation, cam.distance, fovy])
            if shots:
                optics.append(cams.optics)
            q = np.zeros((len(rcams), 7))
            for n, (_, c, _, _) in enumerate(rcams):
                q[n, :3] = d.cam_xpos[c]
                mujoco.mju_mat2Quat(q[n, 3:], d.cam_xmat[c])
            rc_rows.append(q)
            ts.append(k * dt)
    moving = np.where(dyn.any(1))[0].astype(np.int32)
    track = np.stack([r[moving] for r in rows]) if len(moving) else np.zeros((len(rows), 0, 17), np.float32)
    camera = np.asarray(cam_rows, np.float64)
    if sub > 1 and not shots:
        camera = lerp_camera(camera, sub)
    T = {int(v): n.replace("mjGEOM_", "").lower() for n, v in mujoco.mjtGeom.__members__.items()}
    geoms, used = [], set()
    for gi, gid in enumerate(order):
        t = T[int(m.geom_type[gid])]
        mesh = int(m.geom_dataid[gid]) if t == "mesh" else -1
        if mesh >= 0:
            used.add(mesh)
        mat = int(m.geom_matid[gid])
        geoms.append(dict(i=gi, id=int(gid), name=m.geom(gid).name, body=m.body(int(m.geom_bodyid[gid])).name,
                          type=t, mesh=m.mesh(mesh).name if mesh >= 0 else None, mesh_id=mesh,
                          mat=m.material(mat).name if mat >= 0 else None, moving=bool(dyn[gi].any()),
                          channels=[c for c, sl in CHANNELS if dyn[gi, sl].any()]))
    meshes = {}
    for mid in sorted(used):
        va, nv, fa, nf = m.mesh_vertadr[mid], m.mesh_vertnum[mid], m.mesh_faceadr[mid], m.mesh_facenum[mid]
        meshes["v%d" % mid] = m.mesh_vert[va:va + nv].astype(np.float32)
        meshes["f%d" % mid] = m.mesh_face[fa:fa + nf].astype(np.int32)
        # asset = R(quat) . v + pos: the recentred mesh back to its file (decor item) frame
        meshes["o%d" % mid] = np.concatenate([m.mesh_pos[mid], m.mesh_quat[mid]]).astype(np.float64)
    mats = {m.material(i).name: dict(rgba=m.mat_rgba[i].tolist(), specular=float(m.mat_specular[i]),
                                     shininess=float(m.mat_shininess[i]), emission=float(m.mat_emission[i]))
            for i in range(m.nmat)}
    lights = [dict(name=m.light(i).name, pos=m.light_pos[i].tolist(), dir=m.light_dir[i].tolist(),
                   diffuse=m.light_diffuse[i].tolist(), shadow=bool(m.light_castshadow[i])) for i in range(m.nlight)]
    doc = dict(schema=SCHEMA, design_hash=meta.get("design_hash"), fps=fps, sub=sub, frame0=f0, frames=f1 - f0,
               t0=ts[0], units="m", row=ROW, camera=dict(row="lookat3 azimuth elevation distance fovy_deg",
                                                          aspect=aspect, source="shots" if campath else "director"),
               geoms=geoms, materials=mats, lights=lights, lab=lab,
               robot_cameras=[dict(name=c, fovy=f, near=z) for c, _, f, z in rcams])
    arrays = dict(first=first.astype(np.float64), moving=moving, track=track, camera=camera, t=np.asarray(ts),
                  robot_cameras=np.asarray(rc_rows, np.float64).reshape(len(ts), len(rcams), 7))
    if shots:           # focus distance m, f-stop, lens mm (rps/campath@1)
        arrays["optics"] = np.asarray(optics, np.float64)
    return doc, arrays, meshes


def frame_rows(doc, Z, j):
    """the full [G,17] row table at track index j (frame (j // sub), subframe j % sub)"""
    X = np.array(Z["first"], np.float64)
    X[Z["moving"]] = Z["track"][j]
    return X


def write(dst, doc, arrays, meshes):
    os.makedirs(dst, exist_ok=True)
    np.savez_compressed(os.path.join(dst, "meshes.npz"), **meshes)
    np.savez_compressed(os.path.join(dst, "capture.npz"), **arrays)
    with open(os.path.join(dst, "capture.json"), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=0)


def aspect_arg(s):
    a, _, b = s.partition("/")
    return float(a) / float(b or 1)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("out", help="an export dir (export.mjs --visual): scene.xml, scene.json, meshes/")
    ap.add_argument("--ctrl", help="ctrl log (default <out>/ctrl.f32); report.json beside it")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--sub", type=int, default=4, help="subframes per frame (4 = 120 Hz for motion blur)")
    ap.add_argument("--t0", type=float, default=0.0)
    ap.add_argument("--seconds", type=float)
    ap.add_argument("--aspect", type=aspect_arg, default=16 / 9)
    ap.add_argument("--campath", help="rps/campath@1 shots.json (default: the Director's track)")
    ap.add_argument("--dst", required=True)
    a = ap.parse_args(argv)
    out = os.path.abspath(a.out)
    t = time.time()
    doc, arrays, meshes = capture(out, os.path.abspath(a.ctrl or os.path.join(out, "ctrl.f32")), a.fps, max(1, a.sub),
                                  a.t0, a.seconds, a.aspect, a.campath)
    write(a.dst, doc, arrays, meshes)
    size = sum(os.path.getsize(os.path.join(a.dst, f)) for f in ("capture.json", "capture.npz", "meshes.npz"))
    print("capture: %d frames x %d sub from t=%.2f s, %d geoms (%d moving), %d meshes, %.1f MB, %.1f s -> %s" % (
        doc["frames"], doc["sub"], doc["t0"], len(doc["geoms"]), len(arrays["moving"]), len(meshes) // 3,
        size / 1e6, time.time() - t, a.dst))
    return 0


if __name__ == "__main__":
    sys.exit(main())
