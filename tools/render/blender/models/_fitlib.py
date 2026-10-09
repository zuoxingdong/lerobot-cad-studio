"""check_fit helpers: MJCF world poses of the lab bodies, collision primitives as triangles, BVH trees,
evaluated object triangles, and subst.py's placement emulated on the MJCF decor geoms."""
import importlib.util
import json
import math
import os
import re
import types
import xml.etree.ElementTree as ET

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))


# ---- the MJCF: world poses of the worldbody-level geoms ---------------------------------------

def _quat(el):
    if el.get("quat"):
        return Quaternion([float(v) for v in el.get("quat").split()])
    if el.get("xyaxes"):
        a = [float(v) for v in el.get("xyaxes").split()]
        x, y = Vector(a[:3]).normalized(), Vector(a[3:]).normalized()
        return Matrix((x, y, x.cross(y))).transposed().to_quaternion()
    return Quaternion()


def mjcf(path):
    """{name or #i: {name, mesh, type, mat, body, size (m), M (world 4x4, m), file, scale}} for the lab bodies
    and, at their zero pose, the robot's (a robot mesh file is in its body frame)"""
    root = ET.parse(path).getroot()
    wb = root.find("worldbody")
    files = {m.get("name"): (m.get("file"), [float(v) for v in (m.get("scale") or "1 1 1").split()]) for m in root.iter("mesh")}
    out, n = {}, [0]

    def walk(body, P):
        bn = body.get("name")
        B = P @ Matrix.Translation(Vector([float(v) for v in (body.get("pos") or "0 0 0").split()])) @ _quat(body).to_matrix().to_4x4()
        for g in body.findall("geom"):
            p = Vector([float(v) for v in (g.get("pos") or "0 0 0").split()])
            M = B @ Matrix.Translation(p) @ _quat(g).to_matrix().to_4x4()
            f, sc = files.get(g.get("mesh"), (None, None))
            d = {"i": n[0], "name": g.get("name") or "", "mesh": g.get("mesh") or "", "type": g.get("type") or ("mesh" if f else "sphere"),
                 "mat": g.get("material") or "", "body": bn, "size": [float(v) for v in (g.get("size") or "0").split()],
                 "M": M, "group": g.get("group"), "file": f and os.path.join(os.path.dirname(path), root.find("compiler").get("meshdir") or "", f),
                 "scale": sc}
            out[d["name"] or "#%d" % n[0]] = d
            n[0] += 1
        for c in body.findall("body"):
            walk(c, B)

    for body in wb.findall("body"):
        walk(body, Matrix.Identity(4))
    return out


def msh(g):
    """(V m, F) of a mesh geom's .msh file, in its body frame"""
    b = open(g["file"], "rb").read()
    nv, nn, nt, nf = np.frombuffer(b[:16], np.int32)
    V = np.frombuffer(b[16:16 + 12 * nv], np.float32).reshape(-1, 3).astype(np.float64) * np.asarray(g["scale"])
    o = 16 + 12 * (nv + nn) + 8 * nt
    return V, np.frombuffer(b[o:o + 12 * nf], np.int32).reshape(-1, 3).copy()


def prim_tris(g, seg=96):
    """a collision primitive as world triangles (mm)"""
    s = np.array(g["size"]) * 1000
    if g["type"] == "box":
        V = np.array([(x, y, z) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)], float) * s
        F = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1), (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]
    else:
        a = np.linspace(0, 2 * math.pi, seg, endpoint=False)
        r, h = s[0], s[1]
        V = np.concatenate([np.stack([r * np.cos(a), r * np.sin(a), np.full(seg, z)], 1) for z in (-h, h)] + [[[0, 0, -h], [0, 0, h]]])
        F = [(k, (k + 1) % seg, seg + (k + 1) % seg) for k in range(seg)] + [(k, seg + (k + 1) % seg, seg + k) for k in range(seg)]
        F += [(2 * seg, (k + 1) % seg, k) for k in range(seg)] + [(2 * seg + 1, seg + k, seg + (k + 1) % seg) for k in range(seg)]
    M = np.array(g["M"])
    W = V @ M[:3, :3].T + M[:3, 3] * 1000
    return W, np.array(F)


def bvh(parts):
    V, F, off = [], [], 0
    for v, f in parts:
        V.append(v)
        F.append(np.asarray(f) + off)
        off += len(v)
    V, F = np.concatenate(V), np.concatenate(F)
    return BVHTree.FromPolygons([tuple(p) for p in V], [tuple(int(i) for i in t) for t in F], all_triangles=True)


