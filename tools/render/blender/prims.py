"""Mesh primitives and keyframing for build.py (bpy + numpy)."""
import math

import bpy
import numpy as np

LINEAR = 1   # the keyframe interpolation enum's index


def mesh_from(name, V, F, smooth_deg=None):
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(V))
    me.vertices.foreach_set("co", np.ascontiguousarray(V, np.float32).ravel())
    me.loops.add(3 * len(F))
    me.loops.foreach_set("vertex_index", np.ascontiguousarray(F, np.int32).ravel())
    me.polygons.add(len(F))
    me.polygons.foreach_set("loop_start", np.arange(0, 3 * len(F), 3, dtype=np.int32))
    me.update(calc_edges=True)
    me.validate(clean_customdata=False)
    if smooth_deg is not None:
        me.shade_smooth()
        me.set_sharp_from_angle(angle=math.radians(smooth_deg))
    return me


def lathe(name, rings, n, smooth_deg=40):
    """rings = [(r, z)] around z, n segments, both ends capped"""
    V, F = [], []
    for r, z in rings:
        V += [(r * math.cos(2 * math.pi * k / n), r * math.sin(2 * math.pi * k / n), z) for k in range(n)]
    for j in range(len(rings) - 1):
        for k in range(n):
            a, b = j * n + k, j * n + (k + 1) % n
            F += [(a, b, b + n), (a, b + n, a + n)]
    for j, flip in ((0, True), (len(rings) - 1, False)):
        c = len(V)
        V.append((0, 0, rings[j][1]))
        for k in range(n):
            a, b = j * n + k, j * n + (k + 1) % n
            F.append((c, b, a) if flip else (c, a, b))
    return mesh_from(name, np.array(V), np.array(F), smooth_deg)


def box(name, s=(1, 1, 1)):
    V = np.array([(x * s[0], y * s[1], z * s[2]) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)], float)
    Q = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return mesh_from(name, V, np.array([t for a, b, c, d in Q for t in ((a, b, c), (a, c, d))]))


def cylinder(name, r=1.0, hh=1.0, n=64):
    return lathe(name, [(r, -hh), (r, hh)], n)


def ellipsoid(name, s=(1, 1, 1), n=32, m=16):
    rings = [(math.sin(math.pi * i / m) + 1e-6, -math.cos(math.pi * i / m)) for i in range(m + 1)]
    me = lathe(name, rings, n, smooth_deg=89)
    V = np.empty(3 * len(me.vertices), np.float32)
    me.vertices.foreach_get("co", V)
    me.vertices.foreach_set("co", (V.reshape(-1, 3) * np.asarray(s, np.float32)).ravel())
    me.update()
    return me


def capsule(name, r, hh, n=32, m=8):
    rings = [(r * math.sin(math.pi / 2 * i / m), -hh - r * math.cos(math.pi / 2 * i / m)) for i in range(m + 1)]
    rings += [(r * math.sin(math.pi / 2 * (m - i) / m), hh + r * math.cos(math.pi / 2 * (m - i) / m)) for i in range(m + 1)]
    rings[0], rings[-1] = (1e-6, -hh - r), (1e-6, hh + r)
    return lathe(name, rings, n, smooth_deg=80)


def fcurves(idb, path, n):
    ad = idb.animation_data or idb.animation_data_create()
    if ad.action is None:
        ad.action = bpy.data.actions.new(idb.name + "_act")
    return [ad.action.fcurve_ensure_for_datablock(idb, path, index=i) for i in range(n)]


def key(idb, path, frames, values):
    """linear keys at (fractional) frames; runs of equal values keep only their ends (lossless)"""
    frames = np.asarray(frames, np.float64)
    values = np.asarray(values, np.float64).reshape(len(frames), -1)
    for i, fc in enumerate(fcurves(idb, path, values.shape[1])):
        v = values[:, i]
        keep = np.ones(len(v), bool)
        if len(v) > 2:
            keep[1:-1] = (v[1:-1] != v[:-2]) | (v[1:-1] != v[2:])
        n = int(keep.sum())
        fc.keyframe_points.add(n)
        co = np.empty(2 * n)
        co[0::2], co[1::2] = frames[keep], v[keep]
        fc.keyframe_points.foreach_set("co", co)
        fc.keyframe_points.foreach_set("interpolation", [LINEAR] * n)
        fc.update()
