"""This project's own parts: assets/parts/<id>/part.json (`rps/part@1`) from the committed meshes.

The two camera mounts also read record.json, the evidence make_mounts.py writes from the
CadQuery build (label, camera pose, hinge, bolts).  Every number here is measured on a mesh
or read from that record; nothing is typed beside it.
"""
import json
import math
import os

import numpy as np

from packlib.atomic import write_json
from .cameras import tilt_of_local
from .checks import check_part, check_style, check_text, typography
from .paths import PARTS, rel
from .urdf import log

PART_SCHEMA = 'rps/part@1'
ROBOT = 'lekiwi-pincopen'

# The composition's default design: slot defaults, `default_design` and which part
# components start visible all read it.  One design per slot: latest, stock, none, import.
DEFAULT_DESIGN = {
    'top_camera_mount': 'corner_mast_printed',
    'wrist_camera_mount': 'df200_arch',
    'gripper': 'pincopen',
    'fingertips': 'original',
    'pi_case': 'vertical_revI',
    'front_camera': 'stock',
}

MAST = '#5b8fd6'
ARCH = '#46a08b'
RETAINER = '#7fb2e8'
MODULE = '#2b3138'

MODULE_NOTE = ('The JR DF200 module itself, as a volumetric stand-in: 36 x 36 x 11 body, '
               'O20 x 9 lens barrel, O13 x 3 hood, 9 x 5 x 4 rear connector, sensor 4 mm '
               'behind the front face. Seated in the pocket at the shipped detent, front face '
               'on the 3 mm lip, barrel through the 30 x 30 aperture. The connector is on the '
               'image-UP axis, so it passes the retainer\'s 24 x 14 window. Measured on the '
               'exported meshes: module n head 0.001 mm3, connector n retainer 0.000 mm3. The '
               'retainer boss presses the back face by 0.40 mm (206 mm3 - the clamp preload; a '
               '0.5 mm pocket shim goes behind a thinner module). NOT a printable part: it is '
               'what you buy.')
RET_NOTE = ('The 58 x 26 retainer plate with its 24 x 14 cable window, at its seated pose on '
            'the head\'s ears. NOT a plate of this set: print the shared "Camera retainer '
            'plate" upgrade instead. It is the same solid to 0.005 mm, measured on the '
            'exported meshes, and one of them serves every camera head this project builds. '
            '2x M3x12 self-tapping into O2.60 x 9.50 pilots, 8.0 mm of bite.')
HEAD_NOTE = ('The clamp block alone: 36.4 x 36.4 pocket, 3 mm lip, OPEN REAR, two ears. '
             'The tilt index seats are BLIND, 3.0 mm deep, and cut in BOTH side walls, which '
             'is what makes this ONE STL for the corner mast and the wrist arch. Prints lens '
             'face down on 975.8 mm2 of bed contact, 5.5 % overhang. Support the two hinge-lug '
             'ends - a 23.7 mm bridge.')


def _mount_meshes(pid, first, head_color):
    """The meshes every camera mount shares after its own frame part(s)."""
    return first + [
        dict(id='head', label='%s · camera head', color=head_color, note=HEAD_NOTE),
        dict(id='retainer', label='%s · camera retainer', color=RETAINER, note=RET_NOTE,
             print='part:cam_retainer'),
        dict(id='df200', label='%s · DF200 module (stand-in)', color=MODULE, note=MODULE_NOTE,
             hardware=True),
    ]


