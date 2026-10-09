#!/usr/bin/env python3
"""Rebuild the two camera mounts into assets/parts/<id>/ from the CadQuery generators.

    uv run --extra cad python tools/build/make_mounts.py [--only corner_mast_printed,df200_arch]

Writes mesh/ (robot-frame meshes), print/ (bed plates), record.json (the generator's evidence:
label, camera, hinge, bom, framing, access audit) and then part.json, the same way
`make_robots.py --only parts` does.  Applies the shipped index-pin detent.

The detent is separate because the generators build the head at the DESIGN tilt (the middle
hole of the index fan, which every offset in them is quoted in) while a different hole ships.
Moving it is not a reprint - the head and retainer are the same meshes rotated about the
hinge - so print/ stays at the design tilt and only head.stl / retainer.stl turn.
make_robots.py stores that rotation as the print_transform it Kabsch-fits between the two.

df200.stl is a volumetric stand-in, generated in each set's own camera frame at the shipped
detent, with its connector on whichever axis clears the retainer's 24 x 14 window.
"""
import argparse
import json
import math
import os
import shutil
import sys
import tempfile
import warnings

warnings.filterwarnings('ignore')

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(STUDIO, 'tools', 'cad'))

from packlib.atomic import write_json    # noqa: E402  (after the sys.path setup)

sys.path.insert(0, HERE)                 # tools/build, for the package generators' own checks
from robots.checks import typography     # noqa: E402
from robots.parts import build_part      # noqa: E402
from robots.paths import PARTS           # noqa: E402

import numpy as np                                                    # noqa: E402
import trimesh                                                        # noqa: E402

# The shipped index-pin hole for each set, and the parts it copies out of the generator.
# `parts` are the ROBOT-FRAME meshes the studio draws; `plates` are the bed files it exports.
# The retainer and the pocket shims are in `parts` but NOT in `plates`: those are the shared
# cam_retainer / camera_shims print-only upgrades, and no set ships a second copy (the
# retainer plate is the same solid to 0.005 mm, measured on the exported meshes).
#
# `detent` is the ONE place the shipped index hole is written down: the label,
# `params.shipped_detent_note` and the notes header are all derived from it, and
# make_robots.py refuses a label that does not carry it.
SETS = {
    # the DEFAULT overhead mount: all-PLA, THREE plates.  `spar_lower` carries the deck base
    # and `spar_upper` grows the hinge cheeks and the index fan itself, so there is no collar,
    # no seat disc and no clamp between the spar and the yoke at all.
    'corner_mast_printed': dict(
        slot='top_camera_mount', gen='mast',
        label_base='Corner mast, printed', detent=45.0, prev_detent=55.0,
        detent_reason='the DF200 is 87.3 deg H, not the 60 deg the pose sweep assumed, so the '
                      'frame is half as wide again',
        parts=['head', 'retainer', 'spar_lower', 'spar_upper'],
        plates=['head', 'spar_lower', 'spar_upper']),
    'df200_arch': dict(
        slot='wrist_camera_mount', gen='arch',
        label_base='DF200 arch', detent=35.0, prev_detent=40.0,
        detent_reason='the framing model measures from the lens ENTRANCE PUPIL, 8.0 mm in '
                      'front of the sensor, at which 40 deg puts the drive servo LED 0.61 deg '
                      'INSIDE the frame',
        parts=['arch', 'head', 'retainer'],
        plates=['arch', 'head']),
}

# the DF200 module stand-in (make_robots.build_upgrades' numbers, verbatim)
SENSOR_IN, MOD_D = 4.0, 11.0
BODY = (36.0, 36.0, 11.0)
LENS_R_H, HOOD_R_H = (10.0, 9.0), (6.5, 3.0)
CONN = (9.0, 5.0, 4.0)
LENS_OFF, HOOD_OFF, CONN_OFF, CONN_T = 4.5, 10.5, -2.0, 6.0


def log(*a):
    print(*a, flush=True)


def _frame(X, Y, Z, o):
    M = np.eye(4)
    M[:3, 0], M[:3, 1], M[:3, 2], M[:3, 3] = X, Y, Z, o
    return M


