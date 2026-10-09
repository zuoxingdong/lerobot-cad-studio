"""assets/robots/lekiwi/robot.json: the stock robot, out of its URDF and the v3 profile."""
import os

from packlib.atomic import write_json
from .cameras import df200_cam, stock_camera_blocks
from .checks import (check_camera_slots, check_print_names, check_slot_groups,
                     check_slot_rules, check_style, check_text, fix_text, note_unstated_plates,
                     typography)
from .labels import color_of, group_of, label_for
from .paths import FETCHED, LEKIWI_COMMIT, PROF, ROBOTS, STUDIO
from .printmatch import match_print_files
from .urdf import PRESETS_SOURCE, arm_presets, cm, fk_zero, log, parse_urdf


# The sim's mass band (tools/sim/verify.py). Upstream publishes no weight, so the estimate is
# summed from vendor figures; the band is that sum ±15 %.
STOCK_MASS = {
    'estimate_kg': 2.45,
    'band_kg': [2.1, 2.8],
    'source': 'Upstream publishes no weight. Seeed Studio LeKiwi Kit 12 V (base, printed parts, '
              'battery, no Pi, no cameras, no arm) is listed at 1.7 kg. Add the Raspberry Pi 5 '
              'with its cooler (0.06 kg), two USB cameras (0.02 kg), the six arm STS3215 servos '
              'at 55 g each (Feetech, 0.33 kg) and the printed SO-101 arm parts by the sim\'s '
              'volume rule (0.34 kg). The band is that 2.45 kg ±15 %.',
}


