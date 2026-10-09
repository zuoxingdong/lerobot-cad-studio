"""Mesh helpers for make_lab.py: numpy only, millimetres, deterministic.

A part is (V, F): float vertices and int triangles, outward-facing.  `Mesh` collects parts;
`write_obj` welds them, adds crease-angle normals and writes a fixed-format OBJ.
"""
import math

import numpy as np


def rot(axis, deg):
    """3x3 rotation about 'x', 'y' or 'z'."""
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return {'x': np.array([[1, 0, 0], [0, c, -s], [0, s, c]]),
            'y': np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]]),
            'z': np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])}[axis]


def place(part, R=None, t=(0, 0, 0)):
    V, F = part
    V = V @ np.asarray(R).T if R is not None else V
    return V + np.asarray(t, float), F


class Mesh:
    def __init__(self):
        self.parts = []

    def add(self, part, R=None, t=(0, 0, 0)):
        """A part (V, F) or every part of another Mesh, turned by R, then moved by t."""
        for p in (part.parts if isinstance(part, Mesh) else [part]):
            self.parts.append(place(p, R, t))
        return self

    def arrays(self):
        V, F, off = [], [], 0
        for v, f in self.parts:
            V.append(v)
            F.append(f + off)
            off += len(v)
        return np.concatenate(V), np.concatenate(F)


def revolve(profile, seg=40, a0=0.0, a1=360.0):
    """Revolve (r, z) points about +Z.  A CCW profile (solid on the left) faces outward;
    r == 0 points are poles.  A partial sweep is left open at its ends."""
    full = abs(a1 - a0) >= 360.0
    n = seg if full else seg + 1
    ang = np.radians(a0 + (a1 - a0) * np.arange(n) / seg)
    ca, sa = np.cos(ang), np.sin(ang)
    V, rings = [], []
    for r, z in profile:
        base = len(V)
        if r == 0:
            V.append((0.0, 0.0, z))
            rings.append([base] * n)
        else:
            V.extend((r * c, r * s, z) for c, s in zip(ca, sa))
            rings.append(list(range(base, base + n)))
    F = []
    m = seg
    for a, b in zip(rings[:-1], rings[1:]):
        for j in range(m):
            k = (j + 1) % n
            a0_, a1_, b0, b1 = a[j], a[k], b[j], b[k]
            if a0_ != a1_:
                F.append((a0_, a1_, b1))
            if b0 != b1:
                F.append((a0_, b1, b0))
    return np.array(V, float), np.array(F, int)


def extrude(poly, z0, z1):
    """A star-shaped (from its centroid) CCW polygon [(x, y)] extruded from z0 to z1."""
    P = np.asarray(poly, float)
    n = len(P)
    c = P.mean(axis=0)
    V = np.vstack([np.c_[P, np.full(n, z0)], np.c_[P, np.full(n, z1)], [[c[0], c[1], z0], [c[0], c[1], z1]]])
    F = []
    for i in range(n):
        j = (i + 1) % n
        F += [(i, j, n + j), (i, n + j, n + i), (2 * n, j, i), (2 * n + 1, n + i, n + j)]
    return V, np.array(F, int)


def box(size, center=(0, 0, 0)):
    w, d, h = (s / 2 for s in size)
    V, F = extrude([(-w, -d), (w, -d), (w, d), (-w, d)], -h, h)
    return V + np.asarray(center, float), F


def rrect(w, d, r, seg=4):
    """A rounded rectangle, CCW, `seg` segments per corner."""
    pts = []
    for cx, cy, a in ((w / 2 - r, d / 2 - r, 0), (-w / 2 + r, d / 2 - r, 90), (-w / 2 + r, -d / 2 + r, 180), (w / 2 - r, -d / 2 + r, 270)):
        for k in range(seg + 1):
            t = math.radians(a + 90 * k / seg)
            pts.append((cx + r * math.cos(t), cy + r * math.sin(t)))
    return pts


