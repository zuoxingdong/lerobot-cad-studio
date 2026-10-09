"""PincOpen kinematics: the four-bar linkage, the zero-pose FK and the drive servo it has no STL for.

Feeds pincopen.py, which turns these into the package's components and joints.
"""
import math

import numpy as np

from .paths import LEKIWI_COMMIT
from .urdf import mat, rpy_mat

# Which bodies ride the moving coupler, measured by distance from each body to the four hinge
# axes (the registration; the table is in assets/robots/pincopen/SOURCE.md):
#   Top_Plate / Bottom_Plate  touch BOTH ground pivots, nothing at the coupler   -> ground
#   Internal_Rod              1.50 mm from (0,-32.5) and from (34.64,-12.5)      -> rotating link
#   External_Rod              1.62 mm from (0,-44.0) and from (34.64,-24.0)      -> rotating link
#   Distal_Rod                1.5-1.6 mm from BOTH coupler pivots, 31+ mm from ground -> the coupler bar
#   Distal_Shell / Removable_Tip / Tip_Support   bolted distal to the coupler     -> ride the coupler
COUPLER_PARTS = {'Distal_Rod', 'Distal_Shell', 'Removable_Tip', 'Tip_Support'}
ROTATING_LINKS = {'Internal_Rod', 'External_Rod'}
GROUND_PARTS = {'Top_Plate', 'Bottom_Plate'}


def fk_zero_links(kin):
    """link -> 4x4 at the zero pose, from a `kinematics` block whose joint `xyz` are in mm."""
    # Only the joint ORIGINS matter at zero; the same walk
    # core/robot-model.js do, kept here so each component's `local` is in its own link frame.
    pose = {kin['root_link']: np.eye(4)}
    js = kin['joints']
    for _ in range(len(js) + 2):
        for j in js:
            if j['parent'] in pose and j['child'] not in pose:
                pose[j['child']] = pose[j['parent']] @ mat(j['xyz'], rpy_mat(*j.get('rpy', [0, 0, 0])))
    missing = [l for l in kin['links'] if l not in pose]
    if missing:
        raise SystemExit('linkage: links unreachable from %s: %s' % (kin['root_link'], missing))
    return pose


