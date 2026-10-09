"""Robot cables (looks.json `cables`): a tube through stops (`via`): `@name` is a model's plug-point empty
rps_anchor.<name> (+Z out of the socket), {"on": part, "at": [x, y, z]} a frame0 world point riding a part
(a routing stop, e.g. over a deck edge), any other name a capture part (its vertex nearest the next stop).
Each stop rides the part that carries it. Between stops on different links a clip on the next link holds
the lead, so the slack loop sits at the joint; each span bows by its slack, clear of the bodies, and sags.
Control points are keyed on every (sub)frame and keep each span's frame0 length, so a lead loops and
straightens with its joint. Free spans bow downward when that side is clear (gravity), the ends leave their
sockets straight for 7 d (plug, boot, then the bend), and each end carries an overmoulded plug with a strain-relief
boot sized from d (or `plug_mm`). `drop_mm` gives the far end a right-angle plug turned along its anchor's +Y
(the way the lead leaves the module: a camera's lead runs down its back, never across the lens) and a
straight run of that length before its span. `offset_mm` moves the route's anchors (not the far socket)
along their +X. `ribbon` {keys, d_mm} draws the lead as bonded wires side by side (a servo bus lead), their
plane starting on the start plug's wide axis and carried along the lead without twist. A group is left out
when a model already supplies it (`cable_defer`: group -> object-name regex)."""
import re

import bpy
import numpy as np
from mathutils import Matrix

import looks
import pose
import prims

LIFT = 0.003                        # m off a part's surface
PLUG_D = (4.0, 2.2, 1.5)            # plug body along the lead, across, thick, in cable diameters
BOOT_D = (2.5, 1.45)                # strain-relief boot length and root diameter, in cable diameters
ELBOW_D = (3.0, 0.6)                # right-angle plug: turned body length, half-thickness, in cable diameters
CLIP_SLACK = 1.02
CLEAR_OK = 0.7                      # a bow side with >= this share of the best clearance may hang down
RIGID_MM = 2.0                      # a knot within this of a body's ride over the run rides that body; else it blends two


def unit(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-12 else v


def quats(Q):
    """[N,4] wxyz -> [N,3,3]"""
    w, x, y, z = (Q[:, i] for i in range(4))
    return np.stack([np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], -1),
                     np.stack([2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], -1),
                     np.stack([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)], -1)], 1)


class Parts:
    """the capture's robot parts: frame0 vertices, rows and the riding maths"""

    def __init__(self, B):
        self.B = B
        self.g = {g["name"]: g for g in B.cap["geoms"] if (g.get("name") or "").startswith("vis_") and g.get("mesh_id") is not None}
        self._R, self._V = {}, {}

    def verts(self, n):
        if n not in self._V:
            g, B = self.g[n], self.B
            r = B.first[g["i"]]
            self._V[n] = np.asarray(B.meshes["v%d" % g["mesh_id"]], np.float64) @ pose.quat_mat(r[3:7]).T + r[0:3]
        return self._V[n]

    def rows(self, n):
        if n not in self._R:
            X = self.B.rows(self.g[n])
            self._R[n] = (X[:, 0:3], quats(X[:, 3:7]))
        return self._R[n]

    def ride(self, n, q):
        """[N,3]: a frame0 world point carried by part n over the capture"""
        r = self.B.first[self.g[n]["i"]]
        loc = pose.quat_mat(r[3:7]).T @ (np.asarray(q, float) - r[0:3])
        P, R = self.rows(n)
        return np.einsum("nij,j->ni", R, loc) + P

    def turn(self, n, v):
        r = self.B.first[self.g[n]["i"]]
        _, R = self.rows(n)
        return np.einsum("nij,jk,k->ni", R, pose.quat_mat(r[3:7]).T, v)

    def body(self, n):
        return self.g[n].get("body")


