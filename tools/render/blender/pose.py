"""Pose maths shared by the builder and the tests: quaternions (wxyz), asset frames. Pure numpy."""
import math

import numpy as np


def quat_mat(q):
    w, x, y, z = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
                     [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
                     [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]])


def quat_mul(a, b):
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return np.array([aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by,
                     aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw])


def item_pose(pos, quat, off):
    """(pos, quat) of the asset (decor item) frame from a mesh geom's pose and its asset offset
    [pos3 quat4] (asset = R_o . v + p_o), so world = R_g R_o^T asset + p_g - R_g R_o^T p_o"""
    if off is None:
        return np.asarray(pos, float), np.asarray(quat, float)
    qo = np.asarray(off[3:7], float)
    q = quat_mul(quat, qo * np.array([1, -1, -1, -1]))
    return np.asarray(pos, float) - quat_mat(q) @ np.asarray(off[0:3], float), q / np.linalg.norm(q)


def continuous(Q):
    Q = np.array(Q, float)
    for i in range(1, len(Q)):
        if Q[i] @ Q[i - 1] < 0:
            Q[i] = -Q[i]
    return Q


def mat_to_quat(R):
    """a rotation matrix -> unit quaternion wxyz (w >= 0)"""
    t = np.trace(R)
    if t > 0:
        s = 2.0 * math.sqrt(1.0 + t)
        q = [0.25 * s, (R[2, 1] - R[1, 2]) / s, (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s]
    else:
        i = int(np.argmax(np.diag(R)))
        j, k = (i + 1) % 3, (i + 2) % 3
        s = 2.0 * math.sqrt(max(1e-300, 1.0 + R[i, i] - R[j, j] - R[k, k]))
        q = [0.0] * 4
        q[0] = (R[k, j] - R[j, k]) / s
        q[1 + i] = 0.25 * s
        q[1 + j] = (R[j, i] + R[i, j]) / s
        q[1 + k] = (R[k, i] + R[i, k]) / s
    q = np.array(q)
    q /= np.linalg.norm(q)
    return -q if q[0] < 0 else q
