"""The build's extras on the robot, visual only (REAL_ROBOT_MATCH §3): the fingertip covers (glove thumbs: a nitrile-
coated grip face, a knit back, a raw cut edge; the grip face on the MJCF pad cover geoms), the velcro strap on the upper arm, the battery in its black tray at its real place (the package's
battery and mount are hidden), the inline rocker switch on the lower deck, the 12V DC sticker on the arm base,
white hook-and-loop pads, a bus adapter board on the WaveShare plate, and the plug-point empties of their leads:
rps_anchor.batt_dc, switch.0 / switch.1, driver_dc, adapter_usb (base) and strap (lift, the bus lead's stop)."""
import math

import bmesh
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

import _bl as B
import _kit as K
import _robot as R
import robot_dress as D

ROLE = "robot"
FINGERS = {"finger_L": ("^vis_pincopen_removable_tip$", "^vis_pincopen_tip_support$", "^vis_pincopen_distal_shell_2$"),
           "finger_R": ("^vis_pincopen_removable_tip_2$", "^vis_pincopen_tip_support_2$", "^vis_pincopen_distal_shell$")}
PINS = ["^vis_pincopen_%s$" % n for n in ("distal_rod", "distal_rod_2", "external_rod", "external_rod_2", "internal_rod", "internal_rod_2")]
COVER = dict(mm=1.2, length=33.0, coat=0.5, toe=9.0, tongue=3.5, cuff=4.0, dome=2.5, slack=0.3, fold=0.25, fray=0.4)
"""mm: the knit, all round (sim-physics.js PAD_COVER.mm); coat: the section's share coated down from the grip face; toe:
the coated tip, less the knit's tongue mid-back; cuff: the coated open end; dome: fullness past the tip; slack, fold, fray"""
BATT = dict(c=(62.0, -62.0), yaw=-45.0, L=96.0, W=66.0, H=36.0, wall=2.0, lip=14.0, z=3.5)
SWITCH = dict(c=(-55.0, -20.0), L=58.0, W=27.0, H=17.0, z=3.5)
DRIVER_DC = ((-14.5, 60.0, 17.0), (-1.0, 0.0, 0.0))          # the driver board terminal block
PADS = [((55.0, -36.0), 8.0), ((58.0, -66.0), -5.0)]     # two small pads by the Pi case's corner, apart
TOP = 57.0                                   # the top deck's upper face (base frame, mm)


def hull2(P):
    P = sorted(set(map(tuple, np.round(np.asarray(P, float), 4))))
    if len(P) < 3:
        return np.array(P)

    def half(pts):
        h = []
        for p in pts:
            while len(h) >= 2 and (h[-1][0] - h[-2][0]) * (p[1] - h[-2][1]) - (h[-1][1] - h[-2][1]) * (p[0] - h[-2][0]) <= 0:
                h.pop()
            h.append(p)
        return h
    lo, hi = half(P), half(P[::-1])
    return np.array(lo[:-1] + hi[:-1])


def radii(H, c, ang):
    """distance from c along each angle to the convex outline H"""
    d = np.stack([np.cos(ang), np.sin(ang)], 1)
    A, Bq = H - c, np.roll(H, -1, 0) - c
    E = Bq - A
    out = np.zeros(len(ang))
    for i, v in enumerate(d):
        den = v[0] * E[:, 1] - v[1] * E[:, 0]
        ok = np.abs(den) > 1e-12
        t = np.where(ok, (A[:, 0] * E[:, 1] - A[:, 1] * E[:, 0]) / np.where(ok, den, 1), -1)
        s = np.where(ok, (A[:, 0] * v[1] - A[:, 1] * v[0]) / np.where(ok, den, 1), -1)
        hit = ok & (t > 0) & (s >= -1e-9) & (s <= 1 + 1e-9)
        out[i] = t[hit].min() if hit.any() else 0.0
    return out


