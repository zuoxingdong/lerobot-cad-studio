"""Build a .blend from an rps/capture@1 dir: one object per drawn geom (mesh data shared), keyed on the
capture's (sub)frames, looks.py materials, hi-fi models (models.json), the covers' closed-jaw press (press.py), the
rig.py room and lights, the camera track (with DOF keys from a shots capture) and the robot cameras as cam_<name>.

    blender -b --factory-startup -P build.py -- --cap DIR --out lab.blend [--decor f] [--looks f]
        [--models f | --no-models] [--hdri f.hdr] [--camera capture | "x,y,z,az,el,dist,fovy"]
"""
import argparse
import glob
import json
import math
import os
import re
import sys

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, HERE)
sys.path.append(os.path.join(STUDIO, "tools"))
import cables  # noqa: E402
import campath  # noqa: E402
import pose  # noqa: E402
import looks  # noqa: E402
import paths  # noqa: E402
import prims  # noqa: E402
import press  # noqa: E402
import printdir  # noqa: E402
import rig  # noqa: E402
import subst  # noqa: E402

RENDER = os.path.join(STUDIO, "tools", "render")
CACHE = os.path.join(paths.CACHE, "render")         # the CC0 downloads

NO_BEVEL = ("^vis_", "^puck_1_liquid_", "^puck_1_meniscus_")


def args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--cap", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--decor", default=os.path.join(STUDIO, "assets", "scenes", "lab", "decor.json"))
    ap.add_argument("--looks", default=os.path.join(STUDIO, "tools", "render", "looks.json"))
    ap.add_argument("--models", default=os.path.join(STUDIO, "tools", "render", "models.json"))
    ap.add_argument("--models-dir", default=subst.MODELS)
    ap.add_argument("--no-models", action="store_true")
    ap.add_argument("--hdri", help="an .hdr in place of looks.json world.hdri")
    ap.add_argument("--lock", default=os.path.join(RENDER, "assets.lock.json"))
    ap.add_argument("--cache", default=CACHE)
    ap.add_argument("--camera", default="capture")
    return ap.parse_args(argv)


class Build:
    def __init__(self, a):
        self.cap = json.load(open(os.path.join(a.cap, "capture.json")))
        Z = np.load(os.path.join(a.cap, "capture.npz"))
        self.first, self.moving, self.track, self.camera = Z["first"], list(Z["moving"]), Z["track"], Z["camera"]
        self.optics = Z["optics"] if "optics" in Z.files else None
        self.rcams = Z["robot_cameras"] if "robot_cameras" in Z.files else None
        M = np.load(os.path.join(a.cap, "meshes.npz"))
        self.meshes = {k: M[k] for k in M.files}
        self.decor = json.load(open(a.decor))
        self.table = json.load(open(a.looks))
        self.emit = float(self.table.get("emit", looks.EMIT))
        sub, f0 = self.cap.get("sub", 1), self.cap["frame0"]
        self.frames = f0 + np.arange(self.cap["frames"] * sub, dtype=np.float64) / sub
        self.bevel = float(self.table.get("bevel_modifier_mm", 1.5)) * 0.001
        self.index = {g: k for k, g in enumerate(self.moving)}
        self.parts, self.axes = robot_parts(), {}
        self.tag = None                 # tag(ob, g): called for every object coloured from geom g

    def rows(self, g):
        """[F*sub, 17] rows of geom g (the static row repeated when it does not move)"""
        if g["i"] in self.index:
            return self.track[:, self.index[g["i"]], :].astype(np.float64)
        return np.repeat(self.first[g["i"]][None], len(self.frames), 0)

    def offset(self, g):
        return self.meshes.get("o%d" % g["mesh_id"]) if g["type"] == "mesh" else None

    def nearest(self, gs, i):
        p = self.first[i][0:3]
        return min(gs, key=lambda g: float(np.linalg.norm(self.first[g["i"]][0:3] - p)), default=None)

    def colour(self, ob, g):
        if self.tag:
            self.tag(ob, g)
        row = self.first[g["i"]]
        ob.color = (*looks.lin3(row[12:15]), float(row[16]))
        if g["moving"] and ("rgba" in g["channels"] or "emission" in g["channels"]):
            X = self.rows(g)
            C = np.array([looks.lin3(c) for c in X[:, 12:15]])
            prims.key(ob, "color", self.frames, np.concatenate([C, X[:, 16:17]], 1))


