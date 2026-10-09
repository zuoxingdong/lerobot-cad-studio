"""assets/robots/pincopen/robot.json, from the registration in tools/build/inputs/pincopen_registration.json."""
import json
import math
import os

import numpy as np

from packlib.atomic import write_json
from .checks import (check_camera_slots, check_print_names, check_slot_groups,
                     check_slot_rules, check_style, check_text, note_unstated_plates,
                     typography)
from .paths import FETCHED, PINCOPEN_COMMIT, REG_JSON, ROBOTS
from .pincopen_kinematics import (COUPLER_PARTS, GROUND_PARTS, ROTATING_LINKS,
                                  dedupe_instances, fk_zero_links, linkage_from_hinges,
                                  sts3215_drive)
from .urdf import cm, log, mat, rpy_mat

def build_pincopen():
    """Build the pincopen manifest (doc, registration) from the registration JSON."""
    if not os.path.exists(REG_JSON):
        log('!! %s missing - it is the committed registration result' % REG_JSON)
        return None
    reg = json.load(open(REG_JSON))
    reg['instances'] = dedupe_instances(reg['instances'])
    pkg = os.path.join(ROBOTS, 'pincopen')

    FINGER_PARTS = {'Distal_Shell', 'Tip_Support', 'Removable_Tip', 'Distal_Rod',
                    'External_Rod', 'Internal_Rod'}
    GROUP = {'Top_Plate': 'body', 'Bottom_Plate': 'body', 'Motor_Flange': 'body',
             'Interface_ARM100': 'body', 'Driving_Rod': 'linkage',
             'Internal_Rod': 'linkage', 'External_Rod': 'linkage', 'Distal_Rod': 'linkage',
             'Distal_Shell': 'finger', 'Tip_Support': 'fingertip', 'Removable_Tip': 'fingertip',
             # `Cam` is NOT a camera - the name heuristic filed it there and the tree showed
             # it under CAMERAS.  It is the four-bar CAM DISC (32 x 32 x 6.85 mm, Z -2.70..
             # 4.15, sandwiched between the two plates), bolted to the STS3215 horn: it is
             # part of the gripper drive, and it goes where the gripper goes.
             'Cam': 'gripper', 'Camera_basement': 'camera', 'Camera_mobile_sup': 'camera'}
    COLOR = {'body': '#8a949f', 'gripper': '#8a949f', 'linkage': '#6f7a86', 'finger': '#9aa4af',
             'fingertip': '#d08a3c', 'camera': '#2b3138'}

    # hinge geometry from the pincopen_mods notes, verified by point-containment against the meshes
    hinges = [[34.64, -12.50], [34.64, -24.00], [0.0, -32.50], [0.0, -44.00]]
    kin = linkage_from_hinges(hinges)
    FKZ = fk_zero_links(kin)                              # link -> 4x4 at the zero pose, mm
    JOINT_OF_LINK = {j['child']: j['name'] for j in kin['joints']}
    # which LINK each registered body rides.  The two bars of a side turn about their own
    # ground pivots; the coupler parts ride the finger.  Everything else is the fixed body.
    LINK_OF_PART = {
        'Internal_Rod': {'y_neg': 'rod_L', 'y_pos': 'rod_R'},
        'External_Rod': {'y_neg': 'rod2_L', 'y_pos': 'rod2_R'},
    }
    for part in COUPLER_PARTS:
        LINK_OF_PART[part] = {'y_neg': 'finger_L', 'y_pos': 'finger_R'}

    components, residuals = [], []
    for inst in reg['instances']:
        pid, n = inst['part'], inst['instance']
        g = GROUP.get(pid, 'body')
        cid = pid.lower() if n == 0 else '%s_%d' % (pid.lower(), n + 1)
        side = None
        cy = inst['body_centroid'][1]
        if pid in FINGER_PARTS or abs(cy) > 1.0:
            side = 'y_neg' if cy < 0 else 'y_pos'
        # a moving body is expressed in ITS OWN link frame, so FK(link) @ local reproduces the
        # registered placement exactly at the zero pose and moves it correctly at every other
        link = LINK_OF_PART.get(pid, {}).get(side)
        if link:
            local = cm(np.linalg.inv(FKZ[link]) @ np.asarray(inst['matrix'], float).reshape(4, 4).T)
        else:
            local = inst['matrix']
        components.append(dict(
            id=cid, label=(pid.replace('_', ' ') + ('' if n == 0 else ' (%s)' % ('mirrored' if side == 'y_pos' else 'second'))),
            part=pid, instance=n, mesh='meshes/%s.stl' % pid,
            group=g,
            frame=('link' if link else 'robot'),
            link=link,
            local=local, mirrored=inst['mirrored'], side=side,
            color=COLOR.get(g, '#8a949f'), printable=True, print_file='meshes/%s.stl' % pid,
            moves_with=JOINT_OF_LINK.get(link),
            linkage_role=('coupler' if pid in COUPLER_PARTS
                          else 'rotating_link' if pid in ROTATING_LINKS
                          else 'ground' if pid in GROUND_PARTS
                          else 'mounted'),
            registration=dict(assembly=inst['assembly'], quality=inst.get('assembly_quality', 'full'),
                              body=inst['body'], rms_mm=inst['residual_rms_mm'],
                              max_mm=inst['residual_max_mm'],
                              extent_delta_mm=inst.get('extent_delta_mm'),
                              exact=bool(inst['residual_rms_mm'] <= 0.02),
                              uncertain=bool(inst['residual_rms_mm'] > 0.1),
                              note=(None if inst['residual_rms_mm'] <= 0.02 else
                                    ('bounding box matches to %.3f mm and the placement is right, but '
                                     'the in-place body is not byte-identical to the original: the CSG '
                                     'rebuild that produced the assembly changed the surface locally '
                                     '(worst %.2f mm). Treat the pose as sound and the surface as the '
                                     'original STL, which is what is actually shipped.'
                                     % (inst.get('extent_delta_mm', 0.0), inst['residual_max_mm'])))),
        ))
        residuals.append((cid, inst['residual_rms_mm'], inst['residual_max_mm']))

    placed_parts = sorted({c['part'] for c in components})
    missing = [p for p in reg['sources'] if p not in placed_parts]

    components.append(sts3215_drive())

    doc = {
        'schema': 'rps/robot@1',
        'id': 'pincopen',
        'name': 'PincOpen',
        'description': 'Pollen Robotics PincOpen - a printable parallel gripper for the SO-101 wrist, '
                       'with a camera seat on the top plate.',
        'version': PINCOPEN_COMMIT[:7],
        'source': {'repo': 'https://github.com/pollen-robotics/PincOpen', 'commit': PINCOPEN_COMMIT,
                   'license': 'CC-BY-SA-4.0', 'fetched': FETCHED,
                   'files': 'meshes/ = cad/stl, all 14 originals, copied verbatim - see SOURCE.md'},
        'units': 'mm',
        'up': 'z',
        'kind': 'attachment',
        'frame': {
            'notes': 'PincOpen assembly frame, mm: Y = 0 is the jaw mirror plane, +X is the fingertip '
                     'direction (nose at X = 70.64), Z is the finger width axis (+-12.86). '
                     'Mounts on a host robot at its wrist flange; the host supplies the placement.',
            'mount_face_x': -53.492,
            'mount_note': 'the back face of the assembly (X min) seats on the wrist-roll output flange',
        },
        'derivation': {
            'method': 'registration',
            'what': 'PincOpen ships 14 loose STLs and no assembly information, so each '
                    'original was registered against the connected bodies of the in-place '
                    'assemblies below. Those assemblies are built from these same files by '
                    'mesh CSG in the assembly frame. Parts are matched by sorted bounding-box '
                    'extents, not by volume: several upstream STLs report a wrong mesh volume. '
                    'The pose is then solved by ICP - iterative closest point, the standard '
                    'rigid fit of one point set onto another - seeded from all 48 signed '
                    'principal-axis permutations, and a rigid fit is preferred over a '
                    'reflected one. The residual is the point-to-surface distance of 4000 '
                    'surface samples.',
            'raw': 'tools/build/inputs/pincopen_registration.json',
            'assemblies': reg['assemblies'],
            'unmatched_bodies': reg.get('unmatched_bodies', []),
            'residual_rms_mm_max': round(max(r[1] for r in residuals), 5) if residuals else None,
            'residual_max_mm_max': round(max(r[2] for r in residuals), 5) if residuals else None,
            'exact_instances': sum(1 for r in residuals if r[1] <= 0.02),
            'uncertain_instances': [r[0] for r in residuals if r[1] > 0.1],
            'residual_note': 'A residual is the distance from the ORIGINAL mesh, placed by the solved '
                             'transform, to the surface of the assembled body. Zero means the body is '
                             'that part, exactly, there. The non-zero ones are local surface '
                             'differences introduced by the CSG rebuild that produced the in-place '
                             'assembly, not pose error: every one of them has a bounding box that '
                             'matches the original to 0.000 mm.',
            'not_placed': missing,
            'not_placed_note': 'These parts do not appear in either in-place assembly, so no placement '
                               'could be derived; they are listed under `spares` with their own CAD frame.',
        },
        'components': components,
        'cameras': [],
        'cameras_note': 'The upstream Cam.stl is placed by this package, but PincOpen publishes no '
                        'sensor or lens for it, so no hFOV is claimed here. The camera a host robot '
                        'actually mounts on frames.camera_plate is declared by that host - see '
                        'the lekiwi-pincopen package, cameras.wrist.',
        'spares': [{'id': p.lower(), 'label': p.replace('_', ' '), 'mesh': 'meshes/%s.stl' % p,
                    'frame': 'mesh', 'local': None, 'printable': True,
                    'note': 'not present in the in-place assemblies - placement unknown'} for p in missing],
        'kinematics': kin,
        'slots': {
            'fingertips': {
                'label': 'Fingertips',
                'hint': 'The tip support that bolts to each finger on the 3x M2 pattern '
                        '(X 51.64 +-3.5 and X 61.64, blind from the Y = -7.75 face).',
                'anchor': 'fingertip_pad', 'default': 'original', 'mirrored': True,
                'covers': ['tip_support', 'tip_support_2', 'removable_tip', 'removable_tip_2'],
                'interface': {
                    'holes_mm': [[51.64, 3.50], [51.64, -3.50], [61.64, 0.0]],
                    'holes_axes': 'X, Z in the assembly frame; blind into the finger from the Y = -7.75 face',
                    'screw': 'M2 self-tapping (d2.05 pilot), or M2 heat-set inserts with the E mod (d3.00)',
                    'contact_face': 'Y = 0', 'contact_area_mm2': 57.8,
                },
                'options': [
                    {'id': 'original', 'label': 'Original Tip_Support + Removable_Tip',
                     'kind': 'components', 'show': ['tip_support', 'tip_support_2',
                                                    'removable_tip', 'removable_tip_2']},
                    # every slot carries an empty option, so "Remove" has somewhere to go
                    {'id': 'none', 'label': 'No fingertips (bare fingers)', 'kind': 'none'},
                    {'id': 'import', 'label': 'Import alternative STL...', 'kind': 'import',
                     'mount': 'fingertip_pad'},
                ]},
        },
        'frames': {
            'fingertip_pad': {'origin': [61.64, 0.0, 0.0], 'axes': 'assembly frame',
                              'note': 'centre of the 3x M2 tip pattern on the -Y finger; mirror in Y for the +Y finger'},
            'camera_plate': {
                'seat_z': 19.50,
                'hole_pattern_mm': [15.00, 37.82],
                'holes': [[-41.27, 18.91], [-41.27, -18.91], [-26.27, 18.91], [-26.27, -18.91]],
                'holes_axes': 'X, Y in the assembly frame, at Z = 19.50 (the Top_Plate camera face)',
                'note': 'The camera face on top of the gripper: four M2 holes at Z 19.50 on '
                        'two 9 mm rails at Y 12.41..21.41. It carries the upstream camera '
                        'stack, or whatever mount the host robot bolts there. Measured on '
                        'these meshes.',
            },
        },
        'generated_by': 'tools/build/make_robots.py',
    }
    return doc, reg