def df200_module(cam, n, xd, conn_axis='xd'):
    """the module, seated: front face on the 3 mm lip, sensor SENSOR_IN behind it."""
    yd, up = np.cross(n, xd), np.cross(xd, n)
    off = xd if conn_axis == 'xd' else up
    b = trimesh.creation.box(extents=BODY)
    b.apply_transform(_frame(xd, yd, n, cam + (SENSOR_IN - MOD_D / 2) * n))
    le = trimesh.creation.cylinder(radius=LENS_R_H[0], height=LENS_R_H[1])
    le.apply_transform(_frame(xd, yd, n, cam + (SENSOR_IN + LENS_OFF) * n))
    ho = trimesh.creation.cylinder(radius=HOOD_R_H[0], height=HOOD_R_H[1])
    ho.apply_transform(_frame(xd, yd, n, cam + (SENSOR_IN + HOOD_OFF) * n))
    co = trimesh.creation.box(extents=CONN)
    co.apply_transform(_frame(xd, yd, n,
                              cam + (SENSOR_IN - MOD_D + CONN_OFF) * n + CONN_T * off))
    return trimesh.util.concatenate([b, le, ho, co]), co


def _inter(a, b):
    try:
        r = trimesh.boolean.intersection([a, b], engine='manifold')
    except Exception:
        return float('nan')
    return 0.0 if r is None or r.is_empty or len(r.faces) == 0 else float(abs(r.volume))


def build_set(sid, spec, keep_tmp=False):
    dst = os.path.join(PARTS, sid)
    if not os.path.isfile(os.path.join(dst, 'record.json')):
        raise SystemExit('no part record at %s' % dst)
    for sub in ('mesh', 'print'):
        os.makedirs(os.path.join(dst, sub), exist_ok=True)
    tmp = tempfile.mkdtemp(prefix='mounts_%s_' % sid)
    log('\n=== %s -> %s' % (sid, dst))
    if spec['gen'] == 'mast':
        from gen_corner_mast import Corner, build as build_mast
        G, gen = build_mast({}, tmp, log=lambda *a: None)
        detent_frame = lambda t: (G.rot(t), G.cam_at(t), np.asarray(G.xd, float))  # noqa: E731
    else:
        from gen_wristcam_arch import Arch, build as build_arch
        G, gen = build_arch({}, tmp, log=lambda *a: None)
        detent_frame = lambda t: (G.rot(t), G.cam_at(t), np.asarray(G.xd, float))  # noqa: E731

    for stem in spec['parts']:
        shutil.copyfile(os.path.join(tmp, stem + '.stl'), os.path.join(dst, 'mesh', stem + '.stl'))
    for stem in spec['plates']:
        shutil.copyfile(os.path.join(tmp, stem + '_PRINT.stl'),
                        os.path.join(dst, 'print', stem + '_PRINT.stl'))
    # ...and delete what the set no longer ships, so a consolidation leaves no orphan STL for
    # make_robots.py to pick up.
    keep = set(s + '.stl' for s in spec['parts']) | {'df200.stl'}
    dropped = []
    for f in sorted(os.listdir(os.path.join(dst, 'mesh'))):
        if f.endswith('.stl') and f not in keep:
            os.remove(os.path.join(dst, 'mesh', f)); dropped.append('mesh/' + f)
    keep_p = set(s + '_PRINT.stl' for s in spec['plates'])
    for f in sorted(os.listdir(os.path.join(dst, 'print'))):
        if f.endswith('.stl') and f not in keep_p:
            os.remove(os.path.join(dst, 'print', f)); dropped.append('print/' + f)
    log('  %d meshes + %d plates copied%s'
        % (len(spec['parts']), len(spec['plates']),
           ('; dropped ' + ', '.join(dropped)) if dropped else ''))

    # the shipped detent: head + retainer only, about the hinge
    t = spec['detent']
    R, (cam, n), xd = detent_frame(t)
    up = np.cross(xd, n)
    M = _frame(xd, up, -n, cam)
    for stem in ('head', 'retainer'):
        m = trimesh.load(os.path.join(tmp, stem + '.stl'), process=False)
        m.apply_transform(R)
        m.export(os.path.join(dst, 'mesh', stem + '.stl'))
    log('  design tilt %.0f -> shipped detent %.0f;  sensor (%.4f, %.4f, %.4f)  '
        'n (%.6f, %.6f, %.6f)' % (G.tilt, t, cam[0], cam[1], cam[2], n[0], n[1], n[2]))

    # the module, in the head's pocket at that detent
    H = trimesh.load(os.path.join(dst, 'mesh', 'head.stl'), process=True)
    H.merge_vertices()
    RT = trimesh.load(os.path.join(dst, 'mesh', 'retainer.stl'), process=True)
    RT.merge_vertices()
    best = None
    for axis in ('xd', 'up'):
        mod, conn = df200_module(cam, n, xd, axis)
        v = (_inter(conn, RT), axis, mod, _inter(mod, H), _inter(mod, RT))
        if best is None or v[0] < best[0]:
            best = v
    vc, axis, mod, vh, vr = best
    mod.export(os.path.join(dst, 'mesh', 'df200.stl'))
    log('  df200.stl: connector along %s;  module \u2229 head %.3f mm3, \u2229 retainer %.3f, '
        'connector \u2229 retainer %.3f' % (axis, vh, vr, vc))
    # every robot-frame part's own volume, measured on the mesh this run exported: the mass
    # figures in the prose are volume x 1.24 g/cm3 and must not outlive the geometry
    part_volumes = {}
    for stem in spec['parts']:
        _m = trimesh.load(os.path.join(dst, 'mesh', stem + '.stl'), process=True)
        _m.merge_vertices()
        part_volumes[stem] = round(abs(float(_m.volume)) / 1000.0, 3)
    plate_stats = {}
    for stem in spec['plates']:
        m = trimesh.load(os.path.join(dst, 'print', stem + '_PRINT.stl'), process=True)
        m.merge_vertices()
        plate_stats[stem] = dict(
            bed_mm=[round(float(v), 1) for v in m.extents],
            volume_cm3=round(float(m.volume) / 1000.0, 2),
            mass_g_pla=round(float(m.volume) / 1000.0 * 1.24, 1))
    write_record(dst, sid, spec, G, gen, cam, n, M, plate_stats,
                 dict(axis=axis, head_mm3=vh, retainer_mm3=vr, conn_mm3=vc), part_volumes)
    build_part(sid)
    if not keep_tmp:
        shutil.rmtree(tmp, ignore_errors=True)
    return dict(id=sid, detent_deg=t, plates=list(spec['plates']), plate_stats=plate_stats,
                part_volumes_cm3=part_volumes,
                sensor=[float(v) for v in cam],
                n=[float(v) for v in n],
                camera_matrix16=[float(v) for v in M.T.reshape(-1)],
                module_conn_axis=axis, module_head_mm3=round(vh, 4),
                module_retainer_mm3=round(vr, 4), connector_retainer_mm3=round(vc, 4))


