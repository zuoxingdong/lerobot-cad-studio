"""PincOpen wrist camera - the DF200 forward clamp arch.

A bracket for the SAME insertable clamp pocket the corner mast uses, so one pocket / retainer /
shim family serves the overhead head and the wrist:

  * feet on the PincOpen camera seat (Z = 19.50) and its 4x M2.5 pattern
    (X -41.27 / -26.27, Y +-18.91), STRADDLING the STS3215 drive servo (Y +-12.4, up to
    Z 42.5) - which is now a real component of the pincopen package, so the straddle is
    measured, not asserted,
  * an arch that leans forward over the gripper body to the sensor at (-16, 0, 95),
  * the clamp block hung between two cheeks on the image-right axis (+-Y here), on an
    M3 through-bolt with a printed detent fan: 7 settings, 5 deg apart, +-15 deg about the
    45 deg design tilt (30..60 deg); it ships in the 35 deg hole,
  * the shared 58 x 26 retainer plate and the 0.4 / 0.8 / 1.6 mm pocket shims, unchanged.

Why 35 deg and what the DF200's 87.3 deg lens frames is in assets/parts/df200_arch/DESIGN.md;
the framing model is re-derived here in `framing()` from the landmarks below, so it needs no
external source.

usage:  python3 gen_wristcam_arch.py <outdir>
"""
import os
import warnings

import cadquery as cq
import numpy as np
import trimesh

from wristcam_arch_parts import (Arch, CB_D, CB_H, CONN, CONN_CLEAR,
                                 FLANGE_FOOT, HOLE_X, PARAMS, RAIL_T, SEAT_Z,
                                 framing_table)             # noqa: F401

warnings.filterwarnings('ignore')


def bom(A):
    """What to buy, beyond the two printed plates.  Every length is the MEASURED stack on the
    exported meshes: the Top_Plate's blind hole is Z 19.50 -> 12.888 (6.61 mm, 3.89 mm of plate
    below it) at all four seat positions, the Motor_Flange's front feet are 2.0 mm annular
    bosses with their tops at Z 21.36-21.49 (+Y) and 21.52-21.68 (-Y), and the arch's pads are
    RAIL_T thick with a CB_D x CB_H counterbore, i.e. 2.50 mm of plastic under each head."""
    front_grip = (FLANGE_FOOT['z'] + RAIL_T - CB_H) - SEAT_Z
    rear_grip = (SEAT_Z + RAIL_T - CB_H) - SEAT_Z
    return {'seat_front': '2x M2.5 x 10, the FRONT seat pair at X %.2f. Head bears at Z %.2f, '
                          'so %.2f mm of stack - a %.2f mm rise from the seat plane to the pad '
                          'underside (the flange foot stands 1.86 to 2.18 mm proud of the seat '
                          'and the remaining 0.02 to 0.34 mm is air) plus the %.2f mm pad - '
                          'leaves %.2f mm in a 6.61 mm blind hole, %.2f mm spare.'
                          % (HOLE_X[1], FLANGE_FOOT['z'] + RAIL_T - CB_H, front_grip,
                             FLANGE_FOOT['z'] - SEAT_Z, RAIL_T - CB_H,
                             10.0 - front_grip, 6.61 - (10.0 - front_grip)),
            'seat_rear': '2x M2.5 x 8, the REAR seat pair at X %.2f. Head bears at Z %.2f, '
                         '%.2f mm of stack, %.2f mm of thread in a 6.61 mm blind hole - '
                         '%.2f mm spare. (The rev-1 M2.5 x 8 over a 0.48 mm pad bottomed '
                         '0.88 mm before the head touched and never clamped.)'
                         % (HOLE_X[0], SEAT_Z + RAIL_T - CB_H, rear_grip, 8.0 - rear_grip,
                            6.61 - (8.0 - rear_grip)),
            'seat_note': 'Hand torque, no washer needed: the O%.1f x %.1f counterbore leaves '
                         '%.2f mm of pad under each head. Bolt the arch on BEFORE the gripper '
                         'goes back on the wrist - the wrist-roll bracket sits 1.0 mm over the '
                         'rear pair, and a ball-end key is the only tool that reaches the '
                         'rear -Y screw with the arm assembled.' % (CB_D, CB_H, RAIL_T - CB_H),
            'hinge': '1x M3 x 60 + nyloc, the head hinge (54.2 mm across both cheeks)',
            'index': '1x M3 x 8, the tilt index pin. The seat in the head is BLIND, 3.0 mm '
                     'deep: 5.00 cheek + 0.40 gap + 2.60 of seat, and it cannot reach the '
                     'camera module (0.00 mm3, measured).',
            'retainer': '2x M3 x 12 self-tapping, the camera retainer',
            'retainer_plate': 'PRINT the shared "Camera retainer plate" upgrade - it is this '
                              'set\'s retainer, the same solid to 0.005 mm.',
            'shims': 'PRINT the shared "Camera pocket shims" upgrade if the module is under '
                     '11 mm deep (36 x 36 mm, 0.4 / 0.8 / 1.6 mm).',
            'ties': '2x 2.5 mm zip tie: one through the crown lug for the servo harness, one '
                    'round a leg for the DF200 pigtail (leave a 40 mm service loop)'}