def circle(r, seg=40):
    return [(r * math.cos(2 * math.pi * k / seg), r * math.sin(2 * math.pi * k / seg)) for k in range(seg)]


def cyl(r, z0, z1, seg=32):
    return revolve([(0, z0), (r, z0), (r, z1), (0, z1)], seg)


def cyl_between(p0, p1, r, seg=24):
    """A cylinder of radius r from p0 to p1."""
    p0, p1 = np.asarray(p0, float), np.asarray(p1, float)
    d = p1 - p0
    L = float(np.linalg.norm(d))
    z = d / L
    x = np.cross([0, 0, 1.0], z) if abs(z[2]) < 0.999 else np.array([1.0, 0, 0])
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    return place(cyl(r, 0, L, seg), np.c_[x, y, z], p0)


def torus(R, r, seg=48, seg2=12):
    prof = [(R + r * math.cos(math.radians(-90 - 360 * k / seg2)), r * math.sin(math.radians(-90 - 360 * k / seg2))) for k in range(seg2)]
    prof = prof[::-1]
    n2 = len(prof)
    ang = 2 * math.pi * np.arange(seg) / seg
    V = [(rr * math.cos(a), rr * math.sin(a), z) for a in ang for rr, z in prof]
    F = []
    for i in range(seg):
        for j in range(n2):
            a, b = i * n2 + j, i * n2 + (j + 1) % n2
            c, d = ((i + 1) % seg) * n2 + (j + 1) % n2, ((i + 1) % seg) * n2 + j
            F += [(a, d, c), (a, c, b)]
    return np.array(V, float), np.array(F, int)


def _normals(V, F, crease_deg):
    tri = V[F]
    fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    area = np.linalg.norm(fn, axis=1)
    ok = area > 1e-9
    tri, fn, area = tri[ok], fn[ok] / area[ok, None], area[ok]
    P = tri.reshape(-1, 3)
    cn = np.repeat(fn, 3, axis=0)
    w = np.repeat(area, 3)
    key = np.round(P, 3)
    _, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.ravel()
    order = np.argsort(inv, kind='stable')
    bounds = np.flatnonzero(np.diff(inv[order])) + 1
    N = np.zeros_like(cn)
    cos = math.cos(math.radians(crease_deg))
    for g in np.split(order, bounds):
        n = cn[g]
        M = (n @ n.T) > cos
        s = (M * w[g][None, :]) @ n
        N[g] = s / np.linalg.norm(s, axis=1)[:, None]
    return P, N


def write_obj(path, mesh, crease_deg=35.0):
    """Weld on (position, normal) at 0.01 mm / 0.001 and write `v`, `vn`, `f a//a`.  Returns the triangle count."""
    V, F = mesh.arrays()
    P, N = _normals(V, F, crease_deg)
    P, N = np.round(P, 2) + 0.0, np.round(N, 3) + 0.0
    key = np.c_[P, N]
    uniq, inv = np.unique(key, axis=0, return_inverse=True)
    tris = inv.ravel().reshape(-1, 3)
    q = uniq[:, :3][tris]
    tris = tris[np.linalg.norm(np.cross(q[:, 1] - q[:, 0], q[:, 2] - q[:, 0]), axis=1) > 1e-6]
    out = ['# generated by tools/build/make_lab.py; mm']
    out += ['v %.2f %.2f %.2f' % tuple(p) for p in uniq[:, :3]]
    out += ['vn %.3f %.3f %.3f' % tuple(n) for n in uniq[:, 3:]]
    out += ['f %d//%d %d//%d %d//%d' % (a, a, b, b, c, c) for a, b, c in tris + 1]
    with open(path, 'w', encoding='ascii', newline='\n') as fh:
        fh.write('\n'.join(out) + '\n')
    return len(tris)