def build_lekiwi():
    """Write assets/robots/lekiwi/robot.json and return the manifest."""
    pkg = os.path.join(ROBOTS, 'lekiwi')
    urdf = os.path.join(pkg, 'urdf', 'LeKiwi.urdf')
    joints, vis = parse_urdf(urdf)
    root_link = PROF['root_link']
    pose = fk_zero(joints, root_link)
    links = [l for l in vis if l in pose]
    links.sort(key=lambda l: (group_of(l), l))
    pm = match_print_files(os.path.join(pkg, 'meshes'), os.path.join(pkg, 'print'), links, vis)

    components = []
    for link in links:
        g = group_of(link)
        v = vis[link]
        local = v['M'].copy()
        local[:3, 3] *= 1000.0                      # URDF metres -> mm, mesh already in mm
        p = pm.get(link)
        label, group = label_for(link, g)
        c = dict(
            id=link, label=label, link=link, mesh='meshes/' + v['file'],
            group=group, frame='mesh', local=cm(local), color=color_of(link, g),
            printable=bool(p), print_file=('print/' + p['file'] if p else None),
            print_file_match=(dict(p, how='matched to the upstream 3DPrintMeshes file with the same '
                                           'mesh volume (<=0.5 %) and the same bounding box '
                                           '(<=0.5 mm); a small volume delta means the print file '
                                           'carries a feature the URDF visual does not') if p else None),
            stock_removed=(link in set(PROF.get('removed_stock_links', []))),
        )
        # the pose the upstream plate is written in, proved against the plate's own surface
        if p and p.get('print_transform'):
            c['print_transform'] = p['print_transform']
            c['print_fit_worst_mm'] = p['print_fit_worst_mm']
            c['print_fit_rmse_mm'] = p['print_fit_rmse_mm']
            c['print_bbox_mm'] = p['print_bbox_mm']
        components.append(c)

    # joints: the URDF's own data plus the sourced degree limits
    jout = []
    for j in joints:
        jout.append(dict(name=j['name'], type=j['type'], parent=j['parent'], child=j['child'],
                         xyz=[round(x, 9) for x in j['xyz']], rpy=[round(x, 9) for x in j['rpy']],
                         axis=([round(x, 9) for x in j['axis']] if j['axis'] else None),
                         lower=j['lower'], upper=j['upper']))

    wm = PROF['frames']['wrist_mount']
    frames = {
        'ground': {'z': PROF['ground_z'], 'note': 'wheel contact plane, robot mm'},
        # hole_d MEASURED on meshes/base_plate_layer2-v3.stl at the deck's own Z (the plate runs
        # Z 50..57): every grid hole is a tessellated O3.50 circle - 3.500 mm across its widest
        # vertices, 3.441 mm of area-equivalent diameter.  The v3 profile's 3.25 was a guess and
        # the mast's heat-set procedure (open to O4.0 for an M3 x 5.7 insert with an O4.6 knurl)
        # is built on 3.50, so the package now states the measurement.
        'deck_grid': dict(PROF['frames']['deck_grid'], hole_d=3.50,
                          note='top deck plate bolt grid: 20 mm pitch, Z 57, usable radius 107, '
                               'hole O3.50 (M3 clearance), measured on the deck mesh'),
        'pan_axis': PROF['frames']['pan_axis'],
        'reach_disc': PROF['frames']['reach_disc'],
        'wrist_flange': {
            'link': wm['parent_link'],
            'local': wm['local'],
            'matrix_at_zero': wm['matrix'],
            'axes': '+X = the arm_wrist_roll axis (finger direction), +Z = -arm_gripper hinge axis, +Y = Z x X',
            'derived': wm['derive'],
            'note': fix_text(wm['note']),
        },
    }

    # The stock wrist camera is the SAME mesh as the front one, instanced on
    # Wrist-Camera-Mount-v11, so the camera-in-link transform is recovered from the front
    # camera's published local and re-applied to the wrist link's own visual origin.
    front = PROF['cameras']['front']
    stock_cams = stock_camera_blocks(vis, pose, front)
    # The device tooltip gets ONE sentence; the frame derivation the note used to carry is a
    # reference text, so it moves to its own key where nothing renders it as a hover.
    front_pose_note = fix_text(front['pose']['note'])

    # The package-level camera is the DEVICE, not the mount: lens, intrinsics, name,
    # provenance.  `slots.<id>.options[*].cameras.<cam>` is the ONLY source of a mount pose.
    cameras = [
        dict({'id': 'front', 'label': 'Front', 'name': 'Front (navigation)', 'group': 'camera',
              'hfov_range': front['hfov_range'],
              'aspect': PROF['cameras']['aspect'], 'near': front['near'], 'far': front['far'],
              'posed_by': 'slots.front_camera',
              'note': 'DEVICE ONLY - this entry is the camera, not a mount. The fitted front '
                      'camera option publishes the pose: the stock bracket carries the URDF '
                      'datum, and removing it switches the camera off.',
              'pose_derivation': front_pose_note},
             **df200_cam(front['hfov_alternatives'])),
        dict({'id': 'wrist', 'label': 'Wrist', 'name': 'Wrist (stock SO-101 mount)',
              'group': 'camera', 'mount_frame': 'wrist_flange',
              'hfov_range': front['hfov_range'],
              'aspect': PROF['cameras']['aspect'], 'near': 14, 'far': front['far'],
              'posed_by': 'slots.wrist_camera_mount',
              'note': 'DEVICE ONLY - this entry is the camera, not a mount. The fitted wrist '
                      'camera mount publishes the pose. The URDF instances the same camera '
                      'mesh here as on the front bracket, so it is the same module and the '
                      'same lens. The LeKiwi + PincOpen package replaces this mount with the '
                      'DF200 wrist arch on the PincOpen camera face.'},
             **df200_cam(front['hfov_alternatives'])),
    ]

    slots = lekiwi_slots(stock_cams)

    doc = {
        'schema': 'rps/robot@1',
        'id': 'lekiwi',
        'name': 'LeKiwi (stock)',
        'description': 'LeKiwi mobile base (3 omni wheels) + SO-101 arm, exactly as the upstream repo ships it.',
        'version': LEKIWI_COMMIT[:7],
        'source': {'repo': 'https://github.com/SIGRobotics-UIUC/LeKiwi', 'commit': LEKIWI_COMMIT,
                   'license': 'Apache-2.0', 'fetched': FETCHED,
                   'files': 'urdf/LeKiwi.urdf, meshes/ (URDF/meshes), print/ (3DPrintMeshes) - copied verbatim, see SOURCE.md'},
        'units': 'mm',
        'up': 'z',
        'frame': {'ground_z': PROF['ground_z'], 'notes': 'robot frame, mm: +X right, +Y forward, +Z up; '
                                                         'top deck plate Z = 57.0, shoulder-pan axis at (0, 67.15)'},
        'bed': PROF['bed'],
        'kinematics': {
            'urdf': 'urdf/LeKiwi.urdf',
            'root_link': root_link,
            'mesh_dir': 'meshes/',
            'mesh_units': 'mm',
            'urdf_units': 'm',
            'scale_note': 'URDF lengths are metres, the referenced meshes are millimetres and carry no '
                          '<mesh scale>; multiply link poses by 1000 after FK (or the meshes by 0.001 before).',
            'joints': jout,
            'arm_joint_order': PROF['arm_joint_order'],
            'arm_links': PROF['arm_links'],
            'drive_joints': ['base_left_wheel', 'base_right_wheel', 'base_back_wheel'],
            'joint_limits_deg': PROF['joint_limits_deg'],
            'joint_limits_map': PROF['joint_limits_map'],
            'joint_limits_source': fix_text(PROF['joint_limits_note']),
            'zero_pose_note': 'The URDF zero pose is the folded/parked CAD configuration, NOT the '
                              'SO-101 reference zero; joint_limits_map carries the sign+offset that '
                              'relates the two. All six joints at 0 is inside every limit.',
        },
        'components': components,
        'frames': frames,
        'cameras': cameras,
        'slots': slots,
        'presets': arm_presets(PROF['arm_joint_order']),
        'presets_source': PRESETS_SOURCE,
        'mass': STOCK_MASS,
        'thumbnail': 'thumb.png',
        'generated_by': 'tools/build/make_robots.py',
    }
    out = os.path.join(pkg, 'robot.json')
    doc = typography(doc)                        # one spelling per unit, everywhere
    check_camera_slots(doc, 'assets/robots/lekiwi/robot.json')
    check_slot_rules(doc, 'assets/robots/lekiwi/robot.json')
    note_unstated_plates(doc)
    check_slot_groups(doc, 'assets/robots/lekiwi/robot.json')
    check_print_names(doc, 'assets/robots/lekiwi/robot.json')
    check_style(doc, 'assets/robots/lekiwi/robot.json')
    write_json(out, check_text(doc, 'assets/robots/lekiwi/robot.json'))
    log('wrote %s  (%d components, %d joints, %d printable)' %
        (os.path.relpath(out, STUDIO), len(components), len(jout),
         sum(1 for c in components if c['printable'])))
    return doc


