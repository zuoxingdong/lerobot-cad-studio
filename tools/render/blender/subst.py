"""The hi-fi model hook (rps/models@1): instance models/<name>.py in place
of the capture geoms models.json maps; returns the geom indices to hide."""
import importlib.util
import os
import re
import sys

import bpy
import numpy as np

import looks
import pose
import prims

MODELS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")


def hits(g, rx):
    return any(re.search(rx, k) for k in (g.get("mesh") or "", g.get("name") or ""))


def hidden(B, e, g, inv):
    """the entry's `hide` rule: an unnamed primitive (no name, no mesh) whose material and body match and
    whose centre lies in `box` and outside `not_box` (mm, in the instance frame F); or a `force` hit"""
    h = e.get("hide") or {}
    if h.get("force") and hits(g, h["force"]):
        return True
    if not h or g.get("name") or g.get("mesh"):
        return False
    if h.get("mat") and not re.search(h["mat"], g.get("mat") or ""):
        return False
    if h.get("body") and not re.search(h["body"], g.get("body") or ""):
        return False
    p = (inv[:3, :3] @ np.asarray(B.first[g["i"]][0:3], float) + inv[:3, 3]) * 1000
    inside = lambda b: all(b[2 * k] <= p[k] <= b[2 * k + 1] for k in range(3))
    return (not h.get("box") or inside(h["box"])) and not (h.get("not_box") and inside(h["not_box"]))


class Ctx:
    """what a model builder sees"""

    def __init__(self, B, name, anchor, world):
        self.bpy, self.np, self.name, self.mm = bpy, np, name, 0.001
        self.decor, self.lab, self._B = B.decor, B.cap.get("lab"), B
        self.anchor = dict(anchor, world=world, size=B.first[anchor["i"]][9:12].tolist())
        self._inv = np.linalg.inv(world)

    def material(self, key, tint=False):
        B = self._B
        return looks.build(bpy, key, looks.lookup(key, B.decor, B.table), tint, B.emit)

    def mesh(self, rx):
        B = self._B
        g = B.nearest([g for g in B.cap["geoms"] if g["type"] == "mesh" and hits(g, rx)], self.anchor["i"])
        if g is None:
            raise KeyError("ctx.mesh: no mesh geom hits %r" % rx)
        row = B.first[g["i"]]
        V = np.asarray(B.meshes["v%d" % g["mesh_id"]], np.float64) @ pose.quat_mat(row[3:7]).T + row[0:3]
        V = V @ self._inv[:3, :3].T + self._inv[:3, 3]
        return V, np.asarray(B.meshes["f%d" % g["mesh_id"]], np.int32)

    def _item(self, rx):
        B = self._B
        g = B.nearest([g for g in B.cap["geoms"] if g["type"] == "mesh" and hits(g, rx)], self.anchor["i"])
        if g is None:
            raise KeyError("ctx: no mesh geom hits %r" % rx)
        return g, B.offset(g)

    def local(self, rx):
        """(V m, F) of the mesh geom hitting rx, in its own item frame: the frame a part following it is modelled in"""
        g, off = self._item(rx)
        V = np.asarray(self._B.meshes["v%d" % g["mesh_id"]], np.float64)
        if off is not None:
            V = V @ pose.quat_mat(off[3:7]).T + np.asarray(off[0:3], float)
        return V, np.asarray(self._B.meshes["f%d" % g["mesh_id"]], np.int32)

    def pose(self, rx):
        """4x4 world pose (m) of that geom's item frame at frame0"""
        g, off = self._item(rx)
        row = self._B.first[g["i"]]
        return matrix(*pose.item_pose(row[0:3], row[3:7], off))


def load(path):
    spec = importlib.util.spec_from_file_location("rps_model_" + os.path.basename(path)[:-3], path)
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, os.path.dirname(path))
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.path.remove(os.path.dirname(path))
    return mod


def matrix(pos, quat):
    M = np.eye(4)
    M[:3, :3], M[:3, 3] = pose.quat_mat(quat), pos
    return M