# `notes` is REBUILT FROM SCRATCH on every run, out of the objects that just built the
# geometry - never from the previous file, or a hand-written paragraph outlives the part it
# describes.  Nothing below reads meta['notes'].

# What is true of EVERY set, and only that.
DESIGN_STATE_COMMON = (
    'The plate count is down to the parts that carry load: the list above IS the set. The '
    'retainer plate and the pocket shims are the two SHARED print-only upgrades, "Camera '
    'retainer plate" and "Camera pocket shims", which this set references instead of shipping '
    'a second copy. The retainer is the same solid as this set\'s own retainer mesh to '
    '0.005 mm, measured on the exported meshes. The tilt index seat in the head is BLIND at '
    '3.0 mm and its pin is M3 x 8, so the pin cannot enter the camera module, and the head\'s '
    'cable duct is vertical and inside the wall.')

# ...and what is true of THIS set only, keyed by set id so one variant cannot inherit the
# other's parts.  Written out whole each run, never read back.
DESIGN_STATE = {
    'corner_mast_printed': (
        'This is the printed-spar mount, and the default overhead camera mount: three printed '
        'plates, no aluminium and nothing drilled. `spar_lower` carries the deck base and the '
        'lower spar; `spar_upper` grows the two hinge cheeks and the index fan directly off '
        'the top of the tapered spar. There is no metal tube, no base collar, no seat disc, '
        'no separate yoke or neck, no pinch clamp and no pan ring. The two halves meet on '
        'the Z 285 spigot, a chamfered rectangle that carries the torque AND fixes the pan, '
        'so pan is FIXED at the design 10 deg; regenerate the spar with a different '
        '`pan_deg` to change it. The section is symmetric, '
        'so a printed witness chevron on the -X face of each half says which way round the '
        'joint goes; get it wrong and the camera looks behind the robot. Thread the camera '
        'cable up the hollow spar BEFORE the spigot closes. The deck bolts are M3 x 8 into '
        'heat-set inserts, so nothing protrudes under the deck and the LiPo stays in. The two '
        'spar halves are 248.0 and 229.6 mm tall, so both need 250 mm of Z: an MK4 (220 mm) '
        'will not take them, an Ender 3 (250 mm) has 2.0 mm to spare on the taller one.'),
    'df200_arch': (
        'This is the WRIST mount: a two-plate forward clamp arch on the PincOpen camera face, '
        'carrying the same head, retainer and module as the corner mast. The legs are TRUE '
        '4 mm plates (rev 1\'s measured 0.54-0.84 mm perpendicular); the front pads sit ON '
        'the Motor_Flange feet instead of 1.1 mm above them; the seat screws are sized to the '
        'measured stacks; and it prints UPRIGHT, 398.5 mm2 of flat bed contact against 0.0 in '
        'rev 1. The crossbar HUMPS over the STS3215 connector band (Z 57.5..62.5 over '
        '|Y| <= 13) so the servo can still be plugged in with the arch on - 18.1 mm of clear '
        'air over the socket face, and the corridor stays open to the rear - and a zip-tie lug '
        'on the crown anchors the harness. The shipped detent is 35 deg rather than the design '
        '40 because the framing model measures from the lens ENTRANCE PUPIL, 8.0 mm in front '
        'of the sensor. At 40 deg the drive servo\'s LED is 0.61 deg INSIDE the frame; at '
        '35 deg it clears by 6.66 deg. The `pupil_model` and `framing` blocks of this file '
        'carry that table.'),
}

