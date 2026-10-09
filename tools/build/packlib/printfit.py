"""The bed pose of a print plate: the rigid move that takes a display mesh onto its plate.

Shared by the LeKiwi generator (upstream plates) and pack_assets.py (this project's parts).
"""
import itertools

import numpy as np

from .common import cm

# Whose orientation is the part printed in?  A package that names an upstream PLATE states the
# pose that part is printed in, and the studio exports and print-checks it in exactly that pose.
# The plate is the same solid as the display mesh, so the pose is 16 numbers: plate_transform()
# derives the rigid move and then proves it against the plate's surface.  A `print_file` that IS
# the display mesh (upstream PincOpen has no separate print folder) states no pose at all.
PLATE_FIT_TOL_MM = 0.05          # a mesh vertex this far off the plate is a different part
_PLATE_FIT_SAMPLE = 1500         # vertices used to pick the candidate rotation


def _axis_rotations():
    """The 24 proper rotations that map the axes onto the axes."""
    out = []
    for perm in itertools.permutations(range(3)):
        for signs in itertools.product((1.0, -1.0), repeat=3):
            M = np.zeros((3, 3))
            for i, p in enumerate(perm):
                M[i, p] = signs[i]
            if abs(np.linalg.det(M) - 1.0) < 1e-9:
                out.append(M)
    return out


def plate_transform(mesh_path, plate_path):
    """(column_major_16, worst_mm, rms_mm, plate_extents) for one mesh/plate pair, or None."""
    # The matrix takes the mesh onto the plate AND drops it on the bed (XY-centred, Z min 0),
    # the way this project's own plates are authored.  The rotation is searched over the 24
    # axis rotations — a plate is a part laid down, not re-modelled — scored by point-to-SURFACE
    # distance, because the two files are different tessellations of one solid.
    import trimesh
    m = trimesh.load(mesh_path, process=False)
    q = trimesh.load(plate_path, process=False)
    try:
        if np.abs(np.sort(m.extents) - np.sort(q.extents)).max() > 0.5:
            return None
        mc = (m.bounds[0] + m.bounds[1]) / 2.0
        qc = (q.bounds[0] + q.bounds[1]) / 2.0
        cands = []
        for R in _axis_rotations():
            if np.abs(np.abs(R @ m.extents) - q.extents).max() > 0.05:
                continue
            cands.append((R, qc - R @ mc))
        if not cands:
            return None
        V = np.asarray(m.vertices, float)
        idx = np.unique(np.linspace(0, len(V) - 1, min(_PLATE_FIT_SAMPLE, len(V))).astype(int))
        pq = trimesh.proximity.ProximityQuery(q)
        best = None
        for R, t in cands:
            d = float(np.abs(pq.signed_distance(V[idx] @ R.T + t)).max())
            if best is None or d < best[0]:
                best = (d, R, t)
        _, R, t = best
        d = np.abs(pq.signed_distance(V @ R.T + t))
        worst, rms = float(d.max()), float(np.sqrt((d ** 2).mean()))
        if worst > PLATE_FIT_TOL_MM:
            return None
        M = np.eye(4)
        M[:3, :3] = R
        M[:3, 3] = t
        # the plate, on the bed: this project's own plates are authored XY-centred at Z 0 and
        # `geometry-kit.bedTransform` puts an unknown-orientation mesh there too, so a declared
        # orientation lands in the same place and only the ROTATION is the package's answer
        D = np.eye(4)
        D[:3, 3] = [-(q.bounds[0][0] + q.bounds[1][0]) / 2.0,
                    -(q.bounds[0][1] + q.bounds[1][1]) / 2.0, -q.bounds[0][2]]
        return cm(D @ M), round(worst, 6), round(rms, 9), [round(float(x), 3) for x in q.extents]
    finally:
        del m, q


def rigid_fit(A, B):
    """Kabsch: the rotation + translation taking vertex set A onto B, with rmse and worst."""
    A = np.asarray(A, float)
    B = np.asarray(B, float)
    ca, cb = A.mean(0), B.mean(0)
    U, _, Vt = np.linalg.svd((A - ca).T @ (B - cb))
    R = Vt.T @ U.T
    if np.linalg.det(R) < 0:
        Vt[-1] *= -1
        R = Vt.T @ U.T
    t = cb - R @ ca
    res = np.linalg.norm((A @ R.T + t) - B, axis=1)
    M = np.eye(4)
    M[:3, :3] = R
    M[:3, 3] = t
    return M, float(np.sqrt((res ** 2).mean())), float(res.max())


def fit_print(mesh_path, plate_path):
    """{print_transform, print_fit_rmse_mm, print_bbox_mm[, print_fit_worst_mm]} or None."""
    # A plate generated from the same solid keeps its vertex order, so the fit is exact;
    # an upstream-style plate is a re-tessellation and goes through plate_transform().
    import trimesh
    m = trimesh.load(mesh_path, process=False)
    p = trimesh.load(plate_path, process=False)
    if len(m.vertices) == len(p.vertices):
        M, rmse, worst = rigid_fit(m.vertices, p.vertices)
        if worst <= 1e-3:
            return {'print_transform': cm(M), 'print_fit_rmse_mm': round(rmse, 9),
                    'print_bbox_mm': [round(float(x), 3) for x in p.extents]}
    fit = plate_transform(mesh_path, plate_path)
    if not fit:
        return None
    M, worst, rms, ext = fit
    return {'print_transform': M, 'print_fit_worst_mm': worst, 'print_fit_rmse_mm': rms,
            'print_bbox_mm': ext}
