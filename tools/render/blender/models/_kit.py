"""Mesh kit for the lab models: parts are numpy polygon soups in mm (V, loop indices, loop counts,
face keys), built with bmesh where a bevel is needed; `Model.finish` turns them into bpy objects in
metres with one material slot per ART material key, smooth + weighted normals and a box UV.
LOD: ctx.lod == "web" coarsens segments, drops sub-mm bevels and parts marked web=False."""
import math

import bmesh
import bpy
import numpy as np

KEYS = []                    # material keys, registry order = first use
Q = {"lod": "render"}


def kid(key):
    if key not in KEYS:
        KEYS.append(key)
    return KEYS.index(key)


def web():
    return Q["lod"] == "web"


def nseg(n, lo=6):
    """segments around a circle for the current LOD"""
    return max(lo, int(round(n / 3))) if web() else n


def bseg(bev, seg):
    """bevel segments for the current LOD (0 = no bevel)"""
    if bev <= 0:
        return 0
    if web():
        return 1 if bev >= 1.5 else 0
    return seg


class Part:
    __slots__ = ("V", "L", "C", "K")

    def __init__(self, V, L, C, K):
        self.V = np.asarray(V, float).reshape(-1, 3)
        self.L = np.asarray(L, np.int64)
        self.C = np.asarray(C, np.int64)
        self.K = np.asarray(K, np.int64)

    def moved(self, R=None, t=(0, 0, 0)):
        V = self.V @ np.asarray(R, float).T if R is not None else self.V
        return Part(V + np.asarray(t, float), self.L, self.C, self.K)

    def recolor(self, key):
        return Part(self.V, self.L, self.C, np.full(len(self.C), kid(key)))

    @property
    def tris(self):
        return int((self.C - 2).sum())


EMPTY = Part(np.zeros((0, 3)), [], [], [])


def cat(parts):
    parts = [p for p in parts if p is not None and len(p.C)]
    if not parts:
        return EMPTY
    V, L, off = [], [], 0
    for p in parts:
        V.append(p.V)
        L.append(p.L + off)
        off += len(p.V)
    return Part(np.concatenate(V), np.concatenate(L), np.concatenate([p.C for p in parts]),
                np.concatenate([p.K for p in parts]))


def rot(axis, deg):
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return {"x": np.array([[1, 0, 0], [0, c, -s], [0, s, c]]),
            "y": np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]]),
            "z": np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])}[axis]


FACE_Y = rot("x", 90)          # an XY part turned to face -y (its +z becomes -y)
# an XY part (text, a tag) turned onto a face, readable from outside: columns = text x, text up, normal
FACE = {"-y": FACE_Y, "+y": np.array([[-1, 0, 0], [0, 0, 1], [0, 1, 0]]).T,
        "+x": np.array([[0, 1, 0], [0, 0, 1], [1, 0, 0]]).T, "-x": np.array([[0, -1, 0], [0, 0, 1], [-1, 0, 0]]).T,
        "+z": np.eye(3)}


def from_bm(bm, key=None):
    bm.verts.index_update()
    V = np.array([v.co[:] for v in bm.verts], float)
    L = [v.index for f in bm.faces for v in f.verts]
    C = [len(f.verts) for f in bm.faces]
    K = [f.material_index for f in bm.faces] if key is None else [kid(key)] * len(C)
    bm.free()
    return Part(V, L, C, K)


def _bevel(bm, edges, bev, seg):
    s = bseg(bev, seg)
    if s and edges:
        bmesh.ops.bevel(bm, geom=edges, offset=bev, segments=s, profile=0.5, affect="EDGES", clamp_overlap=True)


def span(x0, x1, y0, y1, z0, z1, key, bev=1.0, seg=2, web_keep=True, sharp=None):
    """an axis box by its extents, all edges bevelled but those in the face `sharp` = (axis, value)"""
    if web() and not web_keep:
        return EMPTY
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        x, y, z = v.co
        v.co = ((x + .5) * (x1 - x0) + x0, (y + .5) * (y1 - y0) + y0, (z + .5) * (z1 - z0) + z0)
    bev = min(bev, 0.49 * min(x1 - x0, y1 - y0, z1 - z0))
    E = list(bm.edges)
    if sharp:
        ax, val = "xyz".index(sharp[0]), sharp[1]
        E = [e for e in E if not all(abs(v.co[ax] - val) < 1e-6 for v in e.verts)]
    _bevel(bm, E, bev, seg)
    return from_bm(bm, key)