def loft(rings, keys, closed_profile=False):
    """quads between consecutive rings ([M, n, 3], ring loops closed), a key per quad [M-1, n]"""
    M, n = rings.shape[:2]
    V = rings.reshape(-1, 3)
    L, C, Kk = [], [], []
    for i in range(M - 1 + (1 if closed_profile else 0)):
        a, b = (i % M) * n, ((i + 1) % M) * n
        for j in range(n):
            k = (j + 1) % n
            L += [a + j, a + k, b + k, b + j]
            C.append(4)
            Kk.append(K.kid(keys[i % len(keys)][j]))
    return K.Part(V, L, C, Kk)


def outward(p, centre):
    """flip p's faces when its first face points toward centre"""
    i0 = p.L[:3]
    n = np.cross(p.V[i0[1]] - p.V[i0[0]], p.V[i0[2]] - p.V[i0[0]])
    if n @ (p.V[i0[0]] - centre) >= 0:
        return p
    L, s = p.L.copy(), 0
    for c in p.C:
        L[s:s + c] = L[s:s + c][::-1]
        s += c
    return K.Part(p.V, L, p.C, p.K)


def sections(V, ax, u, v, s_list, slab):
    """(centre 2D, convex outline) of V across ax at each s"""
    s = V @ ax
    P2 = np.c_[V @ u, V @ v]
    out = []
    for q in s_list:
        m = np.abs(s - q) < slab
        if m.sum() < 3:
            m = np.argsort(np.abs(s - q))[:12]
        H = hull2(P2[m])
        out.append((H.mean(0), H))
    return out


def hull3(P):
    """the convex hull of P: (vertices, edges)"""
    bm = bmesh.new()
    [bm.verts.new(p) for p in np.unique(np.round(P, 4), axis=0)]
    bmesh.ops.convex_hull(bm, input=list(bm.verts))
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.verts.index_update()
    V = np.array([v.co[:] for v in bm.verts])
    E = np.array([[e.verts[0].index, e.verts[1].index] for e in bm.edges])
    tree = BVHTree.FromBMesh(bm)
    bm.free()
    return V, E, tree


def slice2(V, E, s, ax, u, v):
    """the hull's convex section at ax = s, in (u, v), CCW"""
    a, b = V[E[:, 0]] @ ax - s, V[E[:, 1]] @ ax - s
    k = (a * b <= 0) & (a != b)
    X = V[E[k, 0]] + (V[E[k, 1]] - V[E[k, 0]]) * (a[k] / (a[k] - b[k]))[:, None]
    return hull2(np.c_[X @ u, X @ v])


def grown(Q, r, step=math.radians(3)):
    """the convex outline Q (CCW) grown by r: dense points and their outward normal angle (continuous, rising)"""
    e = np.roll(Q, -1, 0) - Q
    ae = np.arctan2(-e[:, 0], e[:, 1])
    P, A, a = [], [], ae[-1]
    for i in range(len(Q)):
        da = (ae[i] - ae[i - 1]) % (2 * math.pi)
        for t in np.linspace(0, da, max(1, int(math.ceil(da / step))) + 1):
            P.append(Q[i] + r * np.array([math.cos(a + t), math.sin(a + t)]))
            A.append(a + t)
        a += da
    return np.array(P), np.array(A)