# id -> what a mesh table cannot measure: labels, colours and the notes a hover shows.
SPECS = {
    'corner_mast_printed': dict(
        slot='top_camera_mount', frame='robot', record=True, camera='top', short='Corner mast',
        mount=dict(interface='deck_grid', bolts='deck_bolts', face_mesh='spar_lower'),
        notes='Sensor 538 mm above ground on the rear-left corner, 45 deg nose-down and '
              'panned 10 deg, so the arm crosses the view instead of running down it. '
              'At the DF200\'s real 87.3 deg the whole reachable floor and table are in '
              'frame at every detent, so the detent is picked to keep the ROBOT out of '
              'frame. 45 deg puts 4.6 % of the frame on the robot, against 8.6 % at '
              '55 deg. Its near edge lands on the front wheels (Y 69 mm) and it still '
              'carries 3.2 m of context. No hardware store: a tapered PLA spar in two '
              'halves, pinned by 3x M3x8 at the Z 285 spigot, with no collar, no seat '
              'disc and no pinch clamp. 187 cm3 of spar. Tip deflection at 1 g is '
              '0.298 mm fore-aft and 0.259 mm lateral, first mode 34.4 Hz. The taller '
              'half is 248.0 mm tall, so it needs 250 mm of Z.',
        meshes=_mount_meshes('corner_mast_printed', [
            dict(id='spar_lower', label='Corner mast (printed) · lower spar + deck base', color=MAST,
                 note='The deck plate and the tapered hollow spar in one part, Z 57 to the Z 285 '
                      'spigot, with 3.5 mm walls. 4x M3x8 into M3 heat-set inserts in the deck grid, a '
                      'O7.5 x 26 driver relief above every bolt, and two gusset fins fore and aft where '
                      'the plate has room for them. 248.0 mm on the bed, so it needs 250 mm of Z: an '
                      'MK4 (220 mm) will not take it, an Ender 3 (250 mm) has 2.0 mm to spare.'),
            dict(id='spar_upper', label='Corner mast (printed) · upper spar + yoke', color=MAST,
                 note='Z 285 to the top of the index fan: the spar AND the yoke in one part. The '
                      'tapered section grows the two hinge cheeks, the M3x60 hinge (54.2 mm of stack) '
                      'and the 40..70 deg index fan directly - no collar, no seat disc, no clamp and no '
                      'joint under the cheeks. 229.6 mm on the bed, 90.0 g, 337 mm2 of bed contact.'),
        ], MAST)),
    'df200_arch': dict(
        slot='wrist_camera_mount', frame='attachment', record=True, camera='wrist',
        short='DF200 wrist arch',
        mount=dict(interface='camera_plate', bolts='seat_holes', face_mesh='arch'),
        notes='The DF200 on the wrist, ahead of the servo instead of behind it: the '
              'motor and its LED leave the frame by GEOMETRY, not by tilt. Two plates, '
              '42.0 g; 49.4 g with the shared retainer, against a 60 g budget. Tilt is a '
              'hinge detent, 30..60 deg in 5 deg steps. The framing model measures from '
              'the lens ENTRANCE PUPIL, 8 mm in front of the sensor point, not from the '
              'sensor. Shipped at 35 deg, where the servo LED clears the frame by '
              '6.66 deg; at 40 deg it is 0.61 deg inside it. Only 30 deg and 35 deg '
              'pass every gate.',
        meshes=_mount_meshes('df200_arch', [
            dict(id='arch', label='DF200 wrist arch · frame', color=ARCH,
                 note='Feet on the Z 19.50 seat and rails at |Y| 14.8..27.1, outboard of the servo. '
                      'TRUE 4 mm leg plates at |Y| 22.6..26.6, coplanar with the cheeks they feed: '
                      'rev 1 lofted them between planes 5.1 mm apart while the profile climbed 51 mm, '
                      'so the web measured 0.54-0.84 mm perpendicular. A 45 deg humped crossbar over '
                      'the servo\'s connectors, the zip-tie lug and the 30..60 deg index fan. Prints '
                      'UPRIGHT on its own two seat rails: 398.5 mm2 of bed contact against rev 1\'s '
                      '0.0, and 12.5 % overhang. Support the two cheek undersides, the fan\'s lower '
                      'edge and the crown hump.'),
        ], ARCH)),
    'pi_case_vertical': dict(
        slot='pi_case', frame='robot', label='Vertical rev I (as printed)',
        mount=dict(interface='deck_grid', face_mesh='cradle'),
        notes='The case on the robot today: dual-fan ARMOUR cooler, 97 mm tall, drop-in rear panel.',
        meshes=[
            dict(id='cradle', component='pi_case_cradle', label='Vertical Pi case - cradle',
                 color=MAST, note='Rev-I vertical Raspberry Pi 5 case, cradle body, in the rear deck pocket.'),
            dict(id='panel', component='pi_case_panel', label='Vertical Pi case - front panel',
                 color=MAST, note='Rev-I vertical Pi case, drop-in front panel.'),
        ]),
    # print-only kit plates: shared by both camera heads, drawn nowhere
    'cam_retainer': dict(
        slot=None, frame='robot', label='Camera retainer plate',
        meshes=[dict(id='plate', print_file='camera_retainer_PRINT.stl', color=RETAINER, note=(
            'The 58 x 26 retainer plate with its 24 x 14 cable window that clamps the DF200 into a '
            'camera head, print only. ONE plate serves every head this project builds: the corner '
            'mast and the DF200 wrist arch both draw their own retainer, and both name this one - '
            'the same solid to 0.005 mm, measured on the exported meshes. 2x M3x12 self-tapping '
            'into O2.60 x 9.50 pilots, 8.0 mm of bite.'))]),
    'camera_shims': dict(
        slot=None, frame='robot', label='Camera pocket shims',
        meshes=[dict(id='plate', print_file='camera_shims_PRINT.stl', color=RETAINER, note=(
            'Depth shims behind the module, print only: 36 x 36 mm at 0.4 / 0.8 / 1.6 mm with the '
            'same 24 x 14 window. They stack to 2.8 mm in 0.4 mm steps, so a 9.5 or 10 mm camera '
            'still clamps solid in the 11.3 mm pocket. Shared by the corner mast and the wrist '
            'arch. Three shims on one plate, which is why the print check WARNs "3 bodies".'))]),
}