def linkage_from_hinges(hinges):
    """The PincOpen four-bar as a real kinematic chain: one `jaw` control joint + six mimics."""
    # Hinges (all axes || Z, quoted for the -Y finger): ground (0, -32.50) (0, -44.00),
    # coupler (34.64, -12.50) (34.64, -24.00).  Both bars are 39.999 mm and both pairs
    # 11.500 mm apart, so it is a PARALLELOGRAM: the coupler keeps its orientation and its
    # origin travels on an arc, i.e. the finger also moves along X (2.13 mm at an 8.5 mm gap).
    #
    # `jaw` is the OPENING ANGLE in degrees, q = th0 - theta, 0 closed (the exported state of
    # every STL here) to 30.001 wide open.  The rest mimic it, so the chain cannot leave the
    # parallelogram:  jaw_rod_L = -jaw, jaw_rod_R = +jaw, jaw_rod2_* = jaw_rod_*,
    # jaw_finger_* = -jaw_rod_* (the coupler cancels its bar).
    #     gap(q) = 2 * L * (sin th0 - sin(th0 - q))      0 mm at q = 0, 40.0 mm at q = th0
    # `control_display` publishes that mapping so a UI can show millimetres for an angle.
    g0, g1 = np.array(hinges[2], float), np.array(hinges[3], float)     # ground pivots, -Y side
    c0, c1 = np.array(hinges[0], float), np.array(hinges[1], float)     # coupler pivots, -Y side
    L0, L1 = float(np.linalg.norm(c0 - g0)), float(np.linalg.norm(c1 - g1))
    parallel = abs(L0 - L1) < 1e-6 and abs(float(np.linalg.norm(c1 - c0) - np.linalg.norm(g1 - g0))) < 1e-6
    if not parallel:
        raise SystemExit('linkage: the four hinges are not a parallelogram - the mimic chain '
                         'below (finger = -bar) would be wrong')
    v = c0 - g0
    th0 = abs(math.degrees(math.atan2(v[1], v[0])))     # 30.0007 deg, the closed crank angle
    qmax = th0                                          # crank horizontal = the linkage's limit
    gap = 2.0 * L0 * (math.sin(math.radians(th0)) - math.sin(math.radians(th0 - qmax)))
    half = L0 * math.sin(math.radians(th0))             # each finger's Y travel, mm (gap/2)

    def mimic(src, mul):
        return {'joint': src, 'multiplier': float(mul), 'offset': 0.0}

    joints = [{
        'name': 'jaw', 'type': 'revolute', 'parent': 'body', 'child': 'jaw_ref',
        'xyz': [0.0, 0.0, 0.0], 'rpy': [0, 0, 0], 'axis': [0, 0, 1],
        'units': 'deg', 'lower': 0.0, 'upper': round(qmax, 4),
        'limit_deg': [0.0, round(qmax, 4)],
        'zero': 'fully closed - the exported state of every STL in this package',
        'control': True,
        'drives': ['jaw_rod_L', 'jaw_rod2_L', 'jaw_finger_L',
                   'jaw_rod_R', 'jaw_rod2_R', 'jaw_finger_R'],
        'gap_mm': 'gap = 2 * %.4f * (sin(%.4f deg) - sin(%.4f deg - jaw))' % (L0, th0, th0),
        'note': (
            'DEGREES, and an OPENING ANGLE, not a distance: q = %.4f deg - theta, where theta '
            'is the crank angle of either bar measured from +X. 0 = fully closed (the exported '
            'state of every STL here), %.4f = wide open (a %.1f mm gap). `jaw_ref` carries no '
            'geometry; the six joints below mimic this one and carry the two bars and the '
            'coupler of each side. The finger does NOT slide: it travels on the four-bar arc, '
            'so it also moves %+.3f mm along +X between closed and wide open. See '
            'kinematics.control_display.jaw for the millimetre gap a slider should show.'
            % (th0, qmax, gap, L0 * (1.0 - math.cos(math.radians(th0))))),
    }]
    # `m` mirrors the quoted (-Y) hinge coordinates onto each side; the bar's rotation sign is
    # the OPPOSITE of it, because the -Y bar's crank angle FALLS from +th0 to 0 as the jaw opens
    # while the +Y bar's RISES from -th0 to 0.
    for side, m, tag in (('-Y', +1.0, 'L'), ('+Y', -1.0, 'R')):
        rod, rod2 = 'rod_%s' % tag, 'rod2_%s' % tag
        finger = 'finger_%s' % tag
        jrod, jrod2, jfin = 'jaw_rod_%s' % tag, 'jaw_rod2_%s' % tag, 'jaw_finger_%s' % tag
        joints += [
            {'name': jrod, 'type': 'revolute', 'parent': 'body', 'child': rod,
             'xyz': [round(float(g0[0]), 4), round(float(g0[1]) * m, 4), 0.0], 'rpy': [0, 0, 0],
             'axis': [0, 0, 1], 'units': 'deg', 'mimic': mimic('jaw', -m),
             'note': 'the %s Internal_Rod: the first bar, turning about the ground pivot '
                     '(%.2f, %.2f). It mimics `jaw` with multiplier %+.0f, which is the only '
                     'place the mirror sign is written down.' % (side, g0[0], g0[1] * m, -m)},
            {'name': jrod2, 'type': 'revolute', 'parent': 'body', 'child': rod2,
             'xyz': [round(float(g1[0]), 4), round(float(g1[1]) * m, 4), 0.0], 'rpy': [0, 0, 0],
             'axis': [0, 0, 1], 'units': 'deg', 'mimic': mimic(jrod, 1.0),
             'note': 'the %s External_Rod: the second bar, about the ground pivot (%.2f, %.2f). '
                     'A parallelogram keeps the two bars parallel, so it turns by exactly the '
                     'same angle as %s.' % (side, g1[0], g1[1] * m, jrod)},
            {'name': jfin, 'type': 'revolute', 'parent': rod, 'child': finger,
             'xyz': [round(float(c0[0] - g0[0]), 4), round(float((c0[1] - g0[1]) * m), 4), 0.0],
             'rpy': [0, 0, 0], 'axis': [0, 0, 1], 'units': 'deg', 'mimic': mimic(jrod, -1.0),
             'note': 'the %s COUPLER (Distal_Rod + Distal_Shell + Tip_Support + Removable_Tip), '
                     'hinged on the distal end of %s at the coupler pivot (%.2f, %.2f). It '
                     'mimics that bar with multiplier -1, so the finger keeps a constant '
                     'orientation however far the jaw opens - which is what makes this a '
                     'PARALLEL gripper.' % (side, rod, c0[0], c0[1] * m)},
        ]

    return {
        'urdf': None,
        'units': 'mm',
        'root_link': 'body',
        'links': ['body', 'jaw_ref',
                  'rod_L', 'rod2_L', 'finger_L', 'rod_R', 'rod2_R', 'finger_R'],
        'links_note': 'body = the fixed plates and everything bolted to them; rod_* / rod2_* = '
                      'the two bars of each four-bar (Internal_Rod and External_Rod); finger_* = '
                      'the couplers (-Y = L, +Y = R) that carry Distal_Rod, Distal_Shell, '
                      'Tip_Support and Removable_Tip; jaw_ref carries no geometry and exists only '
                      'as the control joint\'s child.',
        'joints': joints,
        'hinges_xy': hinges,
        'hinges_note': 'all hinge axes are parallel to Z; quoted for the -Y finger and mirrored '
                       'in Y for the +Y one. Upstream uses M3 self-tapping screws, d3.00 anchor '
                       'holes and d3.25 running holes (pincopen_mods/README.md)',
        'linkage': {
            'type': 'parallelogram four-bar',
            'ground_pivots_xy': [hinges[2], hinges[3]],
            'coupler_pivots_xy': [hinges[0], hinges[1]],
            'link_length_mm': round(L0, 4),
            'link_spacing_mm': round(float(np.linalg.norm(c1 - c0)), 4),
            'closed_crank_deg': round(th0, 4),
            'coupler_motion': 'pure translation on an arc (the finger does not rotate, but it '
                              'does move in X as well as Y)',
            'open_axis': [0, 1, 0],
            'gap_formula': 'gap_mm(q_deg) = 2 * %.4f * (sin(%.4f deg) - sin(%.4f deg - q_deg))'
                           % (L0, th0, th0),
            'gap_from_joint': 'gap_mm = 2 * %.4f * (sin(%.4f deg) - sin(%.4f deg - jaw))   '
                              '(jaw in DEGREES, 0..%.4f)' % (L0, th0, th0, qmax),
            'joint_from_gap': 'jaw_deg = %.4f - degrees(asin(sin(%.4f deg) - gap_mm / %.4f))'
                              % (th0, th0, 2 * L0),
            'finger_travel_mm': [round(L0 * (1.0 - math.cos(math.radians(th0))), 4), round(-half, 4)],
            'finger_travel_note': 'the -Y finger\'s displacement from closed to wide open, [dX, dY]. '
                                  'dX is the part a prismatic model throws away.',
            'bars': [
                {'part': 'Internal_Rod', 'link_L': 'rod_L', 'link_R': 'rod_R',
                 'joint_L': 'jaw_rod_L', 'joint_R': 'jaw_rod_R',
                 'ground_xy': hinges[2], 'coupler_xy': hinges[0], 'length_mm': round(L0, 4)},
                {'part': 'External_Rod', 'link_L': 'rod2_L', 'link_R': 'rod2_R',
                 'joint_L': 'jaw_rod2_L', 'joint_R': 'jaw_rod2_R',
                 'ground_xy': hinges[3], 'coupler_xy': hinges[1], 'length_mm': round(L1, 4)},
            ],
            'bars_note': 'Reference data for the two bars of the -Y side (mirror Y for +Y). The '
                         'bars are REAL LINKS on real revolute joints now, so nothing has to '
                         'animate them: FK moves them, the collision world poses them, and their '
                         'distal pivots stay on the finger pivots at every jaw angle.',
            'derived_from': 'the four hinge coordinates in the PincOpen mods README (off-repo), '
                            'reverse-engineered there from the meshes and verified by point containment',
        },
        'control_display': {
            'jaw': {
                'unit': 'mm',
                'label': 'opening gap',
                'kind': 'fourbar_gap',
                'link_length_mm': round(L0, 4),
                'closed_crank_deg': round(th0, 4),
                'range': [0.0, round(gap, 3)],
                'step': 0.5,
                'to_display': 'gap_mm = 2 * L * (sin(th0) - sin(th0 - q_deg))',
                'from_display': 'q_deg = th0 - degrees(asin(sin(th0) - gap_mm / (2 * L)))',
                'note': 'The control joint is an ANGLE; what a user wants to dial is the gap '
                        'between the fingers in millimetres. A UI that understands `kind` may '
                        'show the slider in `unit` over `range` and convert on the way in and '
                        'out; one that does not still gets a correct degree slider.',
            },
        },
        'stroke_mm': {
            'max_opening_mm': round(gap, 3),
            'at_jaw_deg': round(qmax, 3),
            'closed_gap_mm': None,            # measured from the meshes by measure_jaw_stroke()
            'source': 'derived from the linkage geometry, NOT an upstream specification - '
                      'upstream publishes no joint range',
        },
    }