def ring(Q, r, ub, counts, lam=2.0, dg=math.radians(4)):
    """one section of the cover: Q grown by r, sampled from the grip face (normal +u) round, with vertices on the
    grip face's ends (normal +-dg) and on the coating's edge u = ub each side; spacing by length + lam * turn.
    -> points, outward normals (2D)"""
    P, A = grown(Q, r)
    P, A = np.r_[P, P[:1]], np.r_[A, A[:1] + 2 * math.pi]
    W = np.r_[0, np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1) + lam * np.diff(A))]
    at = lambda w, X: np.array([np.interp(w, W, X[:, k]) for k in range(X.shape[1])]).T
    wa = lambda a0: np.interp((a0 - A[0]) % (2 * math.pi) + A[0], A, W)
    g0, g1 = wa(-dg), wa(dg)
    g1 += W[-1] * (g1 < g0)
    ws = np.linspace(g1, g1 + W[-1], 4000) % W[-1]
    below = at(ws, P)[:, 0] < ub
    b1, b2 = ws[np.argmax(below)], ws[len(ws) - 1 - np.argmax(below[::-1])]
    seg = lambda w0, w1, k: np.linspace(w0, w0 + (w1 - w0) % W[-1], k + 1)[:-1] % W[-1]
    w = np.r_[seg(g0, g1, counts[0]), seg(g1, b1, counts[1]), seg(b1, b2, counts[2]), seg(b2, g0, counts[1])]
    a = np.interp(w, W, A)
    return at(w, P), np.c_[np.cos(a), np.sin(a)]


def push(p, d, tree, r):
    """p moved along d until it is r off the hull (never in)"""
    dist = lambda t: tree.find_nearest(Vector(p + d * t))[3]
    if dist(0.0) >= r - 1e-4:
        return p
    lo, hi = 0.0, r
    while dist(hi) < r:
        hi *= 2
    for _ in range(20):
        lo, hi = (lo, (lo + hi) / 2) if dist((lo + hi) / 2) >= r else ((lo + hi) / 2, hi)
    return p + d * hi


def two_tone(V, T, F, a, b):
    """triangles T over V cut along max(F) = 0 (F per vertex, a column per coated region): key a where >= 0, else b"""
    V, L, Kk, cut, G = list(V), [], [], {}, F.max(1)

    def mid(i, j):
        if abs(G[i]) < 1e-4 or abs(G[j]) < 1e-4:
            return i if abs(G[i]) < 1e-4 else j
        k = (min(i, j), max(i, j))
        if k not in cut:
            d = F[j] - F[i]
            t = min(np.clip(-F[i] / np.where(np.abs(d) > 1e-12, d, 1e-12), 0, 1), key=lambda x: abs((F[i] + x * d).max()))
            cut[k] = len(V)
            V.append(V[i] + (V[j] - V[i]) * t)
        return cut[k]
    for t in T:
        s = [G[i] >= 0 for i in t]
        if s[0] == s[1] == s[2]:
            L += list(t)
            Kk.append(a if s[0] else b)
            continue
        k = next(k for k in range(3) if s[k] != s[(k + 1) % 3] and s[k] != s[(k + 2) % 3])
        l, m, n = t[k], t[(k + 1) % 3], t[(k + 2) % 3]
        e1, e2 = mid(l, m), mid(l, n)
        for tri, key in (((l, e1, e2), s[k]), ((e1, m, n), not s[k]), ((e1, n, e2), not s[k])):
            if len(set(tri)) == 3:
                L += tri
                Kk.append(a if key else b)
    return K.Part(np.array(V), L, np.full(len(Kk), 3), [K.kid(x) for x in Kk])


