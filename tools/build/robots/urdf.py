"""URDF reading, zero-pose FK and the small matrix helpers every generator shares.

Matrices are 4x4 numpy; cm() is the column-major 16 the packages and three.js use.
"""
import math
import xml.etree.ElementTree as ET

import numpy as np


def log(*a):
    print(*a, flush=True)


def cm(M):
    """4x4 matrix -> the column-major 16 a package stores."""
    return [round(float(x), 9) for x in np.asarray(M, float).T.reshape(-1)]


def mat(xyz, R):
    M = np.eye(4)
    M[:3, :3] = R
    M[:3, 3] = xyz
    return M


def rpy_mat(r, p, y):
    cr, sr = math.cos(r), math.sin(r)
    cp, sp = math.cos(p), math.sin(p)
    cy, sy = math.cos(y), math.sin(y)
    Rz = np.array([[cy, -sy, 0], [sy, cy, 0], [0, 0, 1.]])
    Ry = np.array([[cp, 0, sp], [0, 1., 0], [-sp, 0, cp]])
    Rx = np.array([[1., 0, 0], [0, cr, -sr], [0, sr, cr]])
    return Rz @ Ry @ Rx


def parse_urdf(path):
    """(joints, visuals) out of a URDF file; joint M is the fixed origin transform."""
    root = ET.parse(path).getroot()
    joints = []
    for j in root.findall('joint'):
        o, a, lim = j.find('origin'), j.find('axis'), j.find('limit')
        xyz = [float(v) for v in (o.get('xyz') or '0 0 0').split()] if o is not None else [0, 0, 0]
        rpy = [float(v) for v in (o.get('rpy') or '0 0 0').split()] if o is not None else [0, 0, 0]
        ax = [float(v) for v in a.get('xyz').split()] if a is not None else None
        joints.append(dict(name=j.get('name'), type=j.get('type'),
                           parent=j.find('parent').get('link'), child=j.find('child').get('link'),
                           xyz=xyz, rpy=rpy, axis=ax, M=mat(xyz, rpy_mat(*rpy)),
                           lower=(float(lim.get('lower')) if lim is not None and lim.get('lower') else None),
                           upper=(float(lim.get('upper')) if lim is not None and lim.get('upper') else None)))
    vis = {}
    for l in root.findall('link'):
        v = l.find('.//visual')
        if v is None:
            continue
        g = v.find('.//mesh')
        if g is None:
            continue
        o = v.find('origin')
        xyz = [float(x) for x in (o.get('xyz') or '0 0 0').split()] if o is not None else [0, 0, 0]
        rpy = [float(x) for x in (o.get('rpy') or '0 0 0').split()] if o is not None else [0, 0, 0]
        vis[l.get('name')] = dict(file=g.get('filename').split('/')[-1], xyz=xyz, rpy=rpy,
                                  M=mat(xyz, rpy_mat(*rpy)))
    return joints, vis


def fk_zero(joints, root_link):
    """link -> world matrix at the URDF zero pose (metres, every joint at 0)."""
    pose = {root_link: np.eye(4)}
    for _ in range(len(joints) + 2):
        for j in joints:
            if j['parent'] in pose and j['child'] not in pose:
                pose[j['child']] = pose[j['parent']] @ j['M']
    return pose


# IK-corrected arm presets.  They belong to the ROBOT, not to a feature module: a second robot
# package must not inherit LeKiwi's arm poses.
ARM_PRESETS = [
    # The note is the button's help text: say where the ARM is, in one short sentence, and
    # leave the joint-limit history to `presets_source` below.
    ('stowed', 'Stowed', [0, 0, 0, 0, 0, 0],
     'Parked, folded over the deck - the URDF zero pose. Legal on every joint and clear of the '
     'robot.'),
    ('reach_floor', 'Reach floor', [0, -163, 35, 170.5, 0, -30],
     'Gripper down at the floor, tip at about (-6.6, 322.9, -5.8) mm.'),
    ('reach_table', 'Reach table', [0, -6, 47, 2, 0, -30],
     'Tip at about (-4.8, 237.9, 242.8) mm, roughly a 240 mm table top.'),
    ('raised_max', 'Raised max', [0, -49, 99, 86, 0, 0],
     'Arm raised, tip at about (-4.8, 154.6, 566.2) mm.'),
]

PRESETS_SOURCE = (
    'Four arm poses, corrected against the joint limits. The set this studio shipped earlier '
    'was authored before any limit existed: three of those four broke a limit and were in hard '
    'collision with the robot, so these replacements hit the same tip positions from inside the '
    'limits. One example: Reach floor holds arm_wrist_flex at 170.5, not the 171 the earlier '
    'table printed, because 171 is 0.5 deg past the -19.5..170.5 stop. Angles are degrees in '
    'the LeKiwi URDF convention; kinematics.joint_limits_map relates them to the SO-101 '
    'reference zero.'
)


def arm_presets(order):
    """ARM_PRESETS as package `presets` entries, with `q` keyed by the joint order given."""
    out = []
    for pid, label, q, note in ARM_PRESETS:
        out.append({'id': pid, 'label': label,
                    'q': {j: float(v) for j, v in zip(order, q)}, 'note': note})
    return out
