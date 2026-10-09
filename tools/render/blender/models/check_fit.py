"""Fit check for the lab models, no capture needed: places every models.json instance where subst.py
would (anchors and follow parts resolved on the MJCF's decor geoms) and verifies, in mm:
  fixtures   plinth top/sides, nest collar/lead-in/floor and the puck silhouette against the MJCF
             collision geoms, by casting the same rays at both (|d| <= 0.2; trims <= 3 proud)
  pads       the fingertip covers' grip face against the MJCF pad cover geoms, the same way
  corridor   no visual geometry (but nest, puck and the robot's own) in any reach corridor (BIOLAB §3.3)
  body       instruments within 20 mm of their coarse st_<id>_body box, except upward
  routes     dressing: nothing within 320 mm of a route above z 290, 250 below (§3.5)
  sight      dressing clear of the establishing camera -> nests and front camera -> tag/LED lines
  tape       no two floor tape tops overlap at one height (the coplanar "grate" pattern)
  tris       triangles per instance for the render and web LODs
    blender -b --factory-startup --python check_fit.py -- --export <sim export dir> [--lod web]
      [--json out.json] [--save preview.blend]"""
import argparse
import json
import math
import os
import re
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from _fitlib import bvh, mesh_hash, mjcf, msh, ob_tris, place, prim_tris  # noqa: E402
STUDIO = os.path.abspath(os.path.join(HERE, *[".."] * 4))
sys.path.append(os.path.join(STUDIO, "tools"))
import paths  # noqa: E402
TOL, PROUD = 0.2, 3.0


def args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--export", default=os.path.join(paths.SIM, "lab"))
    ap.add_argument("--decor", default=os.path.join(STUDIO, "assets", "scenes", "lab", "decor.json"))
    ap.add_argument("--models", default=os.path.join(STUDIO, "tools", "render", "models.json"))
    ap.add_argument("--lod", default="render")
    ap.add_argument("--json", default="")
    ap.add_argument("--save", default="")
    return ap.parse_args(argv)


# ---- checks -----------------------------------------------------------------------------------

def ray(tree, o, d):
    hit = tree.ray_cast(Vector(o), Vector(d).normalized(), 5000)
    return None if hit[0] is None else (hit[0] - Vector(o)).length


def compare(tv, tc, rays, lo=-TOL, hi=TOL):
    """the same rays at the visual and collision trees: worst difference (visual - collision, mm)"""
    worst, n, bad = 0.0, 0, []
    for o, d in rays:
        c, v = ray(tc, o, d), ray(tv, o, d)
        if c is None:
            continue
        n += 1
        dv = (c - v) if v is not None else -999.0          # > 0: the visual stands proud
        if abs(dv) > abs(worst):
            worst = dv
        if not (lo <= dv <= hi):
            bad.append((tuple(round(x, 2) for x in o), round(dv, 3)))
    return {"rays": n, "worst_mm": round(worst, 4), "fails": len(bad), "first": bad[:3]}


def to_world(M, p):
    M = np.array(M)
    return tuple(M[:3, :3] @ np.asarray(p, float) + M[:3, 3] * 1000)


def rot(M, d):
    return tuple(np.array(M)[:3, :3] @ np.asarray(d, float))