def anchors(P):
    """rps_anchor.<name> -> (frame0 point, +Z, +X, carrying part, +Y): the part that predicts the empty's
    place best at two later frames"""
    obs = [o for o in bpy.data.objects if o.name.startswith("rps_anchor.")]
    if not obs:
        return {}
    sc, B = bpy.context.scene, P.B
    n = len(B.frames)
    probe = [0, n // 3, 2 * n // 3]
    seen = []
    for j in probe:
        f = B.frames[j]
        sc.frame_set(int(f), subframe=float(f - int(f)))
        seen.append({o.name: (np.array(o.matrix_world.translation), np.array(o.matrix_world.col[2][:3]),
                              np.array(o.matrix_world.col[0][:3]), np.array(o.matrix_world.col[1][:3])) for o in obs})
    sc.frame_set(int(B.frames[0]))
    out = {}
    for o in obs:
        p0, z0, x0, y0 = seen[0][o.name]
        cand = sorted(P.g, key=lambda k: float(np.min(np.linalg.norm(P.verts(k) - p0, axis=1))))[:12]

        def err(k):
            return sum(float(np.linalg.norm(P.ride(k, p0)[j] - s[o.name][0])) for j, s in zip(probe[1:], seen[1:]))
        out[o.name[len("rps_anchor."):]] = (p0, unit(z0), unit(x0), min(cand, key=err), unit(y0))
    return out


def stops(P, A, via, off_mm):
    """[(frame0 point, out dir, part)] for the via list"""
    out = []

    def centre(s):
        return np.asarray(s["at"], float) if isinstance(s, dict) else A[s[1:]][0] if s.startswith("@") else P.verts(s).mean(0)
    for k, v in enumerate(via):
        if isinstance(v, dict):
            out.append((np.asarray(v["at"], float), unit(np.asarray(v.get("n", (0.0, 0.0, 1.0)), float)), v["on"]))
            continue
        if v.startswith("@"):
            p, z, x, part = A[v[1:]][:4]
            out.append((p + x * off_mm * 0.001 * (k + 1 < len(via)), z, part))
            continue
        W = P.verts(v)
        nb = [s for s in (via[k - 1] if k else None, via[k + 1] if k + 1 < len(via) else None) if s]
        aim = np.mean([centre(s) for s in nb], 0)
        p = W[np.argmin(np.linalg.norm(W - aim, axis=1))]
        out.append((p, unit(p - W.mean(0)), v))
    return out


def clip(P, a, b, part_b):
    """(point, part): on the next link's printed parts near 40 % of the way from a to b, or None"""
    body = P.body(part_b)
    names = [n for n in P.g if P.g[n].get("body") == body and "3215" not in n]
    if not names:
        return None
    t = a + 0.4 * (b - a)
    best = min((float(np.min(np.linalg.norm(P.verts(n) - t, axis=1))), n) for n in names)
    if best[0] > 0.04:
        return None
    W = P.verts(best[1])
    p = W[np.argmin(np.linalg.norm(W - t, axis=1))]
    return p + unit(p - W.mean(0)) * LIFT, best[1]


def bow(a0, b0, clear, s):
    """the frame0 bow point: s off the chord toward the side farthest from the clearance points"""
    d = unit(b0 - a0)
    e1 = unit(np.cross(d, [0.0, 0.0, 1.0]) if abs(d[2]) < 0.9 else np.cross(d, [1.0, 0.0, 0.0]))
    e2 = np.cross(d, e1)
    mid, cand = (a0 + b0) / 2, []
    for k in range(12):
        ang = 2 * np.pi * k / 12
        m = mid + s * (np.cos(ang) * e1 + np.sin(ang) * e2)
        cand.append((sum(float(np.min(np.linalg.norm(clear - q, axis=1))) for q in (a0 + (m - a0) * 0.6, m, b0 + (m - b0) * 0.6)), m))
    top = max(c for c, _ in cand)
    return min((m for c, m in cand if c >= CLEAR_OK * top), key=lambda m: m[2])      # the lowest clear side


def span(P, a, b, pa, pb, clear, slack, sag):
    """[N,3]: the bow point between tracks a (on part pa) and b (on pb), keeping the frame0 length"""
    a0, b0 = a[0], b[0]
    c0 = float(np.linalg.norm(b0 - a0))
    s0 = c0 * np.sqrt(3 * max(slack - 1, 0.0) / 8)
    arc = c0 + 8 * s0 * s0 / (3 * max(c0, 1e-6))
    d0 = bow(a0, b0, clear, max(s0, 1e-4)) - (a0 + b0) / 2
    d = 0.5 * (P.turn(pa, d0) + P.turn(pb, d0))
    ch = b - a
    c = np.linalg.norm(ch, axis=1, keepdims=True)
    d -= ch * (np.sum(d * ch, 1, keepdims=True) / np.maximum(c * c, 1e-12))
    d /= np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)
    s = np.sqrt(np.maximum(3 * c * (arc - c) / 8, 0.0))
    return (a + b) / 2 + d * s - [0.0, 0.0, sag]