def box(size, at, key, bev=1.0, seg=2, web_keep=True):
    sx, sy, sz = size
    x, y, z = at
    return span(x - sx / 2, x + sx / 2, y - sy / 2, y + sy / 2, z - sz / 2, z + sz / 2, key, bev, seg, web_keep)


def rrect(w, d, r, n=6, cx=0.0, cy=0.0):
    """a CCW rounded rectangle outline"""
    r = min(r, w / 2 - 1e-3, d / 2 - 1e-3)
    n = max(1, nseg(n * 4, 4) // 4) if r > 0 else 0
    pts = []
    for qx, qy, a0 in ((1, 1, 0), (-1, 1, 90), (-1, -1, 180), (1, -1, 270)):
        ox, oy = cx + qx * (w / 2 - r), cy + qy * (d / 2 - r)
        if r <= 0 or n == 0:
            pts.append((cx + qx * w / 2, cy + qy * d / 2))
            continue
        for k in range(n + 1):
            a = math.radians(a0 + 90 * k / n)
            pts.append((ox + r * math.cos(a), oy + r * math.sin(a)))
    return pts


def _bm_from(V, faces):
    bm = bmesh.new()
    vs = [bm.verts.new(tuple(v)) for v in V]
    for f in faces:
        bm.faces.new([vs[i] for i in f])
    return bm


def _ccw(poly):
    P = [tuple(map(float, p)) for p in poly]
    area = sum(P[i][0] * P[(i + 1) % len(P)][1] - P[(i + 1) % len(P)][0] * P[i][1] for i in range(len(P)))
    return P if area > 0 else P[::-1]


def prism(poly, z0, z1, key, bev=1.0, seg=2, rims=True, verticals=False, web_keep=True):
    """an outline extruded z0..z1 (explicit winding: deterministic); bevels on the top/bottom rims
    (and optionally the verticals)"""
    if web() and not web_keep:
        return EMPTY
    P = _ccw(poly)
    n = len(P)
    V = [(x, y, z0) for x, y in P] + [(x, y, z1) for x, y in P]
    F = [list(range(n - 1, -1, -1)), list(range(n, 2 * n))] + [[i, (i + 1) % n, n + (i + 1) % n, n + i] for i in range(n)]
    bm = _bm_from(V, F)
    E = [e for e in bm.edges if (rims and abs(e.verts[0].co.z - e.verts[1].co.z) < 1e-6)
         or (verticals and abs(e.verts[0].co.z - e.verts[1].co.z) > 1e-6)]
    _bevel(bm, E, min(bev, 0.49 * abs(z1 - z0)), seg)
    return from_bm(bm, key)


def lathe(prof, seg, key, a0=0.0, a1=360.0):
    """revolve (r, z) about +z; a CCW profile faces outward, r == 0 points are poles"""
    full = abs(a1 - a0) >= 360.0
    n = seg if full else seg + 1
    ang = np.radians(a0 + (a1 - a0) * np.arange(n) / seg)
    ca, sa = np.cos(ang), np.sin(ang)
    V, rings = [], []
    closed = len(prof) > 2 and tuple(prof[0]) == tuple(prof[-1])
    for r, z in (prof[:-1] if closed else prof):
        b = len(V)
        if r <= 1e-9:
            V.append((0.0, 0.0, z))
            rings.append([b] * n)
        else:
            V.extend((r * c, r * s, z) for c, s in zip(ca, sa))
            rings.append(list(range(b, b + n)))
    L, C = [], []
    for A, B in zip(rings, rings[1:] + (rings[:1] if closed else [])):
        pa, pb = A[0] == A[-1], B[0] == B[-1]
        for j in range(seg):
            k = (j + 1) % n
            if pa and pb:
                continue
            if pa:
                L += [A[j], B[k], B[j]]
            elif pb:
                L += [A[j], A[k], B[j]]
            else:
                L += [A[j], A[k], B[k], B[j]]
            C.append(3 if (pa or pb) else 4)
    return Part(V, L, C, [kid(key)] * len(C))


def chamfered(r, z0, z1, b):
    """profile of a closed cylinder with 45° chamfers b on both rims"""
    b = min(b, r * 0.5, (z1 - z0) * 0.49)
    if b <= 0 or (web() and b < 1.0):
        return [(0, z0), (r, z0), (r, z1), (0, z1)]
    return [(0, z0), (r - b, z0), (r, z0 + b), (r, z1 - b), (r - b, z1), (0, z1)]


def cyl(r, z0, z1, key, seg=48, bev=0.5, at=(0, 0), web_keep=True):
    if web() and not web_keep:
        return EMPTY
    return lathe(chamfered(r, z0, z1, bev), nseg(seg), key).moved(t=(at[0], at[1], 0))


def ring(r0, r1, z0, z1, key, seg=48, bev=0.3):
    """a hollow cylinder (tube wall)"""
    b = 0 if web() else min(bev, (r1 - r0) * 0.45, (z1 - z0) * 0.45)
    P = [(r1 - b, z0), (r1, z0 + b), (r1, z1 - b), (r1 - b, z1), (r0 + b, z1), (r0, z1 - b), (r0, z0 + b), (r0 + b, z0)]
    return lathe(P + [P[0]], nseg(seg), key)


def frame_axis(d):
    """a rotation whose +z is along d"""
    d = np.asarray(d, float) / np.linalg.norm(d)
    up = np.array([0, 0, 1.0]) if abs(d[2]) < 0.9 else np.array([1.0, 0, 0])
    x = np.cross(up, d)
    x /= np.linalg.norm(x)
    return np.stack([x, np.cross(d, x), d], 1)


def bar(a, b, r, key, seg=16, bev=0.0):
    a, b = np.asarray(a, float), np.asarray(b, float)
    h = np.linalg.norm(b - a)
    return cyl(r, 0, h, key, seg, bev).moved(frame_axis(b - a), a)


def sweep(path, r, key, seg=12, closed=False, caps=True):
    """a circular section swept along a polyline (parallel-transport frames)"""
    P = np.asarray(path, float)
    n = nseg(seg, 5)
    T = np.gradient(P, axis=0)
    T /= np.linalg.norm(T, axis=1)[:, None]
    u = np.cross(T[0], [0, 0, 1.0])
    if np.linalg.norm(u) < 1e-6:
        u = np.cross(T[0], [1.0, 0, 0])
    u /= np.linalg.norm(u)
    V, L, C = [], [], []
    ang = np.linspace(0, 2 * math.pi, n, endpoint=False)
    for i, p in enumerate(P):
        if i:
            u = u - T[i] * (u @ T[i])
            u /= np.linalg.norm(u)
        w = np.cross(T[i], u)
        V.extend(p + r * (math.cos(a) * u + math.sin(a) * w) for a in ang)
    m = len(P)
    for i in range(m - 1 + (1 if closed else 0)):
        a0, b0 = (i % m) * n, ((i + 1) % m) * n
        for j in range(n):
            k = (j + 1) % n
            L += [a0 + j, b0 + j, b0 + k, a0 + k]
            C.append(4)
    if caps and not closed:
        for i, flip in ((0, True), (m - 1, False)):
            c = len(V)
            V.append(P[i])
            for j in range(n):
                k = (j + 1) % n
                L += [c, i * n + k, i * n + j] if flip else [c, i * n + j, i * n + k]
                C.append(3)
    return Part(V, L, C, [kid(key)] * len(C))


def fillet_path(pts, rad, n=6):
    """a polyline with its inner corners rounded by rad"""
    P = [np.asarray(p, float) for p in pts]
    out = [P[0]]
    for a, b, c in zip(P[:-2], P[1:-1], P[2:]):
        u, v = a - b, c - b
        lu, lv = np.linalg.norm(u), np.linalg.norm(v)
        u, v = u / lu, v / lv
        th = math.acos(max(-1.0, min(1.0, float(u @ v))))
        if th > math.pi - 1e-3:
            out.append(b)
            continue
        t = min(rad / math.tan(th / 2), 0.49 * lu, 0.49 * lv)
        p0, p1 = b + u * t, b + v * t
        for k in range(n + 1):
            s = k / n
            q = (1 - s) ** 2 * p0 + 2 * (1 - s) * s * b + s * s * p1
            out.append(q)
    out.append(P[-1])
    return out


def plate_holes(outer, holes, z0, z1, key, rim_key=None):
    """a flat plate with through holes (any winding); its walls in rim_key"""
    top = face_holes(outer, holes, z1, key)
    nv = len(top.V)
    V = np.concatenate([top.V, top.V - (0, 0, z1 - z0)])
    L, C = list(top.L), list(top.C)
    i = 0
    for c in top.C:
        L += [int(v) + nv for v in top.L[i:i + c][::-1]]
        C.append(c)
        i += c
    K_ = [kid(key)] * (2 * len(top.C))
    off = len(V)
    W = []
    for poly, sgn in [(_ccw(outer), 1)] + [(_ccw(h)[::-1], -1) for h in holes]:
        m = len(poly)
        base = off + len(W)
        W += [(x, y, z0) for x, y in poly] + [(x, y, z1) for x, y in poly]
        for j in range(m):
            k = (j + 1) % m
            L += [base + j, base + k, base + m + k, base + m + j]
            C.append(4)
            K_.append(kid(rim_key or key))
    return Part(np.concatenate([V, np.array(W, float)]), L, C, K_)


def face_holes(outer, holes, z, key, up=True):
    """a single flat face at height z with holes (triangulated)"""
    bm = bmesh.new()
    E = []
    for poly in [outer] + list(holes):
        vs = [bm.verts.new((x, y, z)) for x, y in poly]
        E += [bm.edges.new((vs[i], vs[(i + 1) % len(vs)])) for i in range(len(vs))]
    bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=E, normal=(0, 0, 1))
    for f in bm.faces:
        f.normal_update()
        if (f.normal.z < 0) == up:
            f.normal_flip()
    for e in [e for e in bm.edges if not e.link_faces]:
        bm.edges.remove(e)
    return from_bm(bm, key)