DUP_MM = 0.75


def dedupe_instances(instances):
    """One record per PHYSICAL instance, matched on body centroid rather than on matrix."""
    # A symmetric rod admits a 180 deg rotation about its own axis, so two matrices can put one
    # part in the same place.  Centroids within DUP_MM are one instance; the full-resolution
    # assembly's record wins over the decimated one.
    order = {'full': 0, 'decimated': 1}
    kept = []
    for inst in instances:
        c = np.asarray(inst['body_centroid'], float)
        hit = None
        for k in kept:
            if k['part'] != inst['part']:
                continue
            if np.abs(np.asarray(k['body_centroid'], float) - c).max() <= DUP_MM:
                hit = k
                break
        if hit is None:
            kept.append(dict(inst))
            continue
        a = order.get(hit.get('assembly_quality', 'full'), 9)
        b = order.get(inst.get('assembly_quality', 'full'), 9)
        also = hit.get('also_in', []) + [inst['assembly']]
        if (b, inst['residual_rms_mm']) < (a, hit['residual_rms_mm']):
            hit.update(inst)
        hit['also_in'] = also
    by_part = {}
    for k in kept:
        k['instance'] = by_part.get(k['part'], 0)
        by_part[k['part']] = k['instance'] + 1
    return kept

# The drive servo.  Upstream PincOpen ships only the printed parts, so the motor that drives
# the Cam has no STL.  It is the same STS3215 the SO-101 gripper joint uses, so the mesh is
# LeKiwi's own STS3215_03a-v1.stl (Apache-2.0, see SOURCE.md).  Nothing to register against,
# so it is SEATED on three interfaces the package's own meshes define, measured on the
# exported geometry:
#
#   Z   the motor's horn-side shoulder face (mesh z +15.90) lands on the two rails the
#       Top_Plate's motor slot presents at Z = 7.2025  ->  translation z = 23.1025.  This is
#       assembly step 31, "put the motor in its slot on the palm".  RESIDUAL 0.0000 mm.
#   X   the mounting-hole pair on the motor's back (mesh x +4.205) lands on the Motor_Flange's
#       two M2.5 holes at X = -26.27; independently, the motor's nose face (mesh x +22.70)
#       lands on the Top_Plate's inner wall at X = -7.83.  RESIDUAL 0.025 / 0.030 mm.
#   Y   the case (24.8 wide) fills the Motor_Flange's 24.80 mm fork (leg inner faces Y +-12.40)
#       and the hole pair sits at Y +-10.25 against the flange's +-10.245.  RESIDUAL 0.005 mm.
#
# and the two interfaces that fall out of it rather than setting it:
#   the horn face (mesh z +18.70) at Z 4.4025 against the Cam's top face Z 4.150 (0.25 mm), and
#   the back face (mesh z -15.90) at Z 39.0025 against the flange strap's underside Z 39.13
#   (0.13 mm).  The horn axis lands on X -18.000 against the Cam disc centre X -18.040.
#
# The mesh is drawn with the passive rear horn fitted (d20 x 1.8 mm disc above the back face)
# plus a 6-pin plug stub; PincOpen fits no rear horn, so everything above Z 39.0025 is model,
# not machine.  Below it the placed motor is clear of every part of the gripper: Top_Plate
# 4.2 mm3 (a 0.03 mm skin where the nose touches the wall), Motor_Flange 3.7 mm3 (a 0.04 mm
# skin on a fork leg), Camera_basement 0.02 mm3, Bottom_Plate / Interface_ARM100 / both
# Driving_Rods 0.000 mm3.
SERVO_MESH = 'meshes/STS3215_03a-v1.stl'
SERVO_LOCAL = [1.0, 0.0, 0.0, 0.0,
               0.0, -1.0, 0.0, 0.0,
               0.0, 0.0, -1.0, 0.0,
               -30.5, 0.0, 23.1025, 1.0]