def rbox(w, d, h, r, center=(0, 0, 0), seg=4):
    """A box with rounded vertical edges; `center` is the centre of its base."""
    V, F = extrude(rrect(w, d, r, seg), 0, h)
    return V + np.asarray(center, float), F


def ring(r0, r1, z0, z1, seg=40):
    """An annulus about +Z from r0 to r1, z0..z1."""
    return revolve([(r0, z1), (r0, z0), (r1, z0), (r1, z1)], seg)


def bar(p, q, w, t):
    """A flat stroke w wide in the XY plane from p to q (square caps), z 0..t; t = 0: its top face only."""
    (x0, y0), (x1, y1) = p, q
    L = math.hypot(x1 - x0, y1 - y0)
    ux, uy = ((x1 - x0) / L, (y1 - y0) / L) if L > 1e-9 else (1.0, 0.0)
    nx, ny, h = -uy, ux, w / 2
    a, b = (x0 - ux * h, y0 - uy * h), (x1 + ux * h, y1 + uy * h)
    if not t:
        V = np.array([(a[0] - nx * h, a[1] - ny * h, 0), (b[0] - nx * h, b[1] - ny * h, 0),
                      (b[0] + nx * h, b[1] + ny * h, 0), (a[0] + nx * h, a[1] + ny * h, 0)])
        return V, np.array([(0, 1, 2), (0, 2, 3)])
    return extrude([(a[0] - nx * h, a[1] - ny * h), (b[0] - nx * h, b[1] - ny * h),
                    (b[0] + nx * h, b[1] + ny * h), (a[0] + nx * h, a[1] + ny * h)], 0, t)