def ob_tris(obs):
    """world triangles (mm) of evaluated mesh objects"""
    dg = bpy.context.evaluated_depsgraph_get()
    out = []
    for ob in obs:
        if ob.type != "MESH":
            continue
        e = ob.evaluated_get(dg)
        me = e.to_mesh()
        me.calc_loop_triangles()
        V = np.zeros(3 * len(me.vertices))
        me.vertices.foreach_get("co", V)
        T = np.zeros(3 * len(me.loop_triangles), np.int64)
        me.loop_triangles.foreach_get("vertices", T)
        M = np.array(ob.matrix_world)
        out.append(((V.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3]) * 1000, T.reshape(-1, 3)))
        e.to_mesh_clear()
    return out


# ---- subst.py placement, emulated on the MJCF decor geoms ---------------------------------------

def hits(g, rx):
    return any(re.search(rx, k) for k in (g["mesh"], g["name"]))


def load(name):
    spec = importlib.util.spec_from_file_location("chk_" + name, os.path.join(HERE, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def mesh_hash(inst, per=None):
    """sha256 over every object's name, vertex coordinates (0.1 um) and face loops, in order"""
    import hashlib
    h = hashlib.sha256()
    for i in inst:
        if per is not None:
            per[i["name"]] = mesh_hash([i])
        for ob in i["obs"]:
            if ob.type != "MESH":
                continue
            V = np.zeros(3 * len(ob.data.vertices))
            ob.data.vertices.foreach_get("co", V)
            L = np.zeros(len(ob.data.loops), np.int64)
            ob.data.loops.foreach_get("vertex_index", L)
            h.update(ob.name.encode())
            h.update(np.round(V * 1e7).astype(np.int64).tobytes())
            h.update(L.tobytes())
    return h.hexdigest()


def place(a, G, lab, decor):
    import _mats

    def material(key, tint=False):
        nm = key + ("~tint" if tint else "")
        m = bpy.data.materials.get(nm)
        if m is None:
            m = _mats.placeholder(key)
            m.name = nm
        return m

    col = bpy.data.collections.new("models")
    bpy.context.scene.collection.children.link(col)
    table = json.load(open(a.models))
    inst, count = [], {}
    for e in table["models"] + table.get("pending", []):
        mod = load(e["model"])
        for an in [g for g in G.values() if hits(g, e.get("anchor") or e["match"]) and g["body"] != "puck_1"]:
            n = count.get(e["model"], 0)
            count[e["model"]] = n + 1
            name = e["model"] if n == 0 else "%s.%d" % (e["model"], n)
            near = lambda rx, an=an: min((g for g in G.values() if g.get("file") and hits(g, rx)),
                                         key=lambda g: (g["M"].translation - an["M"].translation).length)
            ctx = types.SimpleNamespace(bpy=bpy, np=np, name=name, mm=0.001, decor=decor, lab=lab, lod=a.lod, material=material,
                                        anchor={"name": an["name"], "mesh": an["mesh"], "world": np.array(an["M"])},
                                        local=lambda rx: msh(near(rx)), pose=lambda rx: np.array(near(rx)["M"]))
            out = mod.build(ctx)
            out = out if isinstance(out, dict) else {"static": out}
            root = bpy.data.objects.new(name + "_root", None)
            col.objects.link(root)
            root.matrix_world = an["M"]
            obs = []
            for part, v in out.items():
                parent = root
                rx = (e.get("follow") or {}).get(part)
                if rx:
                    cand = [g for g in G.values() if hits(g, rx)]
                    if not cand:
                        raise SystemExit("check_fit: %s follows %r, not in this export (use export.mjs --visual)" % (name, rx))
                    src = min(cand, key=lambda g: (g["M"].translation - an["M"].translation).length)
                    parent = bpy.data.objects.new("%s_%s_follow" % (name, part), None)
                    col.objects.link(parent)
                    parent.matrix_world = src["M"]
                for ob in (v if isinstance(v, (list, tuple)) else [v]):
                    col.objects.link(ob)
                    ob.parent = parent
                    obs.append(ob)
            inst.append({"name": name, "model": e["model"], "role": getattr(mod, "ROLE", "dressing"), "obs": obs,
                         "anchor": an})
    bpy.context.view_layer.update()
    return inst