def _ex(shape, path):
    cq.exporters.export(shape, path, tolerance=0.04, angularTolerance=0.2)
    return path


def _print_stl(src, dst, mat=None):
    m = trimesh.load(src)
    if mat is not None:
        m.apply_transform(mat)
    b = m.bounds
    m.apply_translation([-(b[0][0] + b[1][0]) / 2, -(b[0][1] + b[1][1]) / 2, -b[0][2]])
    m.export(dst)
    b = m.bounds
    return dict(bed=[round(float(b[1][i] - b[0][i]), 1) for i in range(3)],
                volume_cm3=round(float(m.volume) / 1000, 2),
                watertight=bool(m.is_watertight), bodies=int(m.body_count))


def _frame_to_bed(bx, by, bz, origin):
    R = np.column_stack([bx, by, bz])
    U, _, Vt = np.linalg.svd(R)
    R = U @ Vt
    M = np.eye(4)
    M[:3, :3] = R.T
    M[:3, 3] = -R.T @ np.asarray(origin, float)
    return M


def print_orientations(A):
    """`head` lens face down (the pocket opens upward, the 45 deg seat is the first layer);
    `retainer` flat face down, boss up; `arch` UPRIGHT, exactly as it is built.

    Rev 1 turned the arch -45 deg about Y because that minimised the overhang PERCENTAGE
    (6.9 %).  Measured on the exported plate it also gave the part **0.0 mm2 of flat bed
    contact** - a 78 mm tall, 68 x 54 mm fork balanced on two points, with a 5.6 mm2 first
    layer - and `printcheck` passed it, because an area fraction cannot see that.  A 168-
    orientation re-search on the consolidated arch (bed contact vs overhang, every 15 deg):

        upright (this)   398.5 mm2 of bed contact, 12.49 % overhang, 49 x 54 x 88 mm
        -45 about Y      31.8 mm2 (the mirror image of rev 1's), 5.55 %
        +90 about X      1330.4 mm2, 14.02 % - but ~900 mm2 of that is the far leg's
                         underside floating 49 mm up: one huge supported slab
        rev-1 (-45)      0.0 mm2

    Upright is the one that prints: the two base rails - the very faces that have to be flat,
    because they are the datum the arch seats on - are the first layer.  The print note lists
    the four features that need support (both cheek undersides, the fan rim, the crown hump).
    """
    F = np.eye(4)
    F[:3, :3] = np.diag([1.0, -1.0, -1.0])
    return {'head': _frame_to_bed(A.xd, A.up, -A.n, A.CAM),
            'retainer': F @ np.linalg.inv(A.ret_place())}


