"""Paths, budgets and the matrix helpers pack_assets.py and this package share."""
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))    # tools/build
STUDIO = os.path.dirname(os.path.dirname(HERE))
ASSETS = os.path.join(STUDIO, 'assets')
OUT_JS = os.path.join(STUDIO, 'src', 'data', 'packed.js')
OUT_JSON = os.path.join(STUDIO, 'src', 'data', 'assets_manifest.json')
sys.path.append(os.path.dirname(HERE))
import paths  # noqa: E402

CACHE = os.path.join(paths.CACHE, 'pack')                      # decimation results, by content
os.makedirs(CACHE, exist_ok=True)
os.makedirs(os.path.dirname(OUT_JS), exist_ok=True)

QUANT = 64.0                       # snap vertices to 1/64 mm (exact in float32, gzips ~6x better)
BUDGET_MB = 4.0


def log(*a):
    print(*a, flush=True)


def rpy_mat(r, p, y):
    """Roll-pitch-yaw (radians) as a 3x3 rotation, Z @ Y @ X."""
    import math
    cr, sr = math.cos(r), math.sin(r)
    cp, sp = math.cos(p), math.sin(p)
    cy, sy = math.cos(y), math.sin(y)
    return (np.array([[cy, -sy, 0], [sy, cy, 0], [0, 0, 1.]]) @
            np.array([[cp, 0, sp], [0, 1., 0], [-sp, 0, cp]]) @
            np.array([[1., 0, 0], [0, cr, -sr], [0, sr, cr]]))


def T(xyz, R):
    """A 4x4 from a translation and a 3x3 rotation."""
    M = np.eye(4)
    M[:3, :3] = R
    M[:3, 3] = xyz
    return M


def cm(M):
    """4x4 matrix -> the column-major 16 a package stores."""
    return [round(float(x), 9) for x in np.asarray(M, float).T.reshape(-1)]