def plate_export_name(pid, plate):
    """The name a part's plate is exported under: `<part>_<plate>`, unique across parts."""
    base = os.path.basename(plate)
    return base if base.startswith(pid + '_') else '%s_%s' % (pid, base)


def _volume(path):
    import trimesh
    m = trimesh.load(path, process=True)
    m.merge_vertices()
    return round(abs(float(m.volume)) / 1000.0, 3)


def _face(path):
    """The mount face: the plane of the mesh's lowest vertices, and their centroid."""
    import trimesh
    v = np.asarray(trimesh.load(path, process=False).vertices, float)
    z0 = v[:, 2].min()
    low = v[np.abs(v[:, 2] - z0) < 1e-6]
    c = low.mean(0)
    return {'point': [round(float(c[0]), 4), round(float(c[1]), 4), round(float(z0), 4)],
            'normal': [0, 0, -1]}


def _rot(axis, deg):
    k = np.asarray(axis, float) / np.linalg.norm(axis)
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    a = math.radians(deg)
    return np.eye(3) + math.sin(a) * K + (1 - math.cos(a)) * (K @ K)


def _hinge(pid, rec, spec, cam):
    """params.tilt_deg: the head's rigid turn about the hinge, checked against the record."""
    p, h = rec['params'], rec['hinge']
    shipped = float(p['shipped_detent_deg'])
    values = [float(t) for t in p['tilt_index']['holes_deg']]
    usable = p.get('usable_detents_deg') or p.get('usable_detents_df200_87deg')
    # every detent the record measured must be this rotation of the shipped sensor point
    o = np.asarray(h['origin'], float)
    s0 = np.asarray(cam['local'][12:15], float)
    want = {float(k): v for k, v in (p.get('detent_cam_mm') or {}).items()}
    for k, row in (p.get('framing') or {}).items():
        if isinstance(row, dict) and 'sensor' in row:
            want[float(k)] = row['sensor']
    for t, pt in want.items():
        got = _rot(h['axis'], t - shipped) @ (s0 - o) + o
        err = float(np.abs(got - np.asarray(pt, float)).max())
        if err > 1e-3:
            raise SystemExit('%s: the hinge turns the sensor to %s at %g deg, the record says %s '
                             '(%.4f mm off)' % (pid, got.round(4).tolist(), t, pt, err))
    return {'kind': 'hinge', 'value': shipped, 'values': values,
            'usable': [min(usable), max(usable)], 'origin': h['origin'], 'axis': h['axis'],
            'design': shipped, 'moves': ['head', 'retainer', 'df200'], 'camera': spec['camera']}