AXIS_LABEL = {'xd': 'image-RIGHT', 'up': 'image-UP'}


def set_label(spec):
    """`<base> . <shipped detent> deg` - the label, derived, so it cannot outlive the pin."""
    return '%s \u00b7 %g\u00b0' % (spec['label_base'], spec['detent'])


def detent_note(spec, G):
    """`params.shipped_detent_note`, built from the fan the head was actually printed with."""
    # State the REASON the shipped hole is where it is, not the edit that moved it: a package
    # is read by someone about to build it, who has never seen the previous one.
    det = sorted(float(t) for t in G.detents)
    step = round(det[1] - det[0], 6) if len(det) > 1 else 0.0
    rest = [p for p in spec['parts'] if p not in ('head', 'retainer')]
    return ('%g deg is one of the %d holes on the index fan the head was printed with '
            '(%g..%g deg in %g deg steps). It is shipped because %s. Moving the pin is not a '
            'reprint: only head.stl and retainer.stl turn about the hinge, and %s and every '
            'print/*.stl are untouched.'
            % (spec['detent'], len(det), det[0], det[-1], step, spec['detent_reason'],
               ', '.join('%s.stl' % r for r in rest)))


# ------------------------------------------------------------------ the gates sentence
# `params.gates_note` is BUILT FROM THIS SET'S OWN TABLE, never typed.  One hard-coded
# sentence for two different mounts is what put a drive-servo LED gate on a mast 538 mm above
# the ground and froze a detent list that the pupil model had already changed.
def arch_gates(pr, spec):
    """The wrist arch: `params.framing` read against `params.framing_gates`."""
    g = pr['framing_gates']
    lo = g['led_margin_deg_min']
    rows = sorted(pr['framing'].items(), key=lambda kv: float(kv[0]))
    ok, bad = [], []
    for k, r in rows:
        margins = [r['led_margin_deg']] + list(r['led_margin_deg_bracket'])
        pads = [abs(x) for x in list(r['uv_pad_closed']) + list(r['uv_pad_open40'])]
        passes = (min(margins) >= lo and r['servo_margin_deg'] >= g['servo_margin_deg_min']
                  and abs(r['v_grasp']) <= g['v_grasp_abs_max']
                  and max(pads) <= g['pad_uv_abs_max'])
        (ok if passes else bad).append((float(k), round(r['led_margin_deg'] - lo, 2)))
    detents = [t for t, _ in ok]
    return detents, (
        'Gates: the servo LED and the servo nose out of frame by at least %g deg at every '
        'pupil offset in the bracket, |v_grasp| <= %g, and both pads in frame closed and at '
        '40 mm open. At hFOV %.1f deg only %s pass, by %s deg of LED margin over the gate. '
        'The rest fail the LED gate: %s. %g deg is shipped as the steeper of the two that '
        'pass, so it keeps the most gripper-relative resolution.'
        % (lo, g['v_grasp_abs_max'], pr.get('hfov_deg', 87.3),
           ' and '.join('%g deg' % t for t, _ in ok),
           ' and '.join('%g' % m for _, m in ok),
           ', '.join('%g deg by %g deg' % (t, -m) for t, m in bad),
           spec['detent']))