def route(P, S, slack, sag, lead_mm):
    """[N, K, 3] control points: the stops (the ends pushed out of their sockets by lead_mm = (start, end)),
    a clip where the lead changes link, a bow point in each span"""
    clear = np.concatenate([P.verts(n)[::7] for n in P.g if P.g[n].get("body") in {P.body(s[2]) for s in S}])
    L0, L1 = (v * 0.001 for v in lead_mm)
    knots = []                      # (track, part)
    for k, (p, z, part) in enumerate(S):
        pts = [p, p + z * L0] if k == 0 else [p + z * L1, p] if k == len(S) - 1 else [p + z * LIFT]
        if k:
            a, pa = knots[-1]
            cl = clip(P, a[0], pts[0], part) if P.body(pa) != P.body(part) else None
            sl = slack
            if cl is not None:
                ct = P.ride(cl[1], cl[0])
                knots.append((span(P, a, ct, pa, cl[1], clear, slack, sag), None))
                knots.append((ct, cl[1]))
                a, pa, sl = ct, cl[1], CLIP_SLACK
            knots.append((span(P, a, P.ride(part, pts[0]), pa, part, clear, sl, sag), None))
        knots += [(P.ride(part, q), part) for q in pts]
    return np.stack([t for t, _ in knots], 1)


def knot_bodies(P, T):
    """[[body, body]] per knot of T: the body whose ride carries it, or the two it blends across a joint"""
    by_body, F = {}, np.linspace(0, len(T) - 1, 24).astype(int)
    for n, g in P.g.items():
        by_body.setdefault(g.get("body"), n)
    err = {b: np.array([np.abs(P.ride(n, T[0, j])[F] - T[F, j]).max() * 1000 for j in range(T.shape[1])])
           for b, n in by_body.items() if b}
    out = []
    for j in range(T.shape[1]):
        b = min(err, key=lambda k: err[k][j])
        out.append([b, b] if err[b][j] < RIGID_MM else None)
    for j, b in enumerate(out):                         # a bow between two links blends its neighbours' bodies
        if b is None:
            lo = next((out[i][0] for i in range(j - 1, -1, -1) if out[i]), None)
            hi = next((out[i][0] for i in range(j + 1, len(out)) if out[i]), lo)
            out[j] = [lo or hi, hi or lo]
    return out


def plug_dims(dia, size):
    """half length, half width, half thickness (m) of a plug body"""
    return tuple((v * 0.0005 for v in size) if size else (k * dia / 2 for k in PLUG_D))


def square(v, d):
    """v made square to d"""
    v = np.asarray(v, float) - d * float(np.dot(v, d))
    return unit(v) if np.linalg.norm(v) > 0.2 else unit(np.cross(d, [1.0, 0.0, 0.0]))


def elbow(p, d, v, dia, size):
    """a right-angle plug in socket (p, +d) turned along v: (a point inside its boot, the exit direction, the
    boot length left to run)"""
    L, w, t = plug_dims(dia, size)
    v, bl = square(v, d), BOOT_D[0] * dia
    return p + d * (2 * L - ELBOW_D[1] * dia) + v * (ELBOW_D[0] * dia + 0.5 * bl), v, 0.5 * bl


def plug_sizes(c):
    s = c.get("plug_mm")
    return s if s and isinstance(s[0], list) else [s, s]          # [start, end] or one size