def parts_of(out):
    if isinstance(out, dict):
        return {k: (v if isinstance(v, (list, tuple)) else [v]) for k, v in out.items()}
    return {"static": list(out if isinstance(out, (list, tuple)) else [out])}


def apply(B, table, models_dir=MODELS):
    """build every mapped instance into the 'models' collection; returns the set of geom indices to hide"""
    entries = table.get("models") or []
    if not entries:
        return set()
    col = bpy.data.collections.new("models")
    bpy.context.scene.collection.children.link(col)
    hide, count = set(), {}
    for e in entries:
        path = os.path.join(models_dir, e["model"] + ".py")
        if not os.path.isfile(path):
            print("models: %s has no %s, skipped" % (e["model"], path))
            continue
        mod = load(path)
        anchor_rx, match_rx, follow = e.get("anchor") or e["match"], e["match"], e.get("follow") or {}
        matched = {g["i"]: g for g in B.cap["geoms"] if hits(g, match_rx)}
        followed, bodies = set(), set()
        for a in (g for g in B.cap["geoms"] if hits(g, anchor_rx)):
            if a["moving"]:
                print("models: %s anchor %s moves, skipped" % (e["model"], a["mesh"] or a["name"]))
                continue
            n = count.get(e["model"], 0)
            count[e["model"]] = n + 1
            name = e["model"] if n == 0 else "%s.%d" % (e["model"], n)
            row = B.first[a["i"]]
            pos, quat = pose.item_pose(row[0:3], row[3:7], B.offset(a))
            ctx = Ctx(B, name, a, matrix(pos, quat))
            matched.update({g["i"]: g for g in B.cap["geoms"] if g["i"] not in matched and hidden(B, e, g, ctx._inv)})
            parts = parts_of(mod.build(ctx))
            root = bpy.data.objects.new(name + "_root", None)
            col.objects.link(root)
            root.rotation_mode, root.location, root.rotation_quaternion = "QUATERNION", pos, quat
            look = looks.resolve(a, B.decor, B.table)
            for part, obs in parts.items():
                parent, src = root, None
                if part in follow:
                    src = B.nearest([g for g in B.cap["geoms"] if hits(g, follow[part])], a["i"])
                    if src is None:
                        print("models: %s part %s follows nothing" % (name, part))
                    else:
                        followed.add(src["i"])
                        if src.get("body") not in ("decor", "world"):
                            bodies.add(src.get("body"))
                        parent = follower(B, col, "%s_%s_follow" % (name, part), src)
                for ob in obs:
                    if ob.name not in col.objects:
                        col.objects.link(ob)
                    ob.parent = parent
                    if ob.type == "MESH" and not any(s.material for s in ob.material_slots):
                        ob.data.materials.append(looks.build(bpy, look[0], look[1], False, B.emit))
                    if src is not None:
                        B.colour(ob, src)
            print("models: %s (%s) at %s, %d parts" % (name, a["mesh"] or a["name"], np.round(pos, 4).tolist(), len(parts)))
        for g in matched.values():
            forced = bool((e.get("hide") or {}).get("force")) and hits(g, e["hide"]["force"])
            if g["moving"] and g["i"] not in followed and g.get("body") not in bodies and not forced:
                print("models: %s keeps moving geom %s (no follow part)" % (e["model"], g["mesh"] or g["name"]))
            else:
                hide.add(g["i"])
    return hide


def follower(B, col, name, g):
    """an empty that carries geom g's asset frame over the capture, keyed on every (sub)frame"""
    em = bpy.data.objects.new(name, None)
    col.objects.link(em)
    em.rotation_mode = "QUATERNION"
    off = B.offset(g)
    X = B.rows(g)
    P, Q = zip(*(pose.item_pose(r[0:3], r[3:7], off) for r in X))
    em.location, em.rotation_quaternion = P[0], Q[0]
    if g["moving"]:
        prims.key(em, "location", B.frames, np.array(P))
        prims.key(em, "rotation_quaternion", B.frames, pose.continuous(Q))
    return em