def prim_scale(t, S):
    """object scale of a unit primitive from MuJoCo sizes, S [..., 3]"""
    S = np.asarray(S, np.float64)
    if t == "cylinder":
        return np.stack([S[..., 0], S[..., 0], S[..., 1]], -1)
    if t == "sphere":
        return np.stack([S[..., 0]] * 3, -1)
    return S


def data_for(B, g, cache):
    """(mesh data, object scale, bevel ok) for a geom; static primitives get real-size meshes"""
    t, s, ch = g["type"], B.first[g["i"]][9:12], g["channels"]
    if t == "mesh":
        mid = g["mesh_id"]
        if ("m", mid) not in cache:
            cache[("m", mid)] = prims.mesh_from(g["mesh"], B.meshes["v%d" % mid], B.meshes["f%d" % mid], 35)
        data = cache[("m", mid)]
        return (data.copy() if "shear" in ch else data), (1, 1, 1), True     # shape keys need their own data
    if t == "plane":
        hx, hy = (s[0] if s[0] > 0 else 12.0), (s[1] if s[1] > 0 else 12.0)
        V = np.array([(-hx, -hy, 0), (hx, -hy, 0), (hx, hy, 0), (-hx, hy, 0)])
        return prims.mesh_from("plane", V, np.array([(0, 1, 2), (0, 2, 3)])), (1, 1, 1), False
    if t == "capsule":
        k = ("c", round(s[0], 7), round(s[1], 7))
        if k not in cache:
            cache[k] = prims.capsule("capsule", s[0], s[1])
        return (cache[k].copy() if "shear" in ch else cache[k]), (1, 1, 1), True
    unit = "size" in ch or "shear" in ch
    if unit:        # scale keys, or a shear through shape keys: a unit mesh of its own
        data = {"box": prims.box, "cylinder": prims.cylinder}.get(t, prims.ellipsoid)("unit_" + t)
        return data, tuple(prim_scale(t, s)), False
    k = (t, *(round(float(v), 7) for v in s))
    if k not in cache:
        if t == "box":
            cache[k] = prims.box("box", s)
        elif t == "cylinder":
            cache[k] = prims.cylinder("cylinder", s[0], s[1])
        elif t == "sphere":
            cache[k] = prims.ellipsoid("sphere", (s[0], s[0], s[0]))
        else:
            cache[k] = prims.ellipsoid(t, s)
    return cache[k], (1, 1, 1), True


def robot_parts():
    """vis_<id> and vis_<robot>_<id> -> (robot dir, component) over every robot package"""
    out = {}
    for rj in sorted(glob.glob(os.path.join(STUDIO, "assets", "robots", "*", "robot.json"))):
        d = os.path.dirname(rj)
        for c in json.load(open(rj)).get("components") or []:
            for k in ("vis_" + c["id"], "vis_%s_%s" % (os.path.basename(d), c["id"])):
                out.setdefault(k, (d, c))
    return out