def lead(P, A, c):
    """(stops, far socket (point, out, part), its turn or None, [N, K, 3] control points) of cable c"""
    S = stops(P, A, c["via"], c.get("offset_mm", 0.0))
    dia, sizes = c.get("d_mm", 1.6), plug_sizes(c)
    ends = [c.get("lead_mm", max(6.0, 7 * dia))] * 2
    sock, turn = S[-1], None
    if c.get("drop_mm"):
        far = c["via"][-1]
        turn = square(A[far[1:]][4] if isinstance(far, str) and far.startswith("@") else (0.0, 0.0, -1.0), sock[1])
        e, v, rest = elbow(sock[0], sock[1], turn, dia * 0.001, sizes[1])
        S[-1], ends[1] = (e, v, sock[2]), rest * 1000 + c["drop_mm"]
    return S, sock, turn, route(P, S, c.get("slack", 1.05), c.get("sag_mm", 3) * 0.001, ends)


def ribbon(P, S, T, rb):
    """[(key, [N, K, 3])]: one control-point track per wire, offset across the lead (parallel transport of the
    start plug's wide axis, which rides the start part)"""
    d0 = unit(T[0, 1] - T[0, 0])
    u0 = unit(np.cross(d0, [0.0, 0.0, 1.0]) if abs(d0[2]) < 0.9 else np.cross(d0, [1.0, 0.0, 0.0]))
    side = P.turn(S[0][2], u0)
    K = T.shape[1]
    U = np.zeros_like(T)
    for j in range(K):
        t = T[:, min(j + 1, K - 1)] - T[:, max(j - 1, 0)]
        t /= np.maximum(np.linalg.norm(t, axis=1, keepdims=True), 1e-12)
        side = side - t * np.sum(side * t, 1, keepdims=True)
        side /= np.maximum(np.linalg.norm(side, axis=1, keepdims=True), 1e-12)
        U[:, j] = side
    pitch, keys = rb.get("d_mm", 1.1) * 0.001, rb["keys"]
    mid = (len(keys) - 1) / 2
    return [(k, T + U * (i - mid) * pitch) for i, k in enumerate(keys)]


def tube(name, T, radius, key, B, col, frames):
    """a NURBS tube through control-point track T [N, K, 3], keyed over the frames when it moves"""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions, cu.bevel_depth, cu.bevel_resolution = "3D", radius, 3
    cu.resolution_u = 8
    sp = cu.splines.new("NURBS")
    sp.points.add(T.shape[1] - 1)
    for p, q in zip(sp.points, T[0]):
        p.co = (*q, 1.0)
    sp.use_endpoint_u, sp.order_u = True, min(4, T.shape[1])
    if np.ptp(T, axis=0).max() > 1e-7:
        for j in range(T.shape[1]):
            prims.key(cu, "splines[0].points[%d].co" % j, frames, np.concatenate([T[:, j], np.ones((len(T), 1))], 1))
    cu.materials.append(looks.build(bpy, key, looks.lookup(key, B.decor, B.table), False, B.emit))
    ob = bpy.data.objects.new(name, cu)
    col.objects.link(ob)
    if hasattr(ob, "cycles") and hasattr(ob.cycles, "motion_steps"):
        ob.cycles.motion_steps = 2
    return ob


def box(c, axes, half):
    """8 corners and 6 quads of a box at c on 3 axes"""
    V = [c + sx * half[0] * axes[0] + sy * half[1] * axes[1] + sz * half[2] * axes[2]
         for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    return V, [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]


def plug(name, p, d, key, B, col, dia, size=None, turned=None):
    """the lead's end at socket p: an overmoulded body (its long side along d, world, frame0) then a tapered
    strain-relief boot onto the jacket; `turned`: a right-angle body whose boot leaves along that direction"""
    L, w, t = plug_dims(dia, size)
    n, bl, r0, r1 = 10, BOOT_D[0] * dia, BOOT_D[1] * dia / 2, 0.56 * dia
    if turned is not None:
        v = square(turned, d)
        u = np.cross(v, d)
        te, E = ELBOW_D[1] * dia, ELBOW_D[0] * dia
        V, F = box(p + d * L, (d, u, v), (L, w, t))
        V2, F2 = box(p + d * (2 * L - te) + v * (E - t) / 2, (d, u, v), (te, w, (E + t) / 2))
        V, F = V + V2, F + [tuple(i + 8 for i in f) for f in F2]
        o, ax, rr = p + d * (2 * L - te), v, ((E, min(r0, w, te)), (E + bl, r1))
    else:
        u = unit(np.cross(d, [0.0, 0.0, 1.0]) if abs(d[2]) < 0.9 else np.cross(d, [1.0, 0.0, 0.0]))
        v = np.cross(d, u)
        V, F = box(p + d * L, (d, u, v), (L, w, t))
        o, ax, rr = p, d, ((2 * L, min(r0, w, t)), (2 * L + bl, r1))
    e1 = unit(np.cross(ax, u))
    b0 = len(V)
    for z, r in rr:
        V += [o + ax * z + r * (np.cos(a) * u + np.sin(a) * e1) for a in np.linspace(0, 2 * np.pi, n, endpoint=False)]
    F += [(b0 + i, b0 + (i + 1) % n, b0 + n + (i + 1) % n, b0 + n + i) for i in range(n)]
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(x) for x in V], [], F)
    me.shade_smooth()
    me.materials.append(looks.build(bpy, key, looks.lookup(key, B.decor, B.table), False, B.emit))
    ob = bpy.data.objects.new(name, me)
    col.objects.link(ob)
    return ob


