"""rps/campath@1 track rows -> a Blender camera: [lookat xyz (m), azimuth, elevation (deg), distance (m), fovy (deg)].

MuJoCo's free camera: f = (cos e cos a, cos e sin a, sin e), eye = lookat - distance f, up = +Z.
Blender looks down -Z: right = f x z, up = right x f. Pure numpy.
"""
import math

import numpy as np

from pose import continuous, mat_to_quat

SENSOR_H_MM = 24.0


def forward(az_deg, el_deg):
    a, e = math.radians(az_deg), math.radians(el_deg)
    return np.array([math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)])


def basis(row):
    """(eye, right, up, forward) in the world for one track row"""
    f = forward(row[3], row[4])
    eye = np.asarray(row[:3], float) - row[5] * f
    r = np.cross(f, [0.0, 0.0, 1.0])
    r /= np.linalg.norm(r)
    return eye, r, np.cross(r, f), f


def pose(row):
    """(eye, quat wxyz) of a Blender camera object for one row"""
    eye, r, u, f = basis(row)
    return eye, mat_to_quat(np.stack([r, u, -f], 1))


def lens_mm(fovy_deg, sensor_h=SENSOR_H_MM):
    """focal length for a vertical field of view on a sensor_h-high frame"""
    return 0.5 * sensor_h / math.tan(math.radians(fovy_deg) / 2)


def track(C):
    """[N,7] rows -> (eye [N,3], quat [N,4], focus distance [N], lens mm [N])"""
    P, Q = zip(*(pose(r) for r in C)) if len(C) else ((), ())
    C = np.asarray(C, float).reshape(-1, 7)
    return np.array(P), continuous(Q), C[:, 5].copy(), np.array([lens_mm(v) for v in C[:, 6]])