def sts3215_drive():
    """The Feetech STS3215 that drives the Cam, as a hardware (non-printable) component."""
    return dict(
        id='sts3215_drive', label='STS3215 drive servo', part='STS3215_03a-v1', instance=0,
        mesh=SERVO_MESH, group='hardware', frame='robot', link=None,
        local=SERVO_LOCAL, mirrored=False, side=None, color='#23262b',
        printable=False, print_file=None, moves_with=None, linkage_role='ground',
        hardware=True,
        source={'repo': 'https://github.com/SIGRobotics-UIUC/LeKiwi', 'commit': LEKIWI_COMMIT,
                'license': 'Apache-2.0', 'file': 'URDF/meshes/STS3215_03a-v1.stl',
                'note': 'the SO-101 gripper motor, which PincOpen reuses; mesh copied from the '
                        'LeKiwi package into meshes/ so this package stays self-contained'},
        note='Feetech STS3215 (30 kg.cm), horn DOWN on the vertical axis X -18.0, Y 0. '
             'Bought, not printed. Assembly steps 30-32: the flange screws onto the motor, the '
             'motor drops into the Top_Plate slot, the Cam bolts to its spreader-bar horn.',
        placement={
            'method': 'seated on three measured interfaces (no registration target exists - '
                      'upstream ships no motor mesh)',
            'seats': [
                {'what': 'horn-side shoulder face on the Top_Plate motor-slot rails',
                 'axis': 'Z', 'part_mm': 7.2025, 'servo_mm': 7.2025, 'residual_mm': 0.0},
                {'what': 'back mounting-hole pair on the Motor_Flange M2.5 holes',
                 'axis': 'X', 'part_mm': -26.27, 'servo_mm': -26.295, 'residual_mm': 0.025},
                {'what': 'back mounting-hole pair on the Motor_Flange M2.5 holes',
                 'axis': 'Y', 'part_mm': 10.245, 'servo_mm': 10.25, 'residual_mm': 0.005},
                {'what': 'nose face on the Top_Plate inner wall',
                 'axis': 'X', 'part_mm': -7.83, 'servo_mm': -7.80, 'residual_mm': 0.03},
            ],
            'checks': [
                {'what': 'horn face vs the Cam top face', 'part_mm': 4.150,
                 'servo_mm': 4.4025, 'residual_mm': 0.2525},
                {'what': 'back face vs the Motor_Flange strap underside', 'part_mm': 39.13,
                 'servo_mm': 39.0025, 'residual_mm': 0.1275},
                {'what': 'horn axis vs the Cam disc centre', 'part_mm': -18.040,
                 'servo_mm': -18.000, 'residual_mm': 0.040},
            ],
            'envelope_mm': [[-53.200, -12.400, 2.902], [-7.800, 12.400, 42.502]],
            'interference_mm3': {
                'top_plate': 4.18, 'bottom_plate': 0.0, 'motor_flange': 89.96,
                'camera_basement': 83.12, 'camera_mobile_sup': 0.0, 'interface_arm100': 0.0,
                'driving_rod': 0.0, 'driving_rod_2': 0.0, 'cam': 16.67,
            },
            'interference_below_back_face_mm3': {
                'top_plate': 4.18, 'motor_flange': 3.73, 'camera_basement': 0.02,
            },
            'interference_depth_mm': {'motor_flange': 1.000, 'camera_basement': 1.609,
                                      'cam': 0.992, 'top_plate': 0.028},
            'interference_audit': {
                'mesh': 'measured on meshes/STS3215_03a-v1.stl at 6506 faces, watertight - '
                        'NOT on the decimated copy in src/data/assets.js (FACE_CAPS caps '
                        'STS3215* at 6000), which will read slightly differently',
                'top_plate': 'a 0.028 mm skin where the motor\'s nose face (X -7.800) meets '
                             'the Top_Plate\'s inner wall (X -7.83). Same order as the '
                             '0.025 mm tab-hole residual: registration noise, and it CONFIRMS '
                             'the X placement rather than contradicting it.',
                'motor_flange': '86 of the 90 mm3 sit at Z 39.1..40.8, i.e. ABOVE the motor\'s '
                                'own back face: the mesh\'s PASSIVE REAR HORN, a d20 x 1.8 mm '
                                'disc PincOpen does not fit (its flange straps straight onto '
                                'the back). Cut the mesh at the back face and 90 -> 3.7 mm3, '
                                'which is the 0.04 mm skin on one fork leg - the registered '
                                'flange is 12.46 / 12.36 about Y = 0 against the motor\'s '
                                '+-12.40.',
                'camera_basement': 'the same rear horn. 83 -> 0.02 mm3 below the back face. '
                                   'The basement is also the UPSTREAM camera mount, an '
                                   'alternative to whatever sits on the seat.',
                'cam': 'the drawn splined shaft (d5.4, on X -18) inside the Cam\'s central '
                       'bore, 1.25 mm deep - the DRIVE COUPLING. PincOpen puts a Feetech '
                       'spreader-bar horn on that shaft and screws the Cam to the bar with 5 '
                       'screws (assembly guide steps 18 and 32); the URDF draws an integrated '
                       'disc horn with the shaft 1.5 mm proud of it instead.',
                'is_it_a_placement_error': 'No. Sweeping Z by +-0.60 mm trades the two: '
                                           'flange 58 -> 121 mm3 while cam 116 -> 7 mm3, and '
                                           'neither reaches zero. The overlaps are 1.0-1.6 mm '
                                           'DEEP - 40 to 60 times the 0.025 mm tab-hole '
                                           'residual - so they are geometry, not placement. '
                                           'Z stays where the motor\'s shoulder seats on the '
                                           'Top_Plate slot rails (residual 0.0000 mm), which '
                                           'is PincOpen\'s own assembly datum (step 31).',
            },
            'interference_note': 'Every number above the back face (Z 39.0025) is the mesh\'s '
                                 'PASSIVE REAR HORN (d20 x 1.8 mm) and its 6-pin plug stub, '
                                 'which PincOpen does not fit; cut the mesh at the back face '
                                 'and the flange falls to 3.7 mm3 and the basement to 0.02. '
                                 'The 16.7 mm3 at the Cam '
                                 'is the drawn splined shaft inside the Cam\'s central bore - '
                                 'the drive coupling, not a clash. For scale, the URDF\'s own '
                                 'servo/bracket pairs interpenetrate 375-399 mm3 at the wrist.',
        },
    )