def fixtures(G, inst, lab):
    res, T = {}, lab["T_mm"]
    for st in lab["stations"]:
        sid = st["id"]
        body = [g for g in G.values() if g["body"] == "st_" + sid]
        Ms = Matrix(np.array(G_body_pose(G, "st_" + sid)))
        pl = next((i for i in inst if i["model"] == "plinth" and sid in (i["anchor"]["mesh"] + i["anchor"]["name"])), None)
        ne = next((i for i in inst if i["model"] == "nest" and sid in (i["anchor"]["mesh"] + i["anchor"]["name"])), None)
        tcp = bvh([prim_tris(g) for g in body if g["name"].endswith("_plinth")])
        tcn = bvh([prim_tris(g) for g in body if re.search(r"_(c|l)\d$", g["name"])] + [prim_tris(g) for g in body if g["name"].endswith("_plinth")])
        w, d = plinth_wd(st)
        if pl:
            tv = bvh(ob_tris(pl["obs"]))
            W = lambda p: to_world(Ms, p)
            top = [(W((x, y, T + 60)), rot(Ms, (0, 0, -1))) for x in np.arange(-w / 2 + 6, w / 2 - 5, 23.0)
                   for y in np.arange(12, d - 5, 23.0) if not (abs(x) < 50 and abs(y - 60) < 50)]
            side = [(W((w / 2 + 40, y, z)), rot(Ms, (-1, 0, 0))) for y in np.arange(8, d - 7, 29.0) for z in list(range(75, int(T) - 25, 20)) + [T - 12]]
            side += [(W((-w / 2 - 40, y, z)), rot(Ms, (1, 0, 0))) for y in np.arange(8, d - 7, 29.0) for z in list(range(75, int(T) - 25, 20)) + [T - 12]]
            front = [(W((x, -40, z)), rot(Ms, (0, 1, 0))) for x in np.arange(-w / 2 + 8, w / 2 - 7, 17.0) for z in list(range(75, int(T) - 25, 9)) + [T - 12]]
            back = [(W((x, d + 40, z)), rot(Ms, (0, -1, 0))) for x in np.arange(-w / 2 + 8, w / 2 - 7, 29.0) for z in list(range(75, int(T) - 25, 20))]
            res["plinth_%s_top" % sid] = compare(tv, tcp, top)
            res["plinth_%s_sides" % sid] = compare(tv, tcp, side + front + back, -TOL, PROUD)
        if ne:
            tv = bvh(ob_tris(ne["obs"] + (pl["obs"] if pl else [])))
            N = st["nest"]
            c = local(Ms, N["xy"])
            ri, ch, lead = N["inner"] / 2, N["collar_h"], N["lead"]
            W = lambda p: to_world(Ms, (c[0] + p[0], c[1] + p[1], p[2]))
            walls, leadin, floor = [], [], []
            for ux, uy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                for s in np.arange(-22, 22.1, 4.0):
                    px, py = -uy * s, ux * s
                    for z in np.arange(T + 1.0, T + ch - 0.9, 1.0):
                        walls.append((W((px, py, z)), rot(Ms, (ux, uy, 0))))
                    for r in np.arange(ri + 0.5, ri + lead - 0.4, 0.5):
                        leadin.append((W((px + ux * r, py + uy * r, T + 60)), rot(Ms, (0, 0, -1))))
            floor = [(W((x, y, T + 60)), rot(Ms, (0, 0, -1))) for x in np.arange(-20, 21, 5.0) for y in np.arange(-20, 21, 5.0)]
            res["nest_%s_collar" % sid] = compare(tv, tcn, walls)
            res["nest_%s_leadin" % sid] = compare(tv, tcn, leadin)
            res["nest_%s_floor" % sid] = compare(tv, tcn, floor)
    pk = next((i for i in inst if i["model"] == "puck"), None)
    if pk:
        res.update(puck(G, pk))
    return res


def pad_covers(G, inst, export):
    """rays down the grip normal every 0.5 mm over each pad cover geom's flat face (what a grasp touches):
    the robot_kit cover of that finger against the geom's hull"""
    import bmesh
    from mathutils.bvhtree import BVHTree
    pc = json.load(open(os.path.join(export, "scene.json"))).get("pad_cover") or {}
    kit = next((i for i in inst if i["model"] == "robot_kit"), None)
    res = {}
    for c in (pc.get("geoms") or []) if kit else []:
        g = G[c["geom"]]
        M = np.array(g["M"])
        W = (msh(g)[0] @ M[:3, :3].T + M[:3, 3]) * 1000
        n = M[:3, :3] @ np.array(c["normal"], float)
        a = np.cross(n, np.eye(3)[int(np.argmin(np.abs(n)))])
        a /= np.linalg.norm(a)
        b = np.cross(n, a)
        h = W @ n
        top = W[h > h.max() - 0.05]
        bm = bmesh.new()
        for p in W:
            bm.verts.new(p)
        bmesh.ops.convex_hull(bm, input=list(bm.verts))
        tc = BVHTree.FromBMesh(bm)
        bm.free()
        tv = bvh(ob_tris([o for o in kit["obs"] if o.name.endswith(c["body"][-len("finger_L"):])]))
        o0, rays = n * (h.max() + 30), []
        for s in np.arange((top @ a).min() + 0.5, (top @ a).max() - 0.49, 0.5):
            for t in np.arange((top @ b).min() + 0.5, (top @ b).max() - 0.49, 0.5):
                o = o0 + s * a + t * b
                hit = ray(tc, o, -n)
                if hit is not None and hit < 30.05:
                    rays.append((tuple(o), tuple(-n)))
        res[c["geom"]] = compare(tv, tc, rays)
    return res