def lekiwi_slots(stock_cams):
    """Stock-robot slots: what the stock robot has a choice about (lekiwi-pincopen adds more)."""
    # Every option of a slot that `provides` a camera carries that camera - a pose from
    # stock_camera_blocks(), or the literal null for "no camera while this option is fitted".
    return {
        'gripper': {
            'label': 'Gripper', 'hint': 'What is bolted to the wrist-roll flange.',
            'anchor': 'wrist_flange', 'default': 'stock_jaw',
            # The WHOLE stock gripper, not just the jaw that moves: both packages must own the
            # fixed jaw and the jaw servo too, or "No gripper" leaves them drawn and exported.
            # The link Wrist_Roll_08c-v1 and frames.wrist_flange are kinematics and stay.
            'covers': ['Wrist_Roll_08c-v1', 'Moving_Jaw_08d-v1', 'STS3215_03a-v1-4'],
            'note': 'This package attaches nothing, so it offers no PincOpen option - swapping '
                    'in a whole gripper package is what the LeKiwi + PincOpen package is for.',
            'options': [
                {'id': 'stock_jaw', 'label': 'Stock SO-101 jaw', 'kind': 'components',
                 'show': ['Wrist_Roll_08c-v1', 'Moving_Jaw_08d-v1', 'STS3215_03a-v1-4'],
                 'note': 'The single-jaw gripper in the URDF, driven by arm_gripper: the fixed '
                         'jaw it closes onto, the moving jaw and the servo that drives it.'},
                {'id': 'none', 'label': 'No gripper', 'kind': 'none',
                 'hide': ['Wrist_Roll_08c-v1', 'Moving_Jaw_08d-v1', 'STS3215_03a-v1-4']},
                {'id': 'import', 'label': 'Import alternative STL...', 'kind': 'import',
                 'mount': 'wrist_flange'},
            ]},
        'front_camera': {
            'label': 'Front camera', 'hint': 'The forward-looking camera on the base bracket.',
            'anchor': 'Camera-Mount-v8', 'default': 'stock', 'provides': ['cameras.front'],
            'covers': ['Camera-Model-v3', 'Camera-Mount-v8'],
            'options': [
                {'id': 'stock', 'label': 'Stock LeKiwi front camera', 'kind': 'components',
                 'show': ['Camera-Model-v3', 'Camera-Mount-v8'],
                 'cameras': {'front': dict(stock_cams['front'])}},
                {'id': 'none', 'label': 'No front camera', 'kind': 'none',
                 'hide': ['Camera-Model-v3', 'Camera-Mount-v8'],
                 'cameras': {'front': None}},
                {'id': 'import', 'label': 'Import alternative STL...', 'kind': 'import',
                 'mount': 'Camera-Mount-v8'},
            ]},
        'wrist_camera_mount': {
            'label': 'Wrist camera mount', 'hint': 'The camera that looks down the fingers.',
            'anchor': 'wrist_flange', 'default': 'stock_v11', 'provides': ['cameras.wrist'],
            'covers': ['Wrist-Camera-Mount-v11', 'Camera-Model-v3-1'],
            'options': [
                {'id': 'stock_v11', 'label': 'Stock SO-101 wrist camera', 'kind': 'components',
                 'show': ['Wrist-Camera-Mount-v11', 'Camera-Model-v3-1'],
                 'cameras': {'wrist': dict(stock_cams['wrist'])}},
                {'id': 'none', 'label': 'No wrist camera', 'kind': 'none',
                 'hide': ['Wrist-Camera-Mount-v11', 'Camera-Model-v3-1'],
                 'cameras': {'wrist': None}},
                {'id': 'import', 'label': 'Import alternative STL...', 'kind': 'import',
                 'mount': 'wrist_flange'},
            ]},
        'pi_case': {
            'label': 'Raspberry Pi case', 'hint': 'The Pi enclosure on the rear deck.',
            'anchor': 'deck_rear_pocket', 'default': 'stock',
            'covers': ['Bottom-V2-v3', 'Top-V2-v2'],
            'options': [
                {'id': 'stock', 'label': 'Stock LeKiwi case (Bottom-V2 + Top-V2)', 'kind': 'components',
                 'show': ['Bottom-V2-v3', 'Top-V2-v2']},
                {'id': 'none', 'label': 'No Pi case', 'kind': 'none', 'hide': ['Bottom-V2-v3', 'Top-V2-v2']},
                {'id': 'import', 'label': 'Import alternative STL...', 'kind': 'import',
                 'mount': 'deck_grid'},
            ]},
    }