def part_axes(B, g, key, ob):
    """custom properties the looks read: the print axis of printed parts, the servo box, the wheel axis"""
    mid = g.get("mesh_id")
    if g["type"] != "mesh" or mid is None:
        return
    V, F = B.meshes["v%d" % mid], B.meshes["f%d" % mid]
    spec = looks.lookup(key, B.decor, B.table)
    if (key, mid) not in B.axes:
        got = {}
        if spec.get("layer") or spec.get("edge"):
            d, c = B.parts.get(g["name"], (None, {}))
            stl, bed = None, c.get("print_transform")
            if bed and c.get("mesh") and os.path.exists(os.path.join(d, c["mesh"])):
                stl = printdir.read_stl(os.path.join(d, c["mesh"]))
            ax, how = printdir.print_axis(V, F, stl, bed)
            got["rps_pz"] = ax
            print("axes: %s print %s %s" % (g["name"], how, np.round(ax, 3).tolist()))
        if spec.get("label"):
            n, u, h, c0 = printdir.box_frame(V, F)
            got.update(rps_n=n, rps_u=u, rps_h=h, rps_c=c0)
        if spec.get("lens"):
            n, u, h, c0 = printdir.lens_frame(V, F)
            got.update(rps_n=n, rps_u=u, rps_h=h, rps_c=c0)
        if spec.get("wheel"):
            a, r, c0 = printdir.wheel_frame(V, F)
            got.update(rps_ax=a, rps_r=r, rps_c=c0)
        B.axes[(key, mid)] = got
    for k, v in B.axes[(key, mid)].items():
        ob[k] = [float(x) for x in v] if np.ndim(v) else float(v)


def add_bevel(B, ob, g):
    if any(re.search(rx, g["name"] or g["mesh"] or "") for rx in NO_BEVEL):
        return
    dims = ob.dimensions
    if min(dims) < 4 * B.bevel:
        return
    mod = ob.modifiers.new("bevel", "BEVEL")
    mod.width, mod.segments, mod.limit_method = B.bevel, 2, "ANGLE"
    mod.angle_limit, mod.harden_normals = math.radians(30), True


def key_geom(B, ob, g, data, size0):
    X, ch, t = B.rows(g), g["channels"], g["type"]
    if "pos" in ch and t != "plane":
        prims.key(ob, "location", B.frames, X[:, 0:3])
    if "quat" in ch:
        prims.key(ob, "rotation_quaternion", B.frames, pose.continuous(X[:, 3:7]))
    unit = t in ("box", "cylinder", "sphere", "ellipsoid")
    S = prim_scale(t, X[:, 9:12] if "size" in ch else np.repeat(np.asarray(size0, np.float64)[None], len(X), 0))
    if "size" in ch and unit:
        prims.key(ob, "scale", B.frames, S)
    if "shear" in ch:
        # R.Sh.diag(a,b,c) = R.diag(a,b,c).Sh' with Sh': z += (sx a/c) x + (sy b/c) y; a mesh or capsule
        # has its real size in the data (scale 1), so Sh' = Sh
        ob.shape_key_add(name="Basis")
        V = np.array([v.co[:] for v in data.vertices])
        for j, nm in enumerate(("sx", "sy")):
            sk = ob.shape_key_add(name=nm, from_mix=False)
            P = V.copy()
            P[:, 2] += V[:, j]
            sk.data.foreach_set("co", P.ravel())
            sk.slider_min, sk.slider_max = -10, 10
        for j, nm in enumerate(("sx", "sy")):
            ratio = S[:, j] / np.maximum(S[:, 2], 1e-9) if unit else 1.0
            prims.key(data.shape_keys, 'key_blocks["%s"].value' % nm, B.frames, X[:, 7 + j] * ratio)
    if hasattr(ob, "cycles") and hasattr(ob.cycles, "motion_steps") and ("quat" in ch or "shear" in ch):
        ob.cycles.motion_steps = 2          # wheel arcs and liquid tilt over the shutter


def geoms(B, hide):
    col, rep = bpy.data.collections.new("capture"), bpy.data.collections.new("replaced")
    for c in (col, rep):
        bpy.context.scene.collection.children.link(c)
    rep.hide_render = rep.hide_viewport = True
    cache = {}
    for g in B.cap["geoms"]:
        row = B.first[g["i"]]
        data, scale, bevel_ok = data_for(B, g, cache)
        ob = bpy.data.objects.new(g["name"] or g["mesh"] or "g%d" % g["id"], data)
        (rep if g["i"] in hide else col).objects.link(ob)
        ob.rotation_mode, ob.scale = "QUATERNION", scale
        ob.location = (0, 0, row[2]) if g["type"] == "plane" else row[0:3]
        ob.rotation_quaternion = (1, 0, 0, 0) if g["type"] == "plane" else row[3:7]
        key_, spec = looks.resolve(g, B.decor, B.table)
        if len(ob.data.materials) == 0:
            ob.data.materials.append(None)
        ob.material_slots[0].link = "OBJECT"         # shared mesh data, per-object looks
        ob.material_slots[0].material = looks.build(bpy, key_, spec, looks.is_tinted(g), B.emit)
        if g["name"].startswith("vis_"):
            part_axes(B, g, key_, ob)
        if g["i"] in hide:
            continue
        B.colour(ob, g)
        if bevel_ok:
            add_bevel(B, ob, g)
        if g["moving"]:
            key_geom(B, ob, g, data, row[9:12])
    return len(cache)