def G_body_pose(G, body):
    g = next(g for g in G.values() if g["body"] == body and g["name"].endswith("_plinth"))
    M = np.array(g["M"])
    s = np.array(g["size"]) * 1000
    M[:3, 3] = M[:3, 3] * 1000 - M[:3, :3] @ np.array([0, s[1], s[2]])
    M[:3, 3] /= 1000
    return M


def plinth_wd(st):
    R = st["plinth_rect"]
    sw = abs(round(math.sin(math.radians(st["yaw"]))))
    return (R["y"][1] - R["y"][0], R["x"][1] - R["x"][0]) if sw else (R["x"][1] - R["x"][0], R["y"][1] - R["y"][0])


def local(Ms, xy):
    M = np.array(Ms)
    p = M[:3, :3].T @ (np.array([xy[0], xy[1], 0.0]) - M[:3, 3] * 1000)
    return p[0], p[1]


def puck(G, pk):
    """horizontal rays at 24 azimuths every 0.5 mm, and a vertical grid, in the puck body frame"""
    body = [g for g in G.values() if g["body"] == "puck_1" and g.get("group") == "3"]
    Mp = Matrix(np.array(next(g for g in body if g["name"] == "puck_1_foot")["M"]))
    Mp = Matrix.Translation(Mp.translation - Vector((0, 0, 0.001))) @ Mp.to_quaternion().to_matrix().to_4x4()
    tc, tv = bvh([prim_tris(g, 192) for g in body]), bvh(ob_tris(pk["obs"]))
    ends = sorted({round((g["M"].translation.z - Mp.translation.z) * 1000 + s * g["size"][1] * 1000, 3) for g in body for s in (-1, 1)})
    W = lambda p: to_world(Mp, p)
    near = lambda z: any(abs(z - e) < 0.4 for e in ends)
    hz = [(W((60 * math.cos(a), 60 * math.sin(a), z)), rot(Mp, (-math.cos(a), -math.sin(a), 0)))
          for a in np.radians(np.arange(0, 360, 15)) for z in np.arange(0.25, 106, 0.5) if not near(z) and not 46.5 < z < 47.0]
    wells = [(g["M"].translation - Mp.translation) * 1000 for g in body if "_tube_" in g["name"]]
    def skip(x, y):
        r0 = math.hypot(x, y)
        return 8.2 < r0 < 9.3 or any(5.2 < math.hypot(x - w.x, y - w.y) < 5.9 or 6.0 < math.hypot(x - w.x, y - w.y) < 6.5 for w in wells) or 22.5 < r0 < 26
    vt = [(W((x, y, 150)), rot(Mp, (0, 0, -1))) for x in np.arange(-24, 24.1, 0.75) for y in np.arange(-24, 24.1, 0.75)
          if math.hypot(x, y) < 25 and not skip(x, y)]
    return {"puck_side": compare(tv, tc, hz), "puck_top": compare(tv, tc, vt)}