_O = [(1, 0), (0, 1), (0, 5), (1, 6), (3, 6), (4, 5), (4, 1), (3, 0), (1, 0)]
_P = [(0, 0), (0, 6), (3, 6), (4, 5), (4, 4), (3, 3), (0, 3)]
# strokes on a 4 x 6 grid, capitals, digits and a few marks
GLYPHS = {
    'A': [[(0, 0), (0, 4), (2, 6), (4, 4), (4, 0)], [(0, 3), (4, 3)]],
    'B': [[(0, 0), (0, 6), (3, 6), (4, 5), (4, 4), (3, 3), (0, 3)], [(3, 3), (4, 2), (4, 1), (3, 0), (0, 0)]],
    'C': [[(4, 6), (1, 6), (0, 5), (0, 1), (1, 0), (4, 0)]],
    'D': [[(0, 0), (0, 6), (3, 6), (4, 5), (4, 1), (3, 0), (0, 0)]],
    'E': [[(4, 6), (0, 6), (0, 0), (4, 0)], [(0, 3), (3, 3)]],
    'F': [[(4, 6), (0, 6), (0, 0)], [(0, 3), (3, 3)]],
    'G': [[(4, 5), (3, 6), (1, 6), (0, 5), (0, 1), (1, 0), (3, 0), (4, 1), (4, 3), (2, 3)]],
    'H': [[(0, 0), (0, 6)], [(4, 0), (4, 6)], [(0, 3), (4, 3)]],
    'I': [[(1, 6), (3, 6)], [(2, 6), (2, 0)], [(1, 0), (3, 0)]],
    'K': [[(0, 0), (0, 6)], [(4, 6), (0, 2)], [(1, 3), (4, 0)]],
    'L': [[(0, 6), (0, 0), (4, 0)]],
    'M': [[(0, 0), (0, 6), (2, 3), (4, 6), (4, 0)]],
    'N': [[(0, 0), (0, 6), (4, 0), (4, 6)]],
    'O': [_O],
    'P': [_P],
    'R': [_P, [(2, 3), (4, 0)]],
    'S': [[(4, 5), (3, 6), (1, 6), (0, 5), (0, 4), (1, 3), (3, 3), (4, 2), (4, 1), (3, 0), (1, 0), (0, 1)]],
    'T': [[(0, 6), (4, 6)], [(2, 6), (2, 0)]],
    'U': [[(0, 6), (0, 1), (1, 0), (3, 0), (4, 1), (4, 6)]],
    'V': [[(0, 6), (2, 0), (4, 6)]],
    'W': [[(0, 6), (1, 0), (2, 4), (3, 0), (4, 6)]],
    'X': [[(0, 6), (4, 0)], [(0, 0), (4, 6)]],
    'Y': [[(0, 6), (2, 3), (4, 6)], [(2, 3), (2, 0)]],
    'Z': [[(0, 6), (4, 6), (0, 0), (4, 0)]],
    '0': [_O, [(0, 1), (4, 5)]],
    '1': [[(1, 5), (2, 6), (2, 0)], [(1, 0), (3, 0)]],
    '2': [[(0, 5), (1, 6), (3, 6), (4, 5), (4, 4), (0, 0), (4, 0)]],
    '3': [[(0, 5), (1, 6), (3, 6), (4, 5), (4, 4), (3, 3), (1, 3)], [(3, 3), (4, 2), (4, 1), (3, 0), (1, 0), (0, 1)]],
    '4': [[(3, 0), (3, 6), (0, 2), (4, 2)]],
    '5': [[(4, 6), (0, 6), (0, 3), (3, 3), (4, 2), (4, 1), (3, 0), (0, 0)]],
    '6': [[(4, 6), (1, 6), (0, 5), (0, 1), (1, 0), (3, 0), (4, 1), (4, 2), (3, 3), (0, 3)]],
    '7': [[(0, 6), (4, 6), (1, 0)]],
    '8': [[(1, 3), (0, 4), (0, 5), (1, 6), (3, 6), (4, 5), (4, 4), (3, 3), (1, 3), (0, 2), (0, 1), (1, 0), (3, 0), (4, 1), (4, 2), (3, 3)]],
    '9': [[(4, 3), (1, 3), (0, 4), (0, 5), (1, 6), (3, 6), (4, 5), (4, 1), (3, 0), (0, 0)]],
    '-': [[(1, 3), (3, 3)]],
    '.': [[(2, 0), (2, 0.01)]],
    "'": [[(1.5, 6), (2.5, 6), (2.5, 5), (1.5, 5), (1.5, 6)]],
    '>': [[(1, 5), (3, 3), (1, 1)]],
    '/': [[(0, 0), (4, 6)]],
}


def text(s, h, stroke=None, t=1.0, align='left', lift=0.0):
    """Stroke text in the XY plane: baseline y = 0, reading along +x, cap height h, z 0..t
    (t = 0: flat, facing +z at z = lift).  An apostrophe draws a degree mark."""
    k = h / 6.0
    w = stroke or 0.8 * k
    width = (5 * len(s) - 1) * k
    x0 = {'left': 0.0, 'center': -width / 2, 'right': -width}[align]
    m = Mesh()
    for i, ch in enumerate(s.upper()):
        for line in GLYPHS.get(ch, []):
            for p, q in zip(line[:-1], line[1:]):
                m.add(bar((x0 + (5 * i + p[0]) * k, p[1] * k), (x0 + (5 * i + q[0]) * k, q[1] * k), w, t), None, (0, 0, lift))
    return m


def moved(mesh, R=None, t=(0, 0, 0)):
    """Every part of `mesh` turned by R, then moved by t."""
    out = Mesh()
    for part in mesh.parts:
        out.add(part, R, t)
    return out


def disc(r, seg, center):
    """A flat disc facing +z (a fan, top only) at center."""
    c = np.asarray(center, float)
    V = [c] + [c + (r * math.cos(2 * math.pi * a / seg), r * math.sin(2 * math.pi * a / seg), 0) for a in range(seg)]
    return np.array(V), np.array([(0, 1 + a, 1 + (a + 1) % seg) for a in range(seg)])