def follower(B, col, g, cache):
    """an empty on geom g's frame over the capture (keyed on every subframe) and its frame0 matrix"""
    if g["i"] not in cache:
        em = bpy.data.objects.new("lead_" + g["name"], None)
        col.objects.link(em)
        em.rotation_mode = "QUATERNION"
        X = B.rows(g)
        em.location, em.rotation_quaternion = X[0, 0:3], X[0, 3:7]
        if g["moving"]:
            prims.key(em, "location", B.frames, X[:, 0:3])
            prims.key(em, "rotation_quaternion", B.frames, pose.continuous(X[:, 3:7]))
        M = np.eye(4)
        M[:3, :3], M[:3, 3] = pose.quat_mat(X[0, 3:7]), X[0, 0:3]
        cache[g["i"]] = (em, M)
    return cache[g["i"]]


def deferred(B):
    names = [o.name for o in bpy.data.objects]
    return {grp for grp, rx in (B.table.get("cable_defer") or {}).items() if any(re.search(rx, n) for n in names)}


def build(B, objects=None):
    """the cables of looks.json over the capture; returns their object names"""
    P = Parts(B)
    A = anchors(P)
    skip, made, col, cache = deferred(B), [], None, {}
    for k, c in enumerate(B.table.get("cables") or []):
        names = [v["on"] if isinstance(v, dict) else v for v in c["via"]]
        miss = [v for v in names if (v[1:] not in A if v.startswith("@") else v not in P.g)]
        if miss:
            print("cables: %s skipped (missing %s)" % (" -> ".join(names), ", ".join(miss)))
        if c.get("group") in skip or miss:
            continue
        if col is None:
            col = bpy.data.collections.new("cables")
            bpy.context.scene.collection.children.link(col)
        S, sock, turn, T = lead(P, A, c)
        dia, sizes = c.get("d_mm", 1.6), plug_sizes(c)
        name = "cable%d_%s" % (k, c.get("group", "lead"))
        rb = c.get("ribbon")
        if rb:
            for i, (key, Ti) in enumerate(ribbon(P, S, T, rb)):
                tube(name if i == 0 else "%s_w%d" % (name, i), Ti, rb.get("d_mm", 1.1) * 0.0005, key, B, col, B.frames)
        else:
            tube(name, T, dia * 0.0005, c.get("key", "cable"), B, col, B.frames)
        if c.get("plug"):
            for j, end, d in ((0, T[0, 0], unit(T[0, 1] - T[0, 0])), (len(S) - 1, T[0, -1], unit(T[0, -2] - T[0, -1]))):
                turned = turn if j > 0 else None
                if turned is not None:
                    end, d = sock[0], sock[1]
                pl = plug(name + "_plug%d" % j, end, d, c["plug"], B, col, dia * 0.001, sizes[j > 0], turned)
                em, M = follower(B, col, P.g[S[j][2]], cache)
                pl.parent = em
                pl.matrix_parent_inverse = Matrix(np.linalg.inv(M).tolist())
        made.append(name)
    return made