def corridor(G, inst, lab):
    """visual vertices and triangles inside each station's reach corridor (nest, puck, plinth-top level excepted)"""
    out, T = {}, lab["T_mm"]
    for st in lab["stations"]:
        Ms = np.array(G_body_pose(G, "st_" + st["id"]))
        inv = np.linalg.inv(Ms)
        n, who = 0, set()
        for i in inst:
            if i["model"] in ("nest", "puck") or i["role"] == "robot":
                continue
            for V, F in ob_tris(i["obs"]):
                L = (V / 1000) @ inv[:3, :3].T + inv[:3, 3]
                L *= 1000
                inside = (np.abs(L[:, 0]) < 80) & (L[:, 1] > -300) & (L[:, 1] < 105) & (L[:, 2] > T + TOL) & (L[:, 2] < T + 300)
                if inside.any():
                    n += int(inside.sum())
                    who.add(i["name"])
        out[st["id"]] = {"verts_inside": n, "models": sorted(who)}
    return out


def body_box(G, inst, lab):
    """instrument geometry beyond its coarse box by more than 20 mm, below the box top (upward is free;
    lids and hoods follow BIOLAB §3.4 instead)"""
    out = {}
    for i in inst:
        if i["role"] != "station" or i["model"] not in ("lh", "inc", "reader"):
            continue
        g = next(g for g in G.values() if g["name"] == "st_%s_body" % i["model"])
        inv = np.linalg.inv(np.array(g["M"]))
        s = np.array(g["size"]) * 1000
        worst, who = 0.0, ""
        obs = [o for o in i["obs"] if o.type == "MESH" and not o.name.endswith((".lid", ".glow"))]
        for ob, (V, F) in zip(obs, ob_tris(obs)):
            L = ((V / 1000) @ inv[:3, :3].T + inv[:3, 3]) * 1000
            L = L[L[:, 2] <= s[2]]
            if not len(L):
                continue
            w = max(float(np.maximum(np.abs(L[:, :2]) - s[:2], 0).max()), float(-(L[:, 2] + s[2]).min()))
            if w > worst:
                worst, who = w, ob.name
        out[i["model"]] = {"worst_outside_mm": round(worst, 2), "part": who, "ok": bool(worst <= 20.0)}
    return out


def tape(inst, cell=2.0, top=0.36):
    """floor tape tops (not the stencil paint above them) sampled on a grid: cells two pieces cover at the
    same height (coplanar overlaps)"""
    fl = next((i for i in inst if i["model"] == "floor"), None)
    if fl is None:
        return {}
    over, n, where = 0, 0, []
    for V, F in ob_tris([o for o in fl["obs"] if o.name.endswith(".tape")]):
        A, B, C = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
        N = np.cross(B - A, C - A)
        up = N[:, 2] > 0.99 * np.linalg.norm(N, axis=1)
        for z in np.unique(np.round(A[up, 2], 3)):
            if z > top:
                continue
            T = np.where(up & (np.abs(A[:, 2] - z) < 5e-4))[0]
            hits = {}
            for t in T:
                a, b, c = A[t, :2], B[t, :2], C[t, :2]
                lo, hi = np.floor(np.minimum(np.minimum(a, b), c) / cell), np.ceil(np.maximum(np.maximum(a, b), c) / cell)
                gx, gy = np.meshgrid(np.arange(lo[0], hi[0] + 1), np.arange(lo[1], hi[1] + 1))
                P = np.c_[gx.ravel(), gy.ravel()] * cell + 0.37
                d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
                l1 = ((b[1] - c[1]) * (P[:, 0] - c[0]) + (c[0] - b[0]) * (P[:, 1] - c[1])) / d
                l2 = ((c[1] - a[1]) * (P[:, 0] - c[0]) + (a[0] - c[0]) * (P[:, 1] - c[1])) / d
                ins = (l1 > 1e-6) & (l2 > 1e-6) & (1 - l1 - l2 > 1e-6)
                for q in map(tuple, np.round(P[ins], 2)):
                    hits[q] = hits.get(q, 0) + 1
            n += len(hits)
            bad = [q for q, v in hits.items() if v > 1]
            over += len(bad)
            where += [(q[0], q[1], float(z)) for q in bad[:3]]
    return {"cells": n, "overlap_cells": over, "first": where[:3]}


