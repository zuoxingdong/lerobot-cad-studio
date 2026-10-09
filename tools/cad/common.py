"""Shared paths and mesh helpers for the CadQuery generators.

vendor/ is read-only: modules copied verbatim from the earlier pipeline; do not edit or add to them.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))                   # tools/cad
VENDOR = os.path.join(HERE, 'vendor')
PLATE_OUTLINE = os.path.join(VENDOR, 'plate_outline.npy')


def add_scripts_to_path():
    """Let us `import vent / pidummy` from `vendor/` (read-only)."""
    if VENDOR not in sys.path:
        sys.path.insert(0, VENDOR)


def clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


def get(params, key, default, lo=None, hi=None):
    v = params.get(key, default)
    try:
        v = float(v)
    except (TypeError, ValueError):
        v = float(default)
    if lo is not None:
        v = clamp(v, lo, hi)
    return v


def mesh_info(path):
    """trimesh validity report for a written STL."""
    import trimesh
    import warnings
    warnings.filterwarnings('ignore')
    m = trimesh.load(path)
    b = m.bounds
    return m, dict(
        watertight=bool(m.is_watertight),
        body_count=int(m.body_count),
        faces=int(len(m.faces)),
        volume_cm3=round(float(m.volume) / 1000.0, 3),
        bbox=[round(float(x), 3) for x in b[0]] + [round(float(x), 3) for x in b[1]],
        bbox_size=[round(float(b[1][i] - b[0][i]), 3) for i in range(3)],
    )


def print_orient(path, out_path, mode=''):
    """Bed orientation: '' as built, 'flat' = +90 deg about X, 'flip' = 180 deg; then centre on
    XY and rest on Z = 0."""
    import numpy as np
    import trimesh
    import warnings
    warnings.filterwarnings('ignore')
    p = trimesh.load(path)
    if mode == 'flat':
        p.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0]))
    if mode == 'flip':
        p.apply_transform(trimesh.transformations.rotation_matrix(np.pi, [1, 0, 0]))
    b = p.bounds
    p.apply_translation([-(b[0][0] + b[1][0]) / 2, -(b[0][1] + b[1][1]) / 2, -b[0][2]])
    p.export(out_path)
    b = p.bounds
    return [round(float(b[1][i] - b[0][i]), 2) for i in range(3)]