def mast_gates(pr, spec):
    """The corner mast: `params.framing` (the pose sweep) read against its own gates."""
    g = pr['framing_gates']
    rows = sorted(pr['framing'].items(), key=lambda kv: float(kv[0]))
    ok, fail = [], []
    for k, r in rows:
        passes = (min(r['tip_floor_pct'], r['tip_table_pct']) >= g['tip_pct_min']
                  and r['robot_pct'] <= g['robot_pct_max']
                  and r['floor_pct'] >= g['floor_pct_min'] and r['table_pct'] > 0
                  and r['ground_far_mm'] >= g['context_mm_min'])
        (ok if passes else fail).append((float(k), r))
    shipped = dict(rows)['%g' % spec['detent']]
    prev = dict(rows).get('%g' % spec['prev_detent'])
    worst = ', '.join('%g deg fails the context gate at %.2f m'
                      % (t, r['ground_far_mm'] / 1000.0) for t, r in fail)
    return [t for t, _ in ok], (
        'Gates: at least %g %% of the tip poses in frame, at most %g %% of the frame on the '
        'robot, at least %g %% of the floor, the table visible, and at least %.1f m of context '
        'ahead. Every detent from %g to %g deg passes; %s. %g deg is shipped because it puts '
        'the least of the robot in frame (%.1f %% against %.1f %% at %g deg), starts the '
        'ground at the front wheels (Y %g mm) and still carries %.1f m of context.'
        % (g['tip_pct_min'], g['robot_pct_max'], g['floor_pct_min'],
           g['context_mm_min'] / 1000.0, ok[0][0], ok[-1][0], worst, spec['detent'],
           shipped['robot_pct'], prev['robot_pct'] if prev else float('nan'),
           spec['prev_detent'], shipped['ground_near_mm'],
           shipped['ground_far_mm'] / 1000.0))


def build_notes(meta, sid, spec, G, gen, cam, n, plate_stats, module):
    """Compose `notes` out of THIS run's objects: header + BOM + params + assembly pointer.

    Nothing here looks at the previous value, so the text cannot accumulate and cannot
    outlive the parts.  The measured numbers are the ones this run just measured.
    """
    plates = list(spec['plates'])
    beds = '; '.join(
        '`%s` %.1f x %.1f x %.1f mm, %.1f g' % (s, *plate_stats[s]['bed_mm'],
                                                plate_stats[s]['mass_g_pla'])
        for s in plates)
    meshes = ', '.join(sorted([s + '.stl' for s in spec['parts']] + ['df200.stl']))
    header = (
        '%s. Sensor (%.4f, %.4f, %.4f) at the shipped %g deg detent, optical axis '
        '(%.6f, %.6f, %.6f); hFOV %.1f / vFOV %.1f (JR DF200). %d plate%s, %.1f g of PLA, '
        'tallest %.1f mm in Z: %s. Robot-frame meshes drawn by the studio: %s.'
        % (meta.get('label', sid), cam[0], cam[1], cam[2], spec['detent'], n[0], n[1], n[2],
           meta['params'].get('hfov_deg', 87.3), meta['params'].get('vfov_deg', 71.1),
           len(plates), '' if len(plates) == 1 else 's',
           sum(plate_stats[s]['mass_g_pla'] for s in plates),
           max(plate_stats[s]['bed_mm'][2] for s in plates), beds, meshes))

    keys = list(gen['bom'])
    bom_p = ('Hardware beyond the printed plates - the %d line%s of `params.bom`, which the '
             'generator builds for THIS variant: %s.'
             % (len(keys), '' if len(keys) == 1 else 's', ', '.join('`%s`' % k for k in keys)))

    par_p = (
        'Design tilt %g deg, shipped detent %g deg. The index fan was printed with %d holes '
        '(%s deg) and the head and the retainer are those same meshes rotated about the hinge, '
        'so moving the index pin is NOT a reprint and every `print/*.stl` is unchanged by it - '
        '`params.shipped_detent_note` records why the shipped hole moved. `df200.stl` is the '
        'camera-module stand-in (36 x 36 x 11 body, O20 x 9 barrel, O13 x 3 hood, 9 x 5 x 4 '
        'connector, sensor 4 mm behind the front face) seated in the head pocket at that '
        'detent with its front face on the 3 mm lip, connector along the %s axis so it passes '
        'the retainer\'s 24 x 14 window. Measured on the meshes this run exported: module '
        '\u2229 head %.3f mm3, module \u2229 retainer %.3f mm3, connector \u2229 retainer '
        '%.3f mm3.'
        % (G.tilt, spec['detent'], len(G.detents),
           ', '.join('%g' % t for t in G.detents),
           AXIS_LABEL.get(module['axis'], module['axis']),
           module['head_mm3'], module['retainer_mm3'], module['conn_mm3']))

    ptr_p = ('Assembly order, the fastener-by-fastener driver-access cast and the cable '
             'routes are in `ASSEMBLY.md` beside this file; `DESIGN.md` is the design record '
             'and the alternatives this one was chosen against. Every measured number behind '
             'them is in this set\'s own `params` block.')

    return '\n\n'.join([header, DESIGN_STATE_COMMON, DESIGN_STATE[sid], bom_p, par_p, ptr_p])


