"""LeKiwi rear-corner over-the-shoulder camera mast: a printed spar, a yoke and one head.

ONE post on the rear-LEFT deck corner, outside the arm's raised envelope by construction,
carrying the sensor high and BEHIND the shoulder, looking diagonally across the workspace.
See the sibling DESIGN.md for why, and for the 384-pose sweep that chose the numbers
(assets/parts/corner_mast_printed/DESIGN.md).

Frames.  Everything is built directly in ROBOT millimetres (+X right, +Y forward, +Z up,
ground Z = -32.9, deck top Z = 57), so the exported solids drop into the studio with an
identity `local`.  The camera basis is

    n  = (sin p cos t,  cos p cos t, -sin t)     optical axis, forward and DOWN
    xd = (cos p, -sin p, 0)                      image right, horizontal (no roll)
    up = xd x n                                  image up

with `t` the nose-down tilt and `p` the pan toward the workspace centre (+X, because the post
stands on the -X corner).  The sensor sits HEAD_FWD out along the horizontal part of n from the
post axis.

THREE printed plates carry the whole mast:

  `spar_lower`  deck plate + the lower half of the tapered hollow PLA spar.
  `spar_upper`  the upper half, growing the two hinge cheeks and the tilt index fan straight
                off the top of the spar.  The two halves meet on a chamfered spigot that
                carries the torque AND fixes the pan.
  `head`        the clamp block, hung between the cheeks.

The retainer plate and the pocket shims are NOT new plates.  They are the shared
`print/camera_retainer_PRINT.stl` (the same solid to 0.005 mm, verified on the exported
meshes) and `print/camera_shims_PRINT.stl`.  `retainer.stl` still ships as a robot-frame mesh
so the studio draws the assembled head; it carries no plate of its own.

Adjustment (VLA extrinsics must be repeatable, so every adjustment is a POSITIVE index, never
a friction setting):
  * tilt:  a hinge detent - one M3 x 8 pin through the outboard cheek into a BLIND 3.0 mm
           seat in the head's side wall.  Settings: 40/45/50/55/60/65/70 deg.
  * pan:   FIXED by the spigot at the design 10 deg; regenerate the spar to change it.

usage:  python3 gen_corner_mast.py <outdir>
"""
import os
import warnings

import cadquery as cq
import numpy as np
import trimesh

from corner_mast_dims import BOLTS, PARAMS, _ret_place        # noqa: F401
from corner_mast_geom import Corner

warnings.filterwarnings('ignore')



# export helpers
def _ex(shape, path):
    cq.exporters.export(shape, path, tolerance=0.04, angularTolerance=0.2)
    return path


def _print_stl(src, dst, mat=None):
    """Lay a robot-frame solid on the bed: optional 4x4, then park on Z = 0, XY-centred."""
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


def print_orientations(C):
    """robot frame -> bed, per part.  Only two parts need turning:

    * `head`  goes LENS FACE DOWN, so the clamp pocket opens upward, the two retainer ears
      point up and the 55 deg seat, which sets the camera aim, is the flat FIRST layer
      instead of a supported overhang.
    Everything else prints in the orientation it is built in, base on the bed.
    """
    return {'head': _frame_to_bed(C.xd, C.up, -C.n, C.CAM),
            'retainer': _ret_to_bed(C)}


def _frame_to_bed(bx, by, bz, origin):
    """robot -> bed for a part built on the (bx, by, bz) frame at `origin`: a pure rotation
    plus the translation that puts `origin` at 0 (the caller then parks it on the bed)."""
    R = np.column_stack([bx, by, bz])
    U, _, Vt = np.linalg.svd(R)
    R = U @ Vt
    M = np.eye(4)
    M[:3, :3] = R.T
    M[:3, 3] = -R.T @ np.asarray(origin, float)
    return M


def _ret_to_bed(C):
    """the retainer plate, back on the bed - and then turned over, so the 58 x 26 flat face is
    the first layer and the 3.5 mm clamping boss points UP.  Printed the other way up the boss
    is on the bed and the plate's whole underside is a 3.5 mm bridge (18.3% overhang)."""
    F = np.eye(4)
    F[:3, :3] = np.diag([1.0, -1.0, -1.0])
    return F @ np.linalg.inv(_ret_place(C))


