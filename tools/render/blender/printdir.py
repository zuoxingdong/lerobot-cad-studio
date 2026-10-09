"""Per-part shading axes from mesh geometry, in the geom's own frame (pure numpy, no bpy).

print_axis: the FDM build direction. With the part's package STL and its print_transform, the STL is
registered onto the capture mesh (area-weighted principal axes, sign and swap candidates scored by
the nearest-point distance) and the bed Z is carried across. Without one, the flattest principal
axis: a slicer lays a part on its largest face.
"""
import itertools
import struct

import numpy as np

FIT_TOL = 0.0015            # m: a registration worse than this falls back to the flat axis


def read_stl(path):
    """(V [n,3], F [m,3]) of a binary or ascii STL, file units"""
    blob = open(path, "rb").read()
    n = struct.unpack("<I", blob[80:84])[0] if len(blob) >= 84 else 0
    if len(blob) == 84 + 50 * n:
        rec = np.frombuffer(blob[84:], np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]))
        T = rec["v"].astype(np.float64)
    else:
        vals = [ln.split()[1:4] for ln in blob.decode("ascii", "ignore").splitlines() if ln.strip().startswith("vertex")]
        T = np.array(vals, np.float64).reshape(-1, 3, 3)
    return T.reshape(-1, 3), np.arange(len(T) * 3).reshape(-1, 3)


def moments(V, F):
    """area-weighted centroid and covariance of a triangle surface"""
    A, B, C = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    w = 0.5 * np.linalg.norm(np.cross(B - A, C - A), axis=1)
    w = w / max(w.sum(), 1e-18)
    c = (w[:, None] * (A + B + C) / 3).sum(0)
    a, b, cc = A - c, B - c, C - c
    S = (a[:, :, None] * a[:, None]) + (b[:, :, None] * b[:, None]) + (cc[:, :, None] * cc[:, None])
    S = S + (a + b + cc)[:, :, None] * (a + b + cc)[:, None]
    cov = (w[:, None, None] * S).sum(0) / 12.0
    return c, cov


def axes(V, F):
    """(centroid, eigenvalues ascending, eigenvectors as columns)"""
    c, cov = moments(np.asarray(V, np.float64), np.asarray(F))
    ev, E = np.linalg.eigh(cov)
    return c, ev, E


def flat_axis(V, F):
    """the principal axis of least spread (unit, geom frame)"""
    return axes(V, F)[2][:, 0]


def _sample(V, k, seed=0):
    idx = np.random.default_rng(seed).choice(len(V), size=min(k, len(V)), replace=False)
    return V[idx]


def _chamfer(P, Q):
    """mean nearest-point distance from P to Q (brute force, small sets)"""
    d = np.full(len(P), np.inf)
    for i in range(0, len(Q), 2048):
        q = Q[i:i + 2048]
        d = np.minimum(d, np.sqrt(((P[:, None, :] - q[None]) ** 2).sum(-1)).min(1))
    return float(d.mean())


def register(Vs, Fs, Vc, Fc):
    """(R, t, err): v_capture ~= R v_stl + t; err = mean nearest distance (m)"""
    cs, _, Es = axes(Vs, Fs)
    cc, _, Ec = axes(Vc, Fc)
    P, Q = _sample(Vs - cs, 600), _sample(Vc - cc, 3000, 1)
    best = (np.eye(3), cc - cs, np.inf)
    for perm in itertools.permutations(range(3)):
        for s in itertools.product((1, -1), repeat=3):
            R = Ec @ np.diag(s) @ Es[:, perm].T
            if np.linalg.det(R) < 0:
                continue
            err = _chamfer(P @ R.T, Q)
            if err < best[2]:
                best = (R, cc - R @ cs, err)
    return best


def print_axis(Vc, Fc, stl=None, bed=None, scale=0.001):
    """(unit axis in the geom frame, 'print' | 'flat'). bed: print_transform (column-major 4x4)."""
    if stl is not None and bed is not None:
        Vs, Fs = stl
        R, _, err = register(np.asarray(Vs, np.float64) * scale, Fs, np.asarray(Vc, np.float64), Fc)
        if err <= FIT_TOL:
            M = np.asarray(bed, np.float64).reshape(4, 4).T          # row-major
            z = R @ M[2, :3]
            return z / np.linalg.norm(z), "print"
    return flat_axis(Vc, Fc), "flat"


def box_frame(V, F):
    """(n, u, extents [3], centre) of a box-like part: n = least-spread axis, u = most; extents = the +n face
    offset and the half-extents along u and n x u"""
    c, _, E = axes(V, F)
    n, u = E[:, 0], E[:, 2]
    v = np.cross(n, u)
    X = np.asarray(V, np.float64) - c
    h = [float((X @ n).max())] + [float(np.abs(X @ a).max()) for a in (u, v)]
    return n, u, h, c


def wheel_frame(V, F):
    """(axis, outer radius, centre) of a wheel: the axis of least spread"""
    c, _, E = axes(V, F)
    a = E[:, 0]
    X = np.asarray(V, np.float64) - c
    r = np.linalg.norm(X - np.outer(X @ a, a), axis=1)
    return a, float(r.max()), c


def lens_frame(V, F):
    """(n, u, h, c) of a camera module: n = the thin axis turned toward the lens barrel (the end whose
    vertices sit closest to the axis), h = the barrel front along n, c = the barrel axis point"""
    n, u, _, c = box_frame(V, F)
    X = np.asarray(V, np.float64) - c
    v = np.cross(n, u)
    dn = X @ n
    lo, hi = dn <= np.percentile(dn, 10), dn >= np.percentile(dn, 90)
    r = np.hypot(X @ u, X @ v)
    if np.median(r[lo]) < np.median(r[hi]):
        n, v, dn, lo, hi = -n, -v, -dn, hi, lo
    front = X[hi]
    c2 = c + (front @ u).mean() * u + (front @ v).mean() * v
    return n, u, [float(dn.max()), 0.0, 0.0], c2