def hinge_of(G, detent, frame):
    """The head's hinge: origin, and the axis a right-hand turn about which RAISES the tilt."""
    D = G.rot(detent + 5.0) @ np.linalg.inv(G.rot(detent))
    k = np.asarray(G.xd, float) / np.linalg.norm(G.xd)
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    a = math.radians(5.0)
    R = np.eye(3) + math.sin(a) * K + (1 - math.cos(a)) * (K @ K)
    axis = k if np.allclose(D[:3, :3], R, atol=1e-9) else -k
    return dict(frame=frame, origin=[float(v) for v in G.HINGE],
                axis=[float(v) + 0.0 for v in axis],
                positive='a right-hand turn about the axis raises the tilt')


def write_record(dst, sid, spec, G, gen, cam, n, M, plate_stats, module, part_volumes):
    """Rewrite the part's record.json from the objects that just built the geometry."""
    p = os.path.join(dst, 'record.json')
    meta = json.load(open(p))
    meta['print_files'] = ['print/%s_PRINT.stl' % s for s in spec['plates']]
    meta['hinge'] = hinge_of(G, spec['detent'], meta.get('frame', 'robot'))
    pr = meta.setdefault('params', {})
    pr['plates'] = list(spec['plates'])
    pr['plate_stats'] = plate_stats
    pr['bom'] = gen['bom']
    pr['generator'] = 'tools/cad/%s' % ('gen_corner_mast.py' if spec['gen'] == 'mast' else 'gen_wristcam_arch.py')
    pr['generator_design_tilt_deg'] = G.tilt
    pr['shipped_detent_deg'] = spec['detent']
    # the camera's own tilt and framing row follow the shipped detent
    pr['tilt_deg'] = float(spec['detent'])
    _row = (pr.get('framing') or {}).get('%g' % spec['detent'])
    if _row and 'sensor' in _row:          # the arch's framing table carries the sensor point
        pr['sensor_pincopen_mm'] = _row['sensor']
    # label and detent note are DERIVED from `spec['detent']`, never typed beside it
    meta['label'] = set_label(spec)
    pr['shipped_detent_note'] = detent_note(spec, G)
    pr['shared_plates'] = {
        'retainer': 'The shared "Camera retainer plate" print-only upgrade - the same solid as '
                    'this set\'s own retainer mesh to 0.005 mm (measured on the exported '
                    'meshes). Printed once, it serves every camera head this project builds: '
                    'the corner mast and the wrist arch.',
        'pocket_shims': 'The shared "Camera pocket shims" print-only upgrade - 36 x 36 mm at '
                        '0.4 / 0.8 / 1.6 mm, with the same 24 x 14 window. Stack them for 0.4 '
                        'to 2.8 mm in 0.4 mm steps.'}
    # The tilt index is the SAME feature on both sets - one hinge, one fan, one M3 x 8 pin into
    # a blind 3.0 mm seat - so it is written from the generator's own fan for both, with one
    # word for it.  (An M3 x 12 is the rev-1 pin: in the blind seat it would stand inside the
    # camera module.  `params.bom.index`, ASSEMBLY.md and DESIGN.md all say M3 x 8.)
    _det = sorted(float(t) for t in G.detents)
    pr['tilt_index'] = dict(
        kind='hinge detent fan',
        hinge='M3 x 60 through both cheeks (54.2 mm of stack)',
        pin='M3 x 8 into a BLIND 3.0 mm seat',
        rings_mm=[25.0, 33.0], hole_d_mm=3.2,
        step_deg=round(_det[1] - _det[0], 6) if len(_det) > 1 else 0.0,
        holes_deg=_det, min_hole_pitch_mm=4.363)
    if spec['gen'] == 'mast':
        # the joint plane, from the generator: every string in the set says "the Z 285 spigot"
        pr['split_z'] = float(G.split_z)
        _runs = gen.get('gusset_runs_mm') or {}
        _dir = {'0': '+X', '90': '+Y', '180': '-X', '270': '-Y'}
        pr['gusset'] = dict(
            runs_mm=_runs,
            note='two fins on the deck plate, running out from the spar foot: %s. There is no '
                 'collar - the spar\'s own foot is the gusset, and the deck bolts\' O7.5 '
                 'driver reliefs take the room the other two ways.'
                 % (', '.join('%s %.2f mm' % (_dir.get(k, k + ' deg'), v) for k, v in sorted(
                     _runs.items(), key=lambda kv: float(kv[0])) if v) or 'none'))
        pr['pan'] = ('FIXED at the design %g deg by the Z %g spigot section, which is a '
                     'chamfered rectangle and goes together two ways round only. There is no '
                     'pan ring and no screw that could give one. To change it, regenerate the '
                     'spar with a different `pan_deg`.'
                     % (pr.get('pan_deg', 10.0), pr.get('split_z', 285.0)))
        pr['cable_route'] = {
            'path': 'retainer 24 x 14 window -> the head\'s vertical duct -> the hollow '
                    'spar_upper -> the hollow spar_lower -> the +X cable slot at Z 85..101',
            'note': 'Thread it UP the spar from the +X cable slot BEFORE the Z %g spigot '
                    'closes the route, and leave a 60 mm service loop at the head.'
                    % pr.get('split_z', 285.0)}
        pr['detent_cam_mm'] = {'%g' % t: [round(float(v), 4) for v in G.cam_at(t)[0]]
                               for t in G.detents}
        _detents, pr['gates_note'] = mast_gates(pr, spec)
        pr['usable_detents_deg'] = _detents
    else:
        pr['framing'] = gen['framing']
        pr['framing_gates'] = gen['framing_gates']
        pr['usable_detents_df200_87deg'], pr['gates_note'] = arch_gates(pr, spec)
        # measured on the meshes this run exported, so the quoted masses cannot go stale
        pr['volume_cm3'] = part_volumes
        pr['pupil_model'] = ('margins are measured from the lens ENTRANCE PUPIL, 8.0 mm in '
                             'front of the sensor point (bracketed at 6 and 10 mm), not from '
                             'the sensor: the module\'s own barrel and hood stand 4-16 mm '
                             'proud of it. At the rev-1 40 deg detent the servo LED\'s margin '
                             'is -0.61 deg (+1.25 at +6 mm, -2.53 at +10), i.e. the LED is in '
                             'the frame; at 35 deg it is +6.66 (+8.50 / +4.78).')
        pr['mass_g_solid_pla'] = gen['mass_g_solid_pla']
        pr['connector_corridor'] = gen['connector_corridor']
        cid = list(meta['cameras'])[0]
        meta['cameras'][cid]['local'] = [float(v) for v in M.T.reshape(-1)]
        pr['sensor_pincopen_mm'] = [round(float(v), 4) for v in cam]
    meta['notes'] = build_notes(meta, sid, spec, G, gen, cam, n, plate_stats, module)
    meta = typography(meta)              # one spelling per unit, the same one make_robots uses
    write_json(p, meta)
    log('  record.json: %d plates, %d BOM lines, notes %d chars in %d paragraphs'
        % (len(spec['plates']), len(gen['bom']), len(meta['notes']),
           meta['notes'].count('\n\n') + 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default=None,
                    help='comma-separated set ids (default: every set)')
    ap.add_argument('--json', default=None, help='write the summary here')
    a = ap.parse_args()
    ids = [s.strip() for s in a.only.split(',')] if a.only else list(SETS)
    out = [build_set(i, SETS[i]) for i in ids]
    if a.json:
        write_json(a.json, out)
    log('\nNow run:  python3 tools/build/make_robots.py --only lekiwi-pincopen '
        '&& python3 tools/build/pack_assets.py')


if __name__ == '__main__':
    main()