def fk_pose_mm(kin, q_deg):
    """link -> 4x4 (mm) at an arbitrary pose, mimic joints resolved."""
    # Mirrors core/robot-model.js, so the generator can measure the posed meshes itself.
    js = {j['name']: j for j in kin['joints']}

    def value(name, guard=0):
        j = js[name]
        if not j.get('mimic') or guard > 8:
            return float(q_deg.get(name, 0.0))
        m = j['mimic']
        return value(m['joint'], guard + 1) * float(m.get('multiplier', 1.0)) + float(m.get('offset', 0.0))

    pose = {kin['root_link']: np.eye(4)}
    for _ in range(len(js) + 2):
        for j in kin['joints']:
            if j['parent'] in pose and j['child'] not in pose:
                M = mat(j['xyz'], rpy_mat(*j.get('rpy', [0, 0, 0])))
                q = math.radians(value(j['name'])) if j['type'] in ('revolute', 'continuous') else 0.0
                ax = np.asarray(j['axis'], float)
                ax = ax / (np.linalg.norm(ax) or 1.0)
                if j['type'] == 'prismatic':
                    R = np.eye(4)
                    R[:3, 3] = ax * float(value(j['name']))
                else:
                    c, sn = math.cos(q), math.sin(q)
                    K = np.array([[0, -ax[2], ax[1]], [ax[2], 0, -ax[0]], [-ax[1], ax[0], 0]])
                    R = np.eye(4)
                    R[:3, :3] = np.eye(3) + sn * K + (1 - c) * (K @ K)
                pose[j['child']] = pose[j['parent']] @ M @ R
    return pose


