"""Robot-package geometry for the robot dress models (pure numpy, mm): the LeKiwi + SO-101 + PincOpen body
frames by one visual geom each, the joint axes (the package kinematics), servo frames registered onto the
STS3215 mesh, and screw holes found on a part's faces."""
import numpy as np

# one visual geom per rigid body: a follow part on it rides that body
BODY = {"base": "^vis_base_plate_layer1-v5$", "pan": "^vis_Rotation_Pitch_08i-v1$", "lift": "^vis_SO_ARM100_08k_116_Square-v1$",
        "elbow": "^vis_SO_ARM100_08k_Mirror-v1$", "wflex": "^vis_Wrist_Roll_Pitch_08i-v1$", "wroll": "^vis_df200_arch_arch$",
        "pinc": "^vis_pincopen_top_plate$"}
# joints: (child, parent, axis in the child frame through its origin)
JOINTS = [("pan", "base", (0, 0, 1)), ("lift", "pan", (1, 0, 0)), ("elbow", "lift", (1, 0, 0)), ("wflex", "elbow", (1, 0, 0)),
          ("wroll", "wflex", (0, 0.422618, -0.906308))]
# the bus servos, in chain order: (body, mesh); the canonical STS3215 is the lift servo
CANON = "^vis_STS3215_03a-v1-1$"
SERVOS = [("base", "^vis_STS3215_03a-v1$"), ("pan", "^vis_STS3215_03a-v1-1$"), ("lift", "^vis_STS3215_03a-v1-2$"),
          ("elbow", "^vis_STS3215_03a-v1-3$"), ("wflex", "^vis_STS3215_03a_Wrist_Roll-v1$"), ("pinc", "^vis_pincopen_sts3215_drive$")]
# canonical STS3215 (mm): shaft along +x at y -30.6, z -52.2; the far end face at z -17 carries the two bus
# sockets, low on the case (-x, away from the horn)
C_SHAFT, C_FAR, C_MID = np.array([0.0, -30.6, -52.2]), -17.0, np.array([0.0, -30.6, -39.7])
C_SOCKETS = [np.array([-9.5, -30.6 - 4.4, C_FAR]), np.array([-9.5, -30.6 + 4.4, C_FAR])]


def mesh(ctx, rx):
    V, F = ctx.local(rx)
    return np.asarray(V, float) * 1000.0, np.asarray(F)


def rel(ctx, a, b):
    """4x4 (mm) taking body b's frame into body a's, at frame0"""
    M = np.linalg.inv(np.asarray(ctx.pose(BODY[a]), float)) @ np.asarray(ctx.pose(BODY[b]), float)
    M[:3, 3] *= 1000.0
    return M


def apply(M, P):
    P = np.asarray(P, float)
    return P @ M[:3, :3].T + M[:3, 3]


def procrustes(A, B):
    ca, cb = A.mean(0), B.mean(0)
    U, _, Vt = np.linalg.svd((A - ca).T @ (B - cb))
    D = np.diag([1, 1, np.sign(np.linalg.det(Vt.T @ U.T))])
    R = Vt.T @ D @ U.T
    return R, cb - R @ ca


def servo_frame(ctx, body, rx, canon=None):
    """(R, t): canonical STS3215 coordinates -> this servo's body frame (mm)"""
    A = canon if canon is not None else mesh(ctx, CANON)[0]
    V = mesh(ctx, rx)[0]
    if len(V) == len(A):
        R, t = procrustes(A, V)
        if np.abs(A @ R.T + t - V).max() < 0.05:
            return R, t
    # another export of the servo: its shaft is the joint it drives (the horn on +axis), the far end is the
    # end away from it
    child = next(c for c, p, _ in JOINTS if p == body)
    ax = np.array(next(a for c, p, a in JOINTS if p == body), float)
    Mc = rel(ctx, body, child)
    a, o = Mc[:3, :3] @ ax, Mc[:3, 3]
    c0 = V.mean(0)
    w, E = np.linalg.eigh(np.cov((V - c0).T))
    E = [e - a * (e @ a) for e in E.T]
    L = max(E, key=lambda e: np.ptp((V - c0) @ (e / max(np.linalg.norm(e), 1e-9))))
    L = L / np.linalg.norm(L)
    s = (V - o) @ L
    if abs(s.min()) > abs(s.max()):
        L = -L
    W = np.cross(L, a)
    mid = [(np.min(V @ d) + np.max(V @ d)) / 2 for d in (a, W, L)]
    R = np.stack([a, W, L], 1)
    return R, mid[0] * a + mid[1] * W + mid[2] * L - R @ C_MID


def sockets(R, t):
    """(two socket points, outward direction) of a servo in its body frame"""
    return [R @ s + t for s in C_SOCKETS], R @ np.array([0.0, 0.0, 1.0])