def circle(r, n, cx=0.0, cy=0.0, a0=0.0):
    return [(cx + r * math.cos(a0 + 2 * math.pi * k / n), cy + r * math.sin(a0 + 2 * math.pi * k / n)) for k in range(n)]


def stadium(w, h, cx, cy, n=6):
    """a slot outline (w along x, h along y, round ends)"""
    r = min(w, h) / 2
    return rrect(w, h, r * 0.999, n, cx, cy)


_TEXT = {}


def text(s, size, key, align="CENTER", depth=0.0, bold=False, web_keep=False):
    """flat (or extruded) text on the XY plane, baseline at y = 0, in mm"""
    if web() and not web_keep:
        return EMPTY
    ck = (s, size, align, depth, bold)
    if ck not in _TEXT:
        cu = bpy.data.curves.new("_kit_text", "FONT")
        cu.body, cu.size, cu.align_x = s, size, align
        cu.extrude = depth / 2
        cu.resolution_u = 2 if web() else 4
        if bold:
            cu.offset = size * 0.03
        ob = bpy.data.objects.new("_kit_text", cu)
        bpy.context.scene.collection.objects.link(ob)
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
        V = np.array([v.co[:] for v in me.vertices], float)
        if depth:
            V[:, 2] += depth / 2
        L = [i for p in me.polygons for i in p.vertices]
        C = [len(p.vertices) for p in me.polygons]
        _TEXT[ck] = (V, L, C)
        bpy.data.objects.remove(ob)
        bpy.data.curves.remove(cu)
        bpy.data.meshes.remove(me)
    V, L, C = _TEXT[ck]
    return Part(V, L, C, [kid(key)] * len(C))