def world_of(comp, pose):
    """The component's world matrix (mm) at `pose`; `local` is in its link frame."""
    local = np.asarray(comp['local'], float).reshape(4, 4).T
    if comp.get('frame') == 'link' and comp.get('link'):
        return pose[comp['link']] @ local
    return local


def measure_jaw_stroke(doc, reg):
    """Cross-check the derived linkage against the meshes, and record what was measured."""
    # How far apart the two registered Tip_Support bodies are in the exported state (~0, fully
    # closed), where the fingertip nose sits, that the posed meshes reproduce
    # linkage.gap_formula, and that every bar stays on its finger pivot.
    import trimesh
    pkg = os.path.join(ROBOTS, 'pincopen')
    kin = doc['kinematics']
    inst = [c for c in doc['components'] if c['part'] == 'Tip_Support']
    if len(inst) != 2:
        return doc
    raw = {c['id']: trimesh.load(os.path.join(pkg, c['mesh'])) for c in inst}

    def tip_gap(q):
        pose = fk_pose_mm(kin, {'jaw': q})
        ms = []
        for c in inst:
            m = raw[c['id']].copy()
            m.apply_transform(world_of(c, pose))
            ms.append(m)
        ms.sort(key=lambda m: m.centroid[1])               # [-Y finger, +Y finger]
        return float(ms[1].bounds[0][1] - ms[0].bounds[1][1]), ms

    gap, tips = tip_gap(0.0)
    nose_x = max(float(t.bounds[1][0]) for t in tips)
    L = kin['linkage']['link_length_mm']
    th0 = math.radians(kin['linkage']['closed_crank_deg'])
    checks, worst = [], 0.0
    for q in (0.0, 10.0, 20.0, kin['linkage']['closed_crank_deg']):
        want = 2 * L * (math.sin(th0) - math.sin(th0 - math.radians(q)))
        got, _ = tip_gap(q)
        checks.append({'jaw_deg': round(q, 4), 'formula_mm': round(want, 4),
                       'measured_mm': round(got - gap, 4)})
        worst = max(worst, abs((got - gap) - want))
    # every bar's distal pivot must stay on the finger pivot it drives.  `zero[link]^-1 @ p`
    # puts a world point of the zero pose into the link frame; `pose[link] @` carries it.
    zero = fk_zero_links(kin)
    inv0 = {k: np.linalg.inv(v) for k, v in zero.items()}
    pivot_worst = 0.0
    for q in (0.0, 10.0, 20.0, kin['linkage']['closed_crank_deg']):
        pose = fk_pose_mm(kin, {'jaw': q})
        for bar in kin['linkage']['bars']:
            for tag, m in (('L', +1.0), ('R', -1.0)):
                rodL, finL = bar['link_%s' % tag], 'finger_%s' % tag
                c = np.array([bar['coupler_xy'][0], bar['coupler_xy'][1] * m, 0.0, 1.0])
                rod = pose[rodL] @ inv0[rodL] @ c
                fin = pose[finL] @ inv0[finL] @ c
                pivot_worst = max(pivot_worst, float(np.linalg.norm(rod[:3] - fin[:3])))
    st = kin['stroke_mm']
    st['closed_gap_mm'] = round(gap, 3)
    st['nose_x_mm'] = round(nose_x, 3)
    st['closed_gap_note'] = ('measured between the two registered Tip_Support meshes along Y. '
                             'The exported state is fully closed, so this is the manufacturing '
                             'clearance at the contact face, not a design gap.')
    st['verified'] = {
        'meshes_vs_formula': checks,
        'meshes_vs_formula_max_mm': round(worst, 4),
        'bar_pivot_to_finger_pivot_max_mm': round(pivot_worst, 6),
        'how': 'the two Tip_Support meshes were posed through the chain at each jaw angle and '
               'measured along Y; the bar check transports each bar\'s distal pivot through '
               'FK(bar link) and the same point through FK(finger link) and compares them.',
    }
    log('   jaw stroke: closed %.3f mm, formula vs meshes %.4f mm, bar pivots %.6f mm'
        % (gap, worst, pivot_worst))
    if worst > 0.05 or pivot_worst > 1e-6:
        raise SystemExit('linkage: the generated chain does not reproduce the four-bar - '
                         'meshes vs formula %.4f mm, bar pivot vs finger pivot %.6f mm'
                         % (worst, pivot_worst))
    del tips, raw
    return doc


def write_pincopen():
    """Write assets/robots/pincopen/robot.json and return the manifest."""
    got = build_pincopen()
    if not got:
        return None
    doc, reg = got
    doc = measure_jaw_stroke(doc, reg)
    pkg = os.path.join(ROBOTS, 'pincopen')
    doc = typography(doc)                        # one spelling per unit, everywhere
    check_camera_slots(doc, 'assets/robots/pincopen/robot.json')
    check_slot_rules(doc, 'assets/robots/pincopen/robot.json')
    note_unstated_plates(doc)
    check_slot_groups(doc, 'assets/robots/pincopen/robot.json')
    check_print_names(doc, 'assets/robots/pincopen/robot.json')
    check_style(doc, 'assets/robots/pincopen/robot.json')
    write_json(os.path.join(pkg, 'robot.json'), check_text(doc, 'assets/robots/pincopen/robot.json'))

    log('wrote assets/robots/pincopen/robot.json  (%d component instances, %d spares)'
        % (len(doc['components']), len(doc['spares'])))
    return doc
