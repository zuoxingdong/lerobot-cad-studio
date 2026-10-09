"""Quadric decimation per connected BODY, with a content-keyed STL cache."""
import hashlib
import os

import numpy as np
import trimesh

from .common import CACHE


_MD5 = {}


def _file_md5(path):
    """The file's md5, memoised per absolute path."""
    p = os.path.abspath(path)
    if p not in _MD5:
        h = hashlib.md5()
        with open(p, 'rb') as f:
            for blk in iter(lambda: f.read(1 << 20), b''):
                h.update(blk)
        _MD5[p] = h.hexdigest()
    return _MD5[p]


def _to_vtk(m, vtk, vns):
    pts = vtk.vtkPoints()
    pts.SetData(vns.numpy_to_vtk(np.ascontiguousarray(m.vertices, dtype=np.float64), deep=1))
    f = np.ascontiguousarray(np.hstack([np.full((len(m.faces), 1), 3, dtype=np.int64),
                                        np.asarray(m.faces, dtype=np.int64)]).ravel())
    ca = vtk.vtkCellArray()
    ca.SetCells(len(m.faces), vns.numpy_to_vtkIdTypeArray(f, deep=1))
    pd = vtk.vtkPolyData()
    pd.SetPoints(pts)
    pd.SetPolys(ca)
    return pd


def _from_vtk(pd, vns):
    v = vns.vtk_to_numpy(pd.GetPoints().GetData())
    c = vns.vtk_to_numpy(pd.GetPolys().GetData()).reshape(-1, 4)[:, 1:]
    return trimesh.Trimesh(vertices=np.asarray(v, dtype=np.float64),
                           faces=np.asarray(c, dtype=np.int64), process=False)


def _vtk_quadric(m, target):
    import vtk
    from vtk.util import numpy_support as vns
    pd = _to_vtk(m, vtk, vns)
    tf = vtk.vtkTriangleFilter(); tf.SetInputData(pd); tf.Update(); pd = tf.GetOutput()
    n0 = pd.GetNumberOfPolys()
    if n0 <= target:
        return _from_vtk(pd, vns)
    d = vtk.vtkQuadricDecimation()
    d.SetInputData(pd)
    d.SetTargetReduction(1.0 - float(target) / n0)
    if hasattr(d, 'SetVolumePreservation'):
        d.SetVolumePreservation(True)
    d.Update()
    tf2 = vtk.vtkTriangleFilter(); tf2.SetInputData(d.GetOutput()); tf2.Update()
    return _from_vtk(tf2.GetOutput(), vns)


def decimate_one(m, target):
    """Topology-preserving decimation of ONE connected body: edge collapses only, so a body
    (an omni-wheel roller, a PincOpen rod) never falls apart into polygon confetti."""
    if len(m.faces) <= target or len(m.faces) < 8:
        return m
    try:
        b = _vtk_quadric(m, int(target))
    except Exception:
        b = None
    if b is not None and 4 <= len(b.faces) <= target * 1.1:
        return b
    try:
        a = m.simplify_quadric_decimation(face_count=int(target))
    except Exception:
        a = None
    if a is not None and 4 <= len(a.faces) <= target * 1.15:
        return a
    cands = [x for x in (b, a) if x is not None and len(x.faces) >= 4]
    return min(cands, key=lambda x: len(x.faces)) if cands else m


def _allocate(counts, areas, target, min_body):
    counts = np.asarray(counts, dtype=np.int64)
    areas = np.asarray(areas, dtype=np.float64)
    if counts.sum() <= target:
        return counts.copy()
    floor = np.minimum(counts, min_body)
    rem = int(target - floor.sum())
    give = np.zeros(len(counts), dtype=np.int64)
    cap = counts - floor
    if rem <= 0:
        return floor
    w = np.where(areas > 0, areas, 1e-9)
    for _ in range(24):
        act = (cap - give) > 0
        if rem <= 0 or not act.any():
            break
        ws = w[act].sum()
        add = np.zeros(len(counts), dtype=np.int64)
        add[act] = np.floor(rem * w[act] / ws).astype(np.int64)
        add = np.minimum(add, cap - give)
        if add.sum() <= 0:
            free = np.where(act, cap - give, 0)
            i = int(np.argmax(free))
            add[i] = min(rem, int(free[i]))
            if add[i] <= 0:
                break
        give += add
        rem -= int(add.sum())
    return floor + give


def decimate_bodies(m, target, min_body=60):
    """Decimate a mesh to `target` faces, budgeting each connected body by size and area."""
    target = int(target)
    if len(m.faces) <= target:
        return m
    bodies = m.split(only_watertight=False)
    if len(bodies) <= 1:
        return decimate_one(m, target)
    mb = max(8, min(min_body, target // max(1, len(bodies))))
    alloc = _allocate([len(b.faces) for b in bodies], [float(b.area) for b in bodies], target, mb)
    out = [decimate_one(b, int(a)) if a < len(b.faces) else b for b, a in zip(bodies, alloc)]
    return trimesh.util.concatenate(out)


def load_dec(fp, target):
    """An STL loaded and decimated to `target` faces, through the content-keyed cache."""
    # Keyed on the file's CONTENT and the target only, so a moved file hits the same entry and a
    # re-posed one (same size, new orientation) misses.  The answer is always read back from
    # the cached STL, so a hit and a miss hand the packer the same float32 vertices.
    key = hashlib.md5(('v6|%d|%s' % (target, _file_md5(fp))).encode()).hexdigest()[:16]
    cp = os.path.join(CACHE, key + '.stl')
    if not os.path.exists(cp):
        m = decimate_bodies(trimesh.load(fp), int(target))
        m.export(cp)
        del m
    return trimesh.load(cp, process=False)
