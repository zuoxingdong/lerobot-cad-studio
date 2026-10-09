"""assets/robots/lekiwi-pincopen/robot.json: the composition, BY REFERENCE (`rps/robot@2`).

The base's components, kinematics and frames are not copied: the file names the base, what it
hides, what it attaches and the frames, cameras and slots it adds.  Part options are part ids.
"""
import json
import os

import numpy as np

from packlib.atomic import write_json
from .cameras import df200_cam, lek_stock_cameras
from .checks import (check_camera_slots, check_part, check_print_names, check_slot_groups,
                     check_slot_rules, check_style, check_text, fix_text, typography)
from .parts import DEFAULT_DESIGN
from .paths import LEKIWI_COMMIT, PARTS, PINCOPEN_COMMIT, PROF, ROBOTS
from .resolve import resolve_dir
from .rules import composition_rules, composition_slots
from .urdf import cm, log

WHERE = 'assets/robots/lekiwi-pincopen/robot.json'
# The stock gripper meshes come OFF when PincOpen is fitted.  STS3215_03a-v1-4 is the SO-101
# gripper motor, which PincOpen remounts horn-down at X -18 (it carries it as sts3215_drive);
# left in the stock pose it sits 3.8 + 3.9 + 2.3 cm3 inside PincOpen's plates and Cam.
# Wrist_Roll_08c-v1 is not the wrist-roll link but the SO-101 STATIC JAW, reaching 47.9 mm
# past PincOpen's front face and 11.0 mm below its bottom plate.  Only the MESHES go: the
# links and frames.wrist_flange are kinematics and stay whatever the gripper is.
HIDE = ['Moving_Jaw_08d-v1', 'STS3215_03a-v1-4', 'Wrist_Roll_08c-v1',
        'Wrist-Camera-Mount-v11', 'Camera-Model-v3-1', 'Bottom-V2-v3', 'Top-V2-v2']
# The sim's mass band: the stock estimate (lekiwi.py STOCK_MASS) plus what this build changes.
UPGRADE_MASS = {
    'estimate_kg': 2.69,
    'band_kg': [2.3, 3.1],
    'source': 'The stock LeKiwi estimate (2.45 kg, see the lekiwi package) plus this build\'s net '
              '0.24 kg by the sim\'s volume rule. Added: the PincOpen gripper, the corner mast and '
              'the DF200 arch with their two modules, the vertical Pi case. Removed: the stock '
              'jaws, wrist camera mount and Pi case. The band is that 2.69 kg ±15 %.',
}


def _record(pid):
    return json.load(open(os.path.join(PARTS, pid, 'record.json')))