def cover(ctx, rxs, other, extra):
    """a glove thumb over a finger's tip end: a sock of knit COVER mm off the tip's convex hull (taut: its flat grip face is
    the MJCF pad cover's), a domed toe, the open end loose and cut raw; the coating on the grip face, the lower sides, the
    toe and a cuff, the knit on the back and upper sides.  extra: this finger's other parts (this frame), e.g. its pin"""
    r = COVER["mm"]
    V = np.concatenate([R.mesh(ctx, rx)[0] for rx in rxs])
    c0 = V.mean(0)
    _, E = np.linalg.eigh(np.cov((V - c0).T))
    ax = E[:, 2] * (1 if c0 @ E[:, 2] > 0 else -1)          # away from the finger's joint (its body origin)
    grip = other - c0
    u = np.eye(3)[int(np.argmax(np.abs(grip)))] * np.sign(grip[int(np.argmax(np.abs(grip)))])   # the body axis the jaw closes on
    ax = ax - u * (ax @ u)
    ax /= np.linalg.norm(ax)
    v, end = np.cross(ax, u), float((V @ ax).max())
    s0 = end - min(COVER["length"], float(np.ptp(V @ ax)) - 2.0)
    P = np.concatenate([V, extra])
    HV, HE, tree = hull3(P[P @ ax > s0 - 1.5])
    tip, web = end - 0.25, K.web()
    counts = (6, 9, 22) if web else (16, 20, 40)
    zones = [(s0, s0 + 7, 3 if web else 10), (s0 + 7, end - 12, 6 if web else 20), (end - 12, tip, 7 if web else 24)]
    S = np.concatenate([np.linspace(a, b, k, endpoint=False) for a, b, k in zones] + [[tip]])
    n = sum(counts) + counts[1]
    q = np.r_[np.zeros(counts[0] + counts[1]), np.arange(counts[2]) / counts[2], np.zeros(counts[1])]     # across the back
    rings, F, prev = [], [], None
    for i, s in enumerate(S):
        Q = slice2(HV, HE, s, ax, u, v)
        Q = prev = Q if len(Q) >= 3 else prev
        lo, hi = Q[:, 0].min() - r, Q[:, 0].max() + r
        ub = hi - (hi - lo) * COVER["coat"] - 0.3 * math.sin(0.45 * s)     # the dip line, gently wavy
        P2, N2 = ring(Q, r, ub, counts)
        t, k = np.clip((s - s0) / 7.0, 0, 1), np.arange(n) / n
        P2 = P2 + N2 * ((1 - t) ** 2 * (COVER["slack"] + COVER["fold"] * (0.5 + 0.5 * np.sin(2 * math.pi * 6 * k + 0.7 * s))))[:, None]
        fray = COVER["fray"] * (np.sin(2 * math.pi * 7 * k + 1.3) * 0.6 + np.sin(2 * math.pi * 13 * k + 0.4) * 0.4) if i == 0 else 0 * k
        R3 = np.array([push(P2[j, 0] * u + P2[j, 1] * v + (s + fray[j]) * ax, N2[j, 0] * u + N2[j, 1] * v, tree, r) for j in range(n)])
        rings.append(R3)
        toe = s - (end - COVER["toe"] + COVER["tongue"] * np.sin(math.pi * q))
        cuff = s0 + COVER["cuff"] * (1 + 0.1 * np.sin(2 * math.pi * 3 * k)) - s
        F.append(np.c_[R3 @ u - ub, toe, cuff])
    last = rings[-1]
    cc = last.mean(0) - ax * (last.mean(0) @ ax - tip)
    H, J = end - tip + r + COVER["dome"], 6 if web else 12
    for j in range(1, J + 1):                              # the toe
        th = j / (J + 1) * math.pi / 2
        D = (last - cc - ax * ((last - cc) @ ax)[:, None]) * math.cos(th) ** 0.6
        rings.append(np.array([push(cc + d + ax * H * math.sin(th), d / max(np.linalg.norm(d), 1e-9), tree, r) for d in D]))
        F.append(np.ones((n, 3)))
    M = len(rings)
    T = [t for i in range(M - 1) for j in range(n) for t in (((i * n + j, i * n + (j + 1) % n, (i + 1) * n + (j + 1) % n)),
                                                               (i * n + j, (i + 1) * n + (j + 1) % n, (i + 1) * n + j))]
    T += [((M - 1) * n + j, (M - 1) * n + (j + 1) % n, M * n) for j in range(n)]          # closed at the apex
    shell = two_tone(np.r_[np.concatenate(rings), [cc + ax * H]], T, np.r_[np.concatenate(F), np.ones((1, 3))], "nitrile_coat", "fabric_knit_blue")
    first = rings[0]
    N0 = np.cross(np.roll(first, -1, 0) - np.roll(first, 1, 0), ax)
    N0 /= np.linalg.norm(N0, axis=1)[:, None]
    d = np.array([tree.find_nearest(Vector(p))[3] for p in first]) - 0.15
    lip = loft(np.array([first, first - N0 * d[:, None] - ax * 0.15]), [["fabric_knit_blue"] * n])     # the raw cut edge, snug
    return [outward(shell, c0), outward(lip, first.mean(0) + ax * 5)]