def build_part(pid):
    """Write assets/parts/<pid>/part.json and return it."""
    spec = SPECS[pid]
    d = os.path.join(PARTS, pid)
    rec = json.load(open(os.path.join(d, 'record.json'))) if spec.get('record') else None
    label = spec.get('label')
    cameras = None
    params = None
    if rec:
        label = rec['label']
        det = rec['params']['shipped_detent_deg']
        if not label.endswith('· %g°' % det):
            raise SystemExit('%s: label %r does not carry the shipped detent %r - both come from '
                             'make_mounts.py; re-run it' % (pid, label, det))
        cameras = {cid: (b if b is None else dict(b, tilt_deg=tilt_of_local(b['local'])))
                   for cid, b in rec['cameras'].items()}
    meshes = []
    for m in spec['meshes']:
        e = {'id': m['id']}
        if m.get('component'):
            e['component'] = m['component']
        e['label'] = m.get('label', label).replace('%s', spec.get('short', ''))
        stem = m.get('component') or m['id']
        if not m.get('print_file'):
            e['file'] = 'mesh/%s.stl' % stem
        pr = m.get('print') or ('print/' + m['print_file'] if m.get('print_file') else None)
        if pr is None and not m.get('hardware') and os.path.exists(os.path.join(d, 'print', stem + '_PRINT.stl')):
            pr = 'print/%s_PRINT.stl' % stem
        if pr:
            e['print'] = pr
            if spec.get('record') and not pr.startswith('part:'):
                e['print_name'] = plate_export_name(pid, pr)
        if m.get('hardware'):
            e['hardware'] = True
        e['color'] = m['color']
        src = e.get('file') or e.get('print')
        e['volume_cm3'] = _volume(os.path.join(d, src))
        e['note'] = m['note']
        meshes.append(e)
    doc = {'schema': PART_SCHEMA, 'id': pid, 'label': label, 'robot': ROBOT, 'slot': spec['slot'],
           'frame': spec['frame'], 'local': None, 'meshes': meshes, 'cameras': cameras}
    mt = spec.get('mount')
    if mt:
        byid = {x['id']: x for x in meshes}
        mount = {'interface': mt['interface']}
        if mt.get('bolts'):
            mount['bolts_mm'] = rec['params'][mt['bolts']]
        mount['face'] = _face(os.path.join(d, byid[mt['face_mesh']]['file']))
        doc['mount'] = mount
    else:
        doc['mount'] = None
    if rec:
        params = {'tilt_deg': _hinge(pid, rec, spec, cameras[spec['camera']])}
    doc['params'] = params
    doc['source'] = 'this project'
    if spec.get('notes'):
        doc['notes'] = spec['notes']
    docs = [f for f in ('ASSEMBLY.md', 'DESIGN.md') if os.path.exists(os.path.join(d, f))]
    if docs:
        doc['docs'] = docs
    doc = typography(doc)
    where = rel(os.path.join(d, 'part.json'))
    check_style(doc, where)
    check_part(doc, d, where)
    write_json(os.path.join(d, 'part.json'), check_text(doc, where))
    return doc


def build_parts(only=None):
    """Write every part.json; return {id: part}."""
    out = {}
    for pid in SPECS:
        if only and pid not in only:
            continue
        out[pid] = build_part(pid)
    log('wrote %d part.json under %s' % (len(out), rel(PARTS)))
    return out