def build_composition(lek, pinc, parts=None):
    """Write the composition and return it resolved (for the checks and the caller)."""
    pkg = os.path.join(ROBOTS, 'lekiwi-pincopen')
    os.makedirs(pkg, exist_ok=True)
    wm = PROF['frames']['wrist_mount']
    cams = PROF['cameras']
    WF_LOCAL = np.asarray(wm['local'], float).reshape(4, 4).T          # wrist flange, in its link
    WF_LINK = wm['parent_link']

    top_rec = _record(DEFAULT_DESIGN['top_camera_mount'])
    wrist_rec = _record(DEFAULT_DESIGN['wrist_camera_mount'])
    # The DEFAULT option's own datum, folded into the robot / wrist-roll frame: printed so a
    # regeneration says out loud where the default fit puts the two sensors.
    top_local = np.asarray(top_rec['cameras']['top']['local'], float).reshape(4, 4).T
    wrist_local = WF_LOCAL @ np.asarray(wrist_rec['cameras']['wrist']['local'],
                                        float).reshape(4, 4).T
    default_camera_poses = {'top': cm(top_local), 'wrist': cm(wrist_local)}
    top_p = top_rec['params']
    wrist_p = wrist_rec['params']

    frames = {}
    frames['deck_top_centre_rear'] = {'origin': [0, -36.5, 57], 'fit': 'base_centre',
                                      'note': 'XY centre of the rear deck (X +-88, Y -81..+8)'}
    frames['deck_rear_pocket'] = {'origin': [0, -71.65, 57], 'fit': 'base_centre',
                                  'note': 'XY centre of the rev-I Pi case footprint (X +-43.75, Y -91.8..-51.5)'}

    frames['cam_top_corner'] = {
        'origin': [round(float(v), 4) for v in top_p['sensor_robot_mm']],
        'tilt_deg': float(top_p['tilt_deg']), 'pan_deg': float(top_p['pan_deg']),
        'note': 'the corner mast head at its shipped index-pin hole: rear-left post, panned '
                '%g deg across the workspace, %g deg nose-down'
                % (top_p['pan_deg'], top_p['tilt_deg'])}

    # `front` is the base's own camera, inherited unchanged; these two replace or add
    cameras = [
        dict({'id': 'wrist', 'label': 'Wrist', 'name': 'Wrist (PincOpen + DF200 arch)',
              'group': 'camera',
              'mount_frame': 'wrist_flange', 'posed_by': 'slots.wrist_camera_mount',
              'hfov_range': cams['wrist']['hfov_range'],
              'aspect': cams['aspect'], 'near': cams['wrist']['near'],
              'far': cams['wrist']['far'],
              'tilt_deg': float(wrist_p.get('shipped_detent_deg', wrist_p['tilt_deg'])),
              'verified': {
                  'against': 'the DF200 wrist arch as shipped: '
                             'assets/parts/df200_arch/part.json -> cameras.wrist, folded through '
                             'frames.wrist_flange. The PincOpen assembly frame IS that frame, '
                             'so the fold is the identity.',
                  'sensor_pincopen_mm': [round(float(v), 4)
                                         for v in wrist_p['sensor_pincopen_mm']],
                  'design_tilt_deg': float(wrist_p.get('shipped_detent_deg', wrist_p['tilt_deg'])),
                  'verified_tilt_deg': None,
                  'droop_deg': None,
                  'droop_note': 'unmeasured - nothing has been photographed through this '
                                'bracket yet.',
                  'framing_source': wrist_p.get('framing_source'),
                  'gates': wrist_p.get('gates_note')},
              'note': 'DEVICE ONLY - the mount pose is published by the fitted '
                      '`wrist_camera_mount` option, in the `wrist_flange` frame, so it '
                      'follows the arm. The default (df200_arch) puts the sensor at '
                      '(%.2f, %.2f, %.2f) in the PincOpen assembly frame, %g deg below the '
                      'finger direction (+X); the stock SO-101 bracket is on `stock`, and '
                      '`pincopen_holder` / `none` publish `null` - the camera is off.'
                      % (*[float(v) for v in wrist_p['sensor_pincopen_mm']],
                         float(wrist_p.get('shipped_detent_deg', wrist_p['tilt_deg'])))},
             **df200_cam()),
        dict({'id': 'top', 'label': 'Top', 'name': 'Top (corner mast)', 'group': 'camera',
              'mount_frame': 'robot', 'posed_by': 'slots.top_camera_mount',
              'from_frame': 'cam_top_corner',
              'hfov_range': cams['top']['hfov_range'],
              'aspect': cams['aspect'], 'near': cams['top']['near'], 'far': cams['top']['far'],
              'verified': {
                  'against': 'the corner mast as shipped: '
                             'assets/parts/corner_mast_printed/part.json -> cameras.top, in '
                             'robot millimetres.',
                  'design_tilt_deg': float(top_p['tilt_deg']),
                  'verified_tilt_deg': None,
                  'droop_deg': None,
                  'droop_note': 'unmeasured - nothing has been photographed through this '
                                'mast yet.',
                  'note': 'The package poses the corner mast\'s DESIGN. No camera on this '
                          'robot has a measured as-installed offset, so `calibDefaultFor()` '
                          'yields 0 for all three and the strip shows "unmeasured".'},
              'note': 'DEVICE ONLY - the mount pose is published by the fitted '
                      '`top_camera_mount` option, in ROBOT millimetres. The default '
                      '(corner_mast_printed) puts the sensor at (-75.34, -18.57, 504.85), '
                      '45 deg nose-down and panned 10 deg; `none` - which is what stock '
                      'LeKiwi carries overhead - publishes `null`, and the camera is off. '
                      'Column-major: col0 = image right, col1 = image up, col2 = -optical '
                      'axis, col3 = sensor point.'},
             **df200_cam()),
    ]

    doc = {
        'schema': 'rps/robot@2',
        'id': 'lekiwi-pincopen',
        'name': 'LeKiwi + PincOpen',
        'description': 'LeKiwi with the PincOpen gripper on the wrist, the over-the-shoulder '
                       'corner mast carrying the top camera, the DF200 forward arch carrying '
                       'the wrist camera and the vertical Pi case. Every slot offers the '
                       'design that is on the robot, the stock LeKiwi or PincOpen part where '
                       'there is one, nothing at all, and an import.',
        'version': '%s+%s' % (LEKIWI_COMMIT[:7], PINCOPEN_COMMIT[:7]),
        'source': {'note': 'geometry inherited from the lekiwi package; the gripper comes from '
                           'the pincopen package (CC-BY-SA-4.0); the parts are this project\'s own'},
        'units': 'mm', 'up': 'z',
        'base': 'lekiwi',
        'attach': [{
            'robot': 'pincopen', 'at': 'wrist_flange',
            'local': [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            'note': 'The PincOpen assembly frame IS lekiwi.frames.wrist_flange, by construction: '
                    'that frame was derived so +X is the finger direction and the gripper\'s back '
                    'face lands on the wrist-roll flange, so the attachment local is the identity. '
                    + fix_text(wm['note']),
        }],
        'hide': HIDE,
        'hide_note': 'the WHOLE stock gripper - fixed jaw (Wrist_Roll_08c-v1), moving jaw and '
                     'jaw servo - comes off and PincOpen bolts to the wrist-roll horn; the '
                     'stock wrist camera is replaced by the DF200 arch; the stock flat Pi case '
                     'is replaced by the vertical rev-I case (it also fouls the mast legs). '
                     'These are MESHES: the links of the same names, and the frames on them, '
                     'stay.',
        'frames': frames,
        'cameras': cameras,
        'slots': composition_slots(lek_stock_cameras(lek)),
        'rules': composition_rules(),
        'default_design': dict(DEFAULT_DESIGN),
        'mass': UPGRADE_MASS,
        'thumbnail': 'thumb.png',
        'generated_by': 'tools/build/make_robots.py',
    }
    doc = typography(doc)                        # one spelling per unit, everywhere
    check_style(doc, WHERE)
    write_json(os.path.join(pkg, 'robot.json'), check_text(doc, WHERE))
    # every gate reads the RESOLVED package: what the studio and the sim will see
    flat = resolve_dir(ROBOTS, PARTS, 'lekiwi-pincopen')
    check_camera_slots(flat, WHERE)
    check_slot_rules(flat, WHERE)
    check_slot_groups(flat, WHERE)
    check_print_names(flat, WHERE)
    for pid, part in flat['parts'].items():
        check_part(part, os.path.join(PARTS, pid), 'assets/parts/%s/part.json' % pid,
                   slots=flat['slots'], parts=flat['parts'])
    log('wrote %s  (%d components resolved, %d from parts, %d cameras, %d slots)'
        % (WHERE, len(flat['components']),
           sum(1 for c in flat['components'] if c.get('part_of')), len(flat['cameras']),
           len(flat['slots'])))
    for cid, M in default_camera_poses.items():
        log('   cameras.%-5s posed by the fitted option; the default fit\'s sensor is '
            '(%.2f, %.2f, %.2f) in the %s frame'
            % (cid, M[12], M[13], M[14], 'robot' if cid == 'top' else WF_LINK))
    return flat