def strap(ctx):
    """a 20 mm hook-and-loop band round the upper arm at mid-length, lifted over the bus lead, with a pull tab;
    and the lead's stop under it (point, out)"""
    V = R.mesh(ctx, R.BODY["lift"])[0]
    c0 = V.mean(0)
    _, E = np.linalg.eigh(np.cov((V - c0).T))
    ax = E[:, 2]
    u = E[:, 1]
    v = np.cross(ax, u)
    sm = float((V @ ax).min() + (V @ ax).max()) / 2
    (c, H), = sections(V, ax, u, v, [sm], 10.0)
    canon = R.mesh(ctx, R.CANON)[0]
    a = R.sockets(*R.servo_frame(ctx, "pan", R.SERVOS[1][1], canon))[0][1]
    b = R.sockets(*R.servo_frame(ctx, "lift", R.SERVOS[2][1], canon))[0][0]
    mid = (R.apply(R.rel(ctx, "lift", "pan"), a[None])[0] + b) / 2
    tc = math.atan2(mid @ v - c[1], mid @ u - c[0])
    n = K.nseg(40, 16)
    ang = np.linspace(0, 2 * math.pi, n, endpoint=False)
    r = radii(H, c, ang)
    d = np.angle(np.exp(1j * (ang - tc)))
    bump = 3.6 * np.exp(-(d * np.maximum(r, 5) / 5.0) ** 2)
    prof = [(-10, 0.4), (-10, 1.8), (-9, 2.2), (9, 2.2), (10, 1.8), (10, 0.4)]
    rings = [[c[0] * u + c[1] * v + (sm + dz) * ax + (r[j] + o + bump[j]) * (math.cos(t) * u + math.sin(t) * v)
              for j, t in enumerate(ang)] for dz, o in prof]
    band = outward(loft(np.array(rings), [["velcro_grey"] * n], closed_profile=True), c[0] * u + c[1] * v + sm * ax + ax * 30)
    j = int(np.argmin(np.abs(np.angle(np.exp(1j * (ang - tc - 1.9))))))
    out = math.cos(ang[j]) * u + math.sin(ang[j]) * v
    p = c[0] * u + c[1] * v + sm * ax + (r[j] + 2.2) * out
    tab = K.span(-10, 10, 0, 14, 0, 1.8, "velcro_grey", 0.6, 2).moved(np.stack([ax, np.cross(out, ax), out], 1), p)
    rs = float(radii(H, c, np.array([tc]))[0])
    at = c[0] * u + c[1] * v + sm * ax + rs * (math.cos(tc) * u + math.sin(tc) * v)
    return [band, tab], (at, math.cos(tc) * u + math.sin(tc) * v)