ROUTES = [((0, 0), (0, 490)), ((0, 490), (740, 490)), ((590, 490), (740, 490)), ((0, 490), (-740, 490)), ((-740, 490), (0, 0))]


def seg_dist(P, a, b):
    a, b = np.array(a, float), np.array(b, float)
    t = np.clip(((P - a) @ (b - a)) / ((b - a) @ (b - a)), 0, 1)
    return np.linalg.norm(P - (a + t[:, None] * (b - a)), axis=1)


def routes(inst):
    out = {}
    for i in inst:
        if i["role"] != "dressing":
            continue
        worst = 1e9
        for V, F in ob_tris(i["obs"]):
            d = np.min([seg_dist(V[:, :2], a, b) for a, b in ROUTES], axis=0)
            need = np.where(V[:, 2] > 290, 320, 250)
            worst = min(worst, float((d - need).min(initial=1e9)))
        out[i["name"]] = {"margin_mm": round(worst, 1), "ok": worst >= 0}
    return out


def sight(G, inst, lab):
    dress = [t for i in inst if i["role"] == "dressing" for t in ob_tris(i["obs"])]
    if not dress:
        return {}
    tree, T, out = bvh(dress), lab["T_mm"], {}
    eye = Vector((-700, -1350, 1550))
    for st in lab["stations"]:
        Ms = Matrix(G_body_pose(G, "st_" + st["id"]))
        tgt = Vector((st["nest"]["xy"][0], st["nest"]["xy"][1], T + 50))
        d = tgt - eye
        h = tree.ray_cast(eye, d.normalized(), d.length)
        px, py, yaw = st["park"]
        a = math.radians(yaw)
        cam = Vector((px - 112 * math.sin(a), py + 112 * math.cos(a), 58))
        blocked = [h[0] is not None]
        for p in ((0, -1.5, 130), (0, -3, 176)):
            q = Vector(to_world(Ms, p))
            dd = q - cam
            blocked.append(tree.ray_cast(cam, dd.normalized(), dd.length - 5)[0] is not None)
        out[st["id"]] = {"establishing": not blocked[0], "front_cam": not any(blocked[1:])}
    return out


def main():
    a = args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    G = mjcf(os.path.join(a.export, "scene.xml"))
    lab = json.load(open(os.path.join(a.export, "scene.json")))["lab"]
    decor = json.load(open(a.decor))
    inst = place(a, G, lab, decor)
    tris = {i["name"]: sum(int(sum(len(p.vertices) - 2 for p in o.data.polygons)) for o in i["obs"] if o.type == "MESH") for i in inst}
    R = {"lod": a.lod, "tris": tris, "tris_total": sum(tris.values()), "hash": mesh_hash(inst, per := {}), "hashes": per,
         "keys": sorted(__import__("_kit").KEYS)}
    if a.lod == "render":
        R["fixtures"] = fixtures(G, inst, lab)
        R["pads"] = pad_covers(G, inst, a.export)
        R["corridor"] = corridor(G, inst, lab)
        R["body_box"] = body_box(G, inst, lab)
        R["routes"] = routes(inst)
        R["sight"] = sight(G, inst, lab)
        R["tape"] = tape(inst)
        fx = all(v["fails"] == 0 for v in R["fixtures"].values()) and all(v["fails"] == 0 and v["rays"] for v in R["pads"].values())
        R["pass"] = bool(fx and all(v["verts_inside"] == 0 for v in R["corridor"].values())
                         and all(v["ok"] for v in R["body_box"].values()) and all(v["ok"] for v in R["routes"].values())
                         and all(all(v.values()) for v in R["sight"].values()) and not R["tape"].get("overlap_cells"))
    print(json.dumps(R, indent=1, default=lambda o: o.item()))
    if a.json:
        json.dump(R, open(a.json, "w"), indent=1, default=lambda o: o.item())
    if a.save:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(a.save))


main()