def camera(B, spec):
    cam = bpy.data.cameras.new("camera")
    cam.sensor_fit, cam.sensor_height, cam.clip_start, cam.clip_end = "VERTICAL", campath.SENSOR_H_MM, 0.03, 40.0
    co = bpy.data.objects.new("camera", cam)
    bpy.context.scene.collection.objects.link(co)
    bpy.context.scene.camera = co
    co.rotation_mode = "QUATERNION"
    C = B.camera if spec == "capture" else np.array([[float(v) for v in spec.split(",")]])
    P, Q, D, Lm = campath.track(C)
    co.location, co.rotation_quaternion = P[0], Q[0]
    cam.dof.focus_distance, cam.lens = D[0], Lm[0]
    if len(C) > 1:
        prims.key(co, "location", B.frames, P)
        prims.key(co, "rotation_quaternion", B.frames, Q)
        if B.optics is not None:        # shots: focus pulls and f-stops, DOF on
            D = B.optics[:, 0]
            cam.dof.use_dof = True
            prims.key(cam, "dof.aperture_fstop", B.frames, B.optics[:, 1])
        prims.key(cam, "dof.focus_distance", B.frames, D)
        if np.ptp(Lm) > 0:
            prims.key(cam, "lens", B.frames, Lm)
    for n, rc in enumerate((B.cap.get("robot_cameras") or []) if B.rcams is not None else []):
        data = bpy.data.cameras.new("cam_" + rc["name"])
        data.sensor_fit, data.sensor_height = "VERTICAL", campath.SENSOR_H_MM
        data.lens, data.clip_start, data.clip_end = campath.lens_mm(rc["fovy"]), rc["near"], 40.0
        ob = bpy.data.objects.new("cam_" + rc["name"], data)
        bpy.context.scene.collection.objects.link(ob)
        ob.rotation_mode = "QUATERNION"
        R = B.rcams[:, n]
        ob.location, ob.rotation_quaternion = R[0, :3], R[0, 3:]
        prims.key(ob, "location", B.frames, R[:, :3])
        prims.key(ob, "rotation_quaternion", B.frames, pose.continuous(R[:, 3:]))


def main():
    a = args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    looks.configure(json.load(open(a.looks)), json.load(open(a.lock)) if os.path.exists(a.lock) else None, a.cache)
    B = Build(a)
    sc = bpy.context.scene
    f0, nF = B.cap["frame0"], B.cap["frames"]
    sc.frame_start, sc.frame_end, sc.frame_current = f0, f0 + nF - 1, f0
    sc.render.fps, sc.render.fps_base = B.cap["fps"], 1.0
    sc.render.engine = "CYCLES"
    table = {} if a.no_models else json.load(open(a.models))
    hide = subst.apply(B, table, a.models_dir)
    press.apply(B)
    nmesh = geoms(B, hide)
    made = cables.build(B, {g["name"]: bpy.data.objects.get(g["name"]) for g in B.cap["geoms"] if g.get("name")})
    camera(B, a.camera)
    rig.apply(B, a.hdri)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(a.out), compress=True)
    print("build: %d geoms (%d moving, %d replaced), %d mesh datas, %d cables, frames %d..%d x%d -> %s" % (
        len(B.cap["geoms"]), len(B.moving), len(hide), nmesh, len(made), f0, f0 + nF - 1, B.cap.get("sub", 1), a.out))


if __name__ == "__main__":
    main()