def battery():
    """the pack in its open black tray on the lower plate, poking out past the plate edge"""
    b = BATT
    Rz = K.rot("z", b["yaw"])
    hl, hw, w = b["L"] / 2 + b["wall"] + 1, b["W"] / 2 + b["wall"] + 1, b["wall"]
    P = [K.span(-hl, hl, -hw, hw, 0, w, "pla_dark", 0.6, 2),
         K.span(-hl, -hl + w, -hw, hw, w, b["lip"], "pla_dark", 0.5, 2), K.span(hl - w, hl, -hw, hw, w, b["lip"], "pla_dark", 0.5, 2),
         K.span(-hl + w, hl - w, -hw, -hw + w, w, b["lip"], "pla_dark", 0.5, 2), K.span(-hl + w, hl - w, hw - w, hw, w, b["lip"], "pla_dark", 0.5, 2),
         K.span(-b["L"] / 2, b["L"] / 2, -b["W"] / 2, b["W"] / 2, w, w + b["H"], "battery", 4.0, 3)]
    P.append(K.cyl(2.6, 0, 6, "cable_jacket", 12, 0.6).moved(K.rot("y", -90), (-b["L"] / 2, 12, w + b["H"] - 8)))
    t = (b["c"][0], b["c"][1], b["z"])
    at = Rz @ np.array([-b["L"] / 2 - 6, 12, w + b["H"] - 8]) + t
    return [p.moved(Rz, t) for p in P], (at, Rz @ np.array([-1.0, 0, 0]))


def switch():
    """the inline oval rocker switch lying on the lower plate, its cable ends along y"""
    s = SWITCH
    Rz = K.rot("z", 90)
    z0, z1 = 0.0, s["H"]
    P = [K.prism(K.stadium(s["L"], s["W"], 0, 0, 8), z0, z1, "abs_black", 3.0, 3),
         K.span(-12, 12, -9, 9, z1 - 0.2, z1 + 0.6, "abs_black", 0.3, 1),
         K.span(-10.5, 0.5, -7.5, 7.5, z1 + 0.6, z1 + 2.4, "abs_black", 0.8, 2).moved(K.rot("y", 7), (0, 0, 0)),
         K.span(-0.5, 10.5, -7.5, 7.5, z1 + 0.6, z1 + 1.6, "abs_black", 0.8, 2).moved(K.rot("y", -7), (0, 0, 0.1))]
    P += [K.ring(1.1, 1.6, z1 + 2.4, z1 + 2.5, "label", 16, 0).moved(t=(-5.5, 0, 0)), K.span(4.5, 6.5, -0.35, 0.35, z1 + 1.6, z1 + 1.7, "label", 0, 0)]
    for sg in (-1, 1):
        P.append(K.cyl(3.2, 0, 6, "abs_black", 16, 0.8).moved(K.rot("y", 90 * sg), (sg * (s["L"] / 2 - 1), 0, z1 / 2)))
    t = (s["c"][0], s["c"][1], s["z"])
    ends = [(Rz @ np.array([sg * (s["L"] / 2 + 5), 0, z1 / 2]) + t, Rz @ np.array([sg * 1.0, 0, 0])) for sg in (-1, 1)]
    return [p.moved(Rz, t) for p in P], ends


def sticker(ctx):
    """the 12V DC sticker: a 24 mm rounded square set as a diamond on the arm base's -x side face"""
    V, F = R.mesh(ctx, "^vis_Base_08q-v1$")
    A, Bv, Cv = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    N = np.cross(Bv - A, Cv - A)
    ar = np.linalg.norm(N, axis=1) / 2
    N = N / np.maximum(2 * ar, 1e-12)[:, None]
    side = (N[:, 0] < -0.97)
    x = float(np.min(A[side, 0]))
    on = side & (np.abs(A[:, 0] - x) < 0.3)
    c = (A[on] * ar[on, None]).sum(0) / ar[on].sum()
    c[2] += 10.0
    M = np.stack([np.array([0.0, -1, 0]), np.array([0.0, 0, 1]), np.array([-1.0, 0, 0])], 1)
    Rd = K.rot("z", 45)
    P = [K.prism(K.rrect(24, 24, 3), 0, 0.1, "tag_white", 0, 0),
         K.ring(4.3, 5.0, 0.1, 0.13, "label_ink", 24, 0).moved(t=(0, 4.0, 0)),
         K.span(-0.35, 0.35, 1.6, 6.4, 0.1, 0.13, "label_ink", 0, 0), K.span(-2.4, 2.4, 3.65, 4.35, 0.1, 0.13, "label_ink", 0, 0)]
    frame = [K.span(-12.0, 12.0, -12.0, -11.2, 0.1, 0.12, "label_ink", 0, 0)]
    for a in (90, 180, 270):
        frame.append(frame[0].moved(K.rot("z", a)))
    P += frame + [K.text("12V DC", 4.2, "label_ink", web_keep=True).moved(t=(0, -5.5, 0.12))]
    return [p.moved(Rd).moved(M, c + np.array([-0.05, 0, 0])) for p in P]