def circles(P2, tol=0.12, rmin=0.8, rmax=2.2):
    """hole rims among 2D points: a circle fitted to each point's neighbourhood, kept when the points on it
    go most of the way round; [(centre, r)]"""
    P2 = np.asarray(P2, float)
    out = []
    D = np.linalg.norm(P2[:, None] - P2[None], axis=2) if len(P2) < 3000 else None
    for i in range(len(P2)):
        d = D[i] if D is not None else np.linalg.norm(P2 - P2[i], axis=1)
        for rad in (1.6 * rmin, 2.6, 3.4, 2 * rmax):
            A = P2[d < rad]
            if len(A) < 5:
                continue
            x = np.linalg.lstsq(np.c_[2 * A, np.ones(len(A))], (A ** 2).sum(1), rcond=None)[0]
            c = x[:2]
            r = float(np.sqrt(max(x[2] + c @ c, 0.0)))
            if not rmin < r < rmax or any(np.linalg.norm(c - q) < 0.5 for q, _ in out):
                continue
            e = np.linalg.norm(P2 - c, axis=1)
            on = P2[np.abs(e - r) < tol]
            if len(on) < 6 or (e < r - tol).any():
                continue
            ang = np.sort(np.arctan2(on[:, 1] - c[1], on[:, 0] - c[0]))
            if float(np.max(np.diff(np.r_[ang, ang[0] + 2 * np.pi]))) < 1.3:
                out.append((c, r))
                break
    return out


def basis(n):
    n = np.asarray(n, float) / np.linalg.norm(n)
    u = np.cross(n, [1.0, 0, 0] if abs(n[0]) < 0.9 else [0, 1.0, 0])
    u /= np.linalg.norm(u)
    return n, u, np.cross(n, u)


def face_holes(V, o, n, rmax=14.0, head=2.6):
    """screw holes around the line (o, n) open to its +n side (at the bore top, as up_holes): [(point, r)]"""
    n, u, w = basis(n)
    o = np.asarray(o, float)
    L = np.c_[(V - o) @ u, (V - o) @ w, (V - o) @ n]
    L = L[np.hypot(L[:, 0], L[:, 1]) < rmax]
    if len(L) < 10:
        return []
    return [(o + u * p[0] + w * p[1] + n * p[2], r) for p, r in up_holes(L, head=head)]


def up_holes(V, rmin=1.2, rmax=1.95, head=2.6):
    """screw holes open to +z on a part: [(point at the bore top, r)]"""
    out = []
    z = np.round(V[:, 2], 1)
    lev, cnt = np.unique(z, return_counts=True)
    for L in lev[cnt >= 6]:
        on = np.abs(V[:, 2] - L) < 0.06
        for c, r in circles(V[on][:, :2], rmin=rmin, rmax=rmax):
            d = np.hypot(V[:, 0] - c[0], V[:, 1] - c[1])
            top = float(V[d < r + 0.3, 2].max())
            if (V[(d < head) & (d > r + 0.3), 2] > top + 0.2).any():
                continue
            p = np.array([c[0], c[1], top])
            if all(np.linalg.norm(p - q) > 2.0 for q, _ in out):
                out.append((p, r))
    return out


def clear(V, p, n, r, h):
    """True when no vertex of V lies in the cylinder of radius r, height h on the +n side of p"""
    n = np.asarray(n, float) / np.linalg.norm(n)
    t = (V - p) @ n
    rad = np.linalg.norm((V - p) - np.outer(t, n), axis=1)
    return not ((t > 0.05) & (t < h) & (rad < r)).any()


def df200(ctx, rx):
    """(body centre, lens axis, image up) of a DF200 stand-in in its body frame, mm: the 36 x 36 faces carry
    the most area, the barrel and hood stand on the lens side, the rear connector sits on the image-up axis"""
    V, F = mesh(ctx, rx)
    A, B, C = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    N = np.cross(B - A, C - A)
    ar = np.linalg.norm(N, axis=1)
    n = N[int(np.argmax(ar))] / ar.max()
    t = V @ n
    lev = sorted({round(float(A[i] @ n), 2) for i in np.where(ar > 0.8 * ar.max())[0]})
    tb0, tb1 = lev[0], lev[-1]
    if t.max() - tb1 < tb0 - t.min():
        n, t, tb0, tb1 = -n, -t, -tb1, -tb0
    n, u, w = basis(n)
    P = V[(t > tb0 - 0.01) & (t < tb1 + 0.01)]
    c = n * (tb0 + tb1) / 2 + u * (np.ptp(P @ u) / 2 + (P @ u).min()) + w * (np.ptp(P @ w) / 2 + (P @ w).min())
    up = V[t < tb0 - 0.5].mean(0) - c
    up -= n * (up @ n)
    return c, n, up / max(np.linalg.norm(up), 1e-9)


def axis_hole(V, o, n, rmax=6.0):
    """(point, r) of a screw hole centred on the line (o, n) in the outermost face around it on its +n
    side, or None"""
    n = np.asarray(n, float) / np.linalg.norm(n)
    o = np.asarray(o, float)
    t = (V - o) @ n
    rad = np.linalg.norm((V - o) - np.outer(t, n), axis=1)
    near = rad < rmax
    if near.sum() < 6:
        return None
    top = float(t[near].max())
    rim = near & (t > top - 0.6) & (rad > 1.0) & (rad < 2.2)
    if rim.sum() < 6 or (near & (t > top - 0.6) & (rad <= 1.0)).any():
        return None
    r = rad[rim]
    return (o + n * top, float(np.median(r))) if r.std() < 0.15 else None