def bom(C):
    """What to buy, beyond the printed plates.  Every length below is the MEASURED stack on the
    exported meshes plus the engagement it leaves; driver access for each is the O7 x 60 /
    O3.6 x 60 cast against the assembled robot in the set's ASSEMBLY.md."""
    deck = {
        # O3.50 and 7.0 mm are MEASURED on assets/robots/lekiwi/meshes/base_plate_layer2-v3.stl:
        # the plate runs Z 50..57 and every grid hole is a tessellated O3.50 circle.
        'deck_inserts': '%dx M3 brass heat-set insert (M3 x 5.7, O4.6 knurl) melted into the '
                        'deck grid holes at %s. The stock grid hole measures O3.50 on the deck '
                        'plate: open it to O4.0 with a hand drill first. The deck plate is '
                        '7.0 mm thick (Z 50..57), so a 5.7 mm insert sits flush in it with '
                        '1.3 mm to spare.' % (len(BOLTS), BOLTS),
        'deck': '%dx M3 x 8 socket cap. Head bears at Z 59.80 on a 2.80 mm pad, so 5.20 mm of '
                'the 5.70 mm insert is engaged and NOTHING protrudes below the deck - which is '
                'what matters, because three of the four bolts sit over the LiPo (pack top '
                'Z 46.50, deck underside Z 50.00). No nut, no blind fitting, and the battery '
                'stays in.' % len(BOLTS)}
    # `spar_upper` grows the cheeks straight off the spar - no collar, no seat disc, no clamp -
    # so the only joint below the hinge is the spigot, and there is no pinch screw anywhere.
    spar = {
        'spigot': '3x M3 x 8, the Z %.0f spar spigot: 2 on +X (Z %.0f and %.0f) and 1 on -Y '
                  '(Z %.1f), each a O3.5 clearance hole in the upper half into a O2.5 '
                  'thread-forming pilot in the lower. No pinch clamp and no nuts - the joint '
                  'is a chamfered rectangle that carries the torque and fixes the pan itself.'
                  % (C.split_z, C.split_z + 7.0, C.split_z + 16.0, C.split_z + 11.5)}
    shared = {
        # the pin stack is 54.20 mm (yoke cheek outer faces at xd +-27.10): an M3 x 55 leaves
        # 0.80 mm of thread, which no nut - let alone a 4 mm nyloc - can take.
        'hinge': '1x M3 x 60 + nyloc, the head hinge (54.20 mm of stack, 5.80 mm proud)',
        'index': '1x M3 x 8, the tilt index pin. 5.00 mm of cheek + 0.40 mm of gap leaves '
                 '2.60 mm in a 3.00 mm BLIND seat, so it cannot reach the camera module '
                 '(0.00 mm3, measured). An M3 x 12 in the rev-1 through-seat stood 2.9 mm '
                 'inside the module.',
        'retainer': '2x M3 x 12 self-tapping, the camera retainer (4.00 mm of plate into a '
                    'O2.60 x 9.50 pilot: 8.0 mm of bite)',
        'retainer_plate': 'PRINT the shared "Camera retainer plate" upgrade - it is this '
                          'set\'s retainer, the same solid to 0.005 mm. This set ships no '
                          'second copy.',
        'shims': 'PRINT the shared "Camera pocket shims" upgrade if the module is under 11 mm '
                 'deep: 36 x 36 mm spacers 0.4 / 0.8 / 1.6 mm thick with the same 24 x 14 '
                 'window, stackable to 2.8 mm in 0.4 mm steps.'}
    out = dict(deck)
    out.update(spar)
    out.update(shared)
    return out


def build(params=None, outdir='.', log=print):
    C = Corner(params)
    os.makedirs(outdir, exist_ok=True)
    log("corner mast: post (%.1f, %.1f)  sensor (%.2f, %.2f, %.1f)  tilt %.1f  pan %.1f"
        % (C.px, C.py, C.CAM[0], C.CAM[1], C.CAM[2], C.tilt, C.pan))
    log("  optical axis n = (%.5f, %.5f, %.5f);  hinge at (%.2f, %.2f, %.2f), seat Z %.2f"
        % (C.n[0], C.n[1], C.n[2], C.HINGE[0], C.HINGE[1], C.HINGE[2], C.seat_z))
    out = {'cam': [float(v) for v in C.CAM], 'tilt_deg': C.tilt, 'pan_deg': C.pan,
           'camera_matrix16': C.matrix16(), 'files': {}, 'parts': {}}

    jobs = [('head', C.head, None), ('retainer', C.retainer, None),
            ('spar_lower', C.spar_lower, None), ('spar_upper', C.spar_upper, None)]

    for name, fn, _ in jobs:
        s = fn()
        fp = os.path.join(outdir, name + '.stl')
        _ex(s, fp)
        b = s.BoundingBox()
        out['files'][name] = fp
        out['parts'][name] = dict(volume_cm3=round(s.Volume() / 1000, 2),
                                  valid=bool(s.isValid()),
                                  bbox=[round(b.xmin, 1), round(b.xmax, 1), round(b.ymin, 1),
                                        round(b.ymax, 1), round(b.zmin, 1), round(b.zmax, 1)])
        log("  %-11s vol %6.1f cm3  valid=%s  X %.1f..%.1f  Y %.1f..%.1f  Z %.1f..%.1f"
            % (name, s.Volume() / 1000, s.isValid(), b.xmin, b.xmax, b.ymin, b.ymax,
               b.zmin, b.zmax))

    out['detents'] = {}
    for t in C.detents:
        c, nn = C.cam_at(t)
        out['detents']['%g' % t] = {'cam': [round(float(v), 4) for v in c],
                                    'n': [round(float(v), 6) for v in nn],
                                    'tilt_deg': t,
                                    'ring': 'outer' if C.detents.index(t) % 2 == 0 else 'inner'}

    out['gusset_runs_mm'] = getattr(C, 'gusset_runs', None)
    out['bom'] = bom(C)
    rots = print_orientations(C)
    out['print'] = {}
    for name, fp in list(out['files'].items()):
        dst = os.path.join(outdir, name + '_PRINT.stl')
        r = _print_stl(fp, dst, rots.get(name))
        out['print'][name] = dict(file=dst, **r)
        log("  PRINT %-11s bed %5.1f x %5.1f x %5.1f mm  %5.1f cm3  wt=%s"
            % (name, r['bed'][0], r['bed'][1], r['bed'][2], r['volume_cm3'], r['watertight']))
    return C, out


if __name__ == '__main__':
    import sys
    import time
    d = sys.argv[1] if len(sys.argv) > 1 else '/tmp/corner'
    t0 = time.time()
    C, r = build({}, d)
    print("build %.1f s" % (time.time() - t0))
    for k, f in r['files'].items():
        m = trimesh.load(f)
        print("  %-12s wt=%-5s bodies=%d vol=%8.2f cm3" %
              (k, m.is_watertight, m.body_count, m.volume / 1e3))