def pads():
    return [K.span(-10, 10, -12, 12, TOP, TOP + 1.6, "velcro_white", 0.5, 1).moved(K.rot("z", a), (x, y, 0)) for (x, y), a in PADS]


def adapter():
    """a bus adapter board on the WaveShare plate's Pi side (PCB, two 3-pin sockets, USB-C at the top edge)"""
    y0 = -2.9 - 3.0
    P = [K.span(-20, 20, y0 - 1.6, y0, 104, 139, "pcb", 0.4, 1)]
    for x in (-16, 16):
        for z in (107, 136):
            P.append(K.cyl(1.6, 0, 3.0, "brass", 12, 0).moved(K.rot("x", 90), (x, -2.9, z)))
    for x in (-9.0, 1.0):
        P.append(K.span(x - 3.9, x + 3.9, y0 - 7.6, y0 - 1.6, 110, 116, "connector_w", 0.3, 1))
    P += [K.span(4.0, 13.0, y0 - 4.8, y0 - 1.6, 132.0, 139.6, "steel", 0.6, 1), K.span(-14, -6, y0 - 2.6, y0 - 1.6, 124, 130, "ic", 0.1, 1)]
    return P, (np.array([8.5, y0 - 3.2, 139.6]), np.array([0.0, 0.0, 1.0]))


def build(ctx):
    m = B.Model(ctx, ctx.name)
    world = {k: np.asarray(ctx.pose(rx[0]), float) for k, rx in FINGERS.items()}
    anchors = {"base": [], "lift": []}
    for k, rxs in FINGERS.items():
        o = [j for j in FINGERS if j != k][0]
        q = R.mesh(ctx, FINGERS[o][0])[0].mean(0) * 0.001
        Mi = np.linalg.inv(world[k])
        other = (Mi @ world[o] @ np.r_[q, 1.0])[:3] * 1000.0
        pins = [np.zeros((0, 3))]
        for rx in [rx for rx in PINS if np.allclose(ctx.pose(rx), world[k])]:     # this finger's own
            W = np.c_[R.mesh(ctx, rx)[0] * 0.001, np.ones(len(R.mesh(ctx, rx)[0]))]
            pins.append((W @ (Mi @ np.asarray(ctx.pose(rx), float)).T)[:, :3] * 1000.0)
        m.origin[k] = (0, 0, 0)
        m.add(*cover(ctx, rxs, other, np.concatenate(pins)), sub=k)
    parts, (p, d) = strap(ctx)
    m.origin["lift"] = (0, 0, 0)
    m.add(*parts, sub="lift")
    anchors["lift"].append(("strap", p, d))
    bat, (p, d) = battery()
    sw, ends = switch()
    ad, (pu, du) = adapter()
    m.origin["base"] = (0, 0, 0)
    m.add(*bat, *sw, *ad, *sticker(ctx), *pads(), sub="base")
    anchors["base"] += [("batt_dc", p, d), ("switch.0", *ends[0]), ("switch.1", *ends[1]),
                        ("driver_dc", np.array(DRIVER_DC[0]), np.array(DRIVER_DC[1])), ("adapter_usb", pu, du)]
    out = {k: [v] for k, v in m.finish().items()}
    for b, items in anchors.items():
        out.setdefault(b, []).extend(D.empty(ctx.bpy, n, p, d) for n, p, d in items)
    return out