def build(params=None, outdir='.', log=print):
    A = Arch(params)
    os.makedirs(outdir, exist_ok=True)
    log('wrist arch: sensor (%.2f, 0, %.2f)  tilt %.1f  hFOV %.0f  hinge (%.2f, 0, %.2f)'
        % (A.sx, A.sz, A.tilt, A.hfov, A.HINGE[0], A.HINGE[2]))
    out = {'sensor': [float(v) for v in A.CAM], 'tilt_deg': A.tilt, 'hfov_deg': A.hfov,
           'camera_matrix16': A.matrix16(), 'files': {}, 'parts': {}, 'detents': {}}
    for name, fn in (('head', A.head), ('arch', A.arch), ('retainer', A.retainer)):
        s = fn()
        fp = os.path.join(outdir, name + '.stl')
        _ex(s, fp)
        b = s.BoundingBox()
        out['files'][name] = fp
        out['parts'][name] = dict(volume_cm3=round(s.Volume() / 1000, 3),
                                  valid=bool(s.isValid()),
                                  bbox=[round(b.xmin, 2), round(b.xmax, 2), round(b.ymin, 2),
                                        round(b.ymax, 2), round(b.zmin, 2), round(b.zmax, 2)])
        log('  %-9s vol %6.2f cm3  valid=%s  X %.1f..%.1f  Y %.1f..%.1f  Z %.1f..%.1f'
            % (name, s.Volume() / 1000, s.isValid(), b.xmin, b.xmax, b.ymin, b.ymax,
               b.zmin, b.zmax))
    grams = 1.24 * sum(out['parts'][k]['volume_cm3'] for k in ('head', 'arch', 'retainer'))
    out['mass_g_solid_pla'] = round(grams, 1)
    out['framing'] = framing_table(A)
    # The thresholds `framing` is read against, generated beside it so a detent list and a
    # gates sentence cannot be written from one set of numbers and checked against another.
    out['framing_gates'] = dict(
        led_margin_deg_min=4.7, servo_margin_deg_min=4.7, v_grasp_abs_max=1.0,
        pad_uv_abs_max=1.0,
        note='the drive servo LED and the servo\'s forward-top corner out of frame with at '
             'least 4.7 deg of margin at EVERY pupil offset in the bracket, the grasp point '
             'inside the frame, and both pads inside it closed and at 40 mm open')
    out['bom'] = bom(A)
    out['connector_corridor'] = dict(
        x=[CONN['x0'], CONN['x1']], y_half=CONN['y'], z_top=CONN['z'],
        socket_face_z=CONN['z_face'], clear_mm=round(CONN_CLEAR, 2),
        note='kept empty by an unconditional cut in Arch.arch(); the crossbar humps over it')
    log('  on-robot mass, 100%% PLA (1.24 g/cm3): %.1f g' % grams)
    for t in A.detents:
        cam, n = A.cam_at(t)
        out['detents']['%g' % t] = {'tilt_deg': t, 'cam': [round(float(v), 4) for v in cam],
                                    'camera_matrix16': A.matrix16(t)}
    rots = print_orientations(A)
    out['print'] = {}
    for name, fp in list(out['files'].items()):
        dst = os.path.join(outdir, name + '_PRINT.stl')
        r = _print_stl(fp, dst, rots.get(name))
        out['print'][name] = dict(file=dst, **r)
        log('  PRINT %-9s bed %5.1f x %5.1f x %5.1f mm  %5.2f cm3  wt=%s'
            % (name, r['bed'][0], r['bed'][1], r['bed'][2], r['volume_cm3'], r['watertight']))
    return A, out


if __name__ == '__main__':
    import sys
    import time
    d = sys.argv[1] if len(sys.argv) > 1 else '/tmp/wristarch'
    t0 = time.time()
    A, r = build({}, d)
    print('build %.1f s' % (time.time() - t0))
