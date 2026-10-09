"""The camera DEVICE both packages ship and the two stock LeKiwi mount poses.

The lens is one hardware fact (see DF200_SOURCE); the mount poses come out of the URDF.
"""
import copy
import math

import numpy as np

from .urdf import cm

# All three feeds are the same module: a JR DF200 "100 deg without distortion" (rectilinear),
# MJPG 640x480.  100 deg on the DIAGONAL of a 4:3 frame is 2*atan(tan(50)*4/5) = 87.3 deg
# horizontal, 2*atan(tan(50)*3/5) = 71.1 deg vertical.  The three numbers the packages shipped
# before are kept as `alternatives` — each is a real measurement of something.
DF200_HFOV = 87.3
DF200_VFOV = 71.1
DF200_SOURCE = {
    'value': DF200_HFOV,
    'vfov_deg': DF200_VFOV,
    # `what` is what the UI shows; the arithmetic behind it is a reference text and sits in
    # `derivation`, so a tooltip is one sentence and nothing is lost.
    'what': 'user-confirmed DF200 100 deg diagonal, 640x480 4:3, rectilinear.',
    'derivation': 'All three cameras on the robot are the JR DF200 "100 degrees without '
                  'distortion" module, streamed MJPG at 640 x 480 (user-confirmed 2026-09-15). '
                  '100 deg on the DIAGONAL of a rectilinear 4:3 frame is '
                  '2*atan(tan(50)*4/5) = 87.3 deg horizontal, 2*atan(tan(50)*3/5) = 71.1 deg '
                  'vertical. This is a hardware fact, not a fit: the fitted numbers this '
                  'package shipped before are the alternatives beside it.',
    'url': 'user-confirmed hardware: JR DF200, 2026-09-15',
}
LEGACY_ALTS = [
    {'hfov_deg': 60, 'label': 'measured from the top feed',
     'note': 'A two-landmark (front omni-wheel tops) fit of one screenshot of the live top '
             'feed. It is under-determined - tilt and FOV trade against each other - and at '
             'the confirmed 87.3 the same screenshot no longer reproduces: its wheel spacing '
             'and its silhouette scale want 60-66. The screenshot is most likely a crop. Kept '
             'so the old coverage numbers can be reproduced.',
     'url': 'measured: fit of the live top-camera feed, 2026-09-12'},
    {'hfov_deg': 81, 'label': 'measured from the wrist feed',
     'note': 'A three-landmark (servo LED, gripper body top edge, fingertip) least-squares fit '
             'of the real wrist feed: 32.7 deg half-vFOV, i.e. 65.4 deg V = 81 deg H at 4:3. '
             'The three landmarks solved separately give 74.6 / 83.3 / 90.8, mean 82.9 - the '
             'confirmed 87.3 is inside that spread.',
     'url': 'measured: least-squares fit of the real wrist image, 2026-09-13'},
    {'hfov_deg': 90, 'label': 'Arducam OV5648 (LeKiwi BOM)',
     'note': 'The camera the upstream LeKiwi BOM lists for base_camera_mount.stl: Arducam 5MP '
             'OV5648 wide-angle USB, "Field of View (FOV): 90 degree (H)", M12 lens. It is the '
             'camera the URDF models; it is not the one on this robot.',
     'url': 'https://www.uctronics.com/arducam-5mp-wide-angle-usb-camera-for-computer-1-4-cmos-ov5648-mini-uvc-usb.html'},
]


# The two alternatives the v3 profile carries, rewritten for the lens menu: it renders
# "<label> - <hfov> deg" with `note` as the tooltip, so a label there has to read as a LENS.
# Keyed by the profile's own label, exactly as PROFILE_TEXT_FIXES is keyed.
PROFILE_ALT_FIXES = {
    # 110 deg on the diagonal of a rectilinear 4:3 frame is 2*atan(tan(55)*4/5) = 97.611 deg
    # horizontal and 2*atan(tan(55)*3/5) = 81.186 deg vertical.  The profile rounded both up.
    '110 deg DFOV variant': {
        'hfov_deg': 97.6,
        'label': '110 deg diagonal wide-angle',
        'note': 'Arducam B0454, "5MP OV5648, 110 Degree DFOV Wide Angle". 110 deg on the '
                'diagonal of a rectilinear 4:3 frame is 97.6 deg H / 81.2 deg V.'},
    'cover.py assumption': {
        'label': 'conservative 90 deg diagonal (2026-08)',
        'note': 'The 2026-08 coverage sweep assumed a 90 deg diagonal lens as +-33 deg '
                'horizontal and +-25 deg vertical, i.e. 66 deg H. That is conservative: a '
                'rectilinear 90 deg diagonal at 4:3 is 77.3 deg H. Kept so the old coverage '
                'numbers can be reproduced.'},
}


def _fixed_alt(a):
    """One `alternatives[]` row, with the v3 profile's spelling rewritten for the lens menu."""
    return dict(a, **PROFILE_ALT_FIXES.get(a.get('label'), {}))


def df200_cam(extra_alts=()):
    """hfov/vfov/source/alternatives, shared by every camera in both packages."""
    return dict(hfov_deg=DF200_HFOV, vfov_deg=DF200_VFOV,
                source=dict(DF200_SOURCE),
                alternatives=[dict(a) for a in LEGACY_ALTS] + [_fixed_alt(a) for a in extra_alts])


def tilt_of_local(local):
    """The nose-down angle of a published camera matrix, in the frame it is published in."""
    # One convention for every `cameras.<id>.tilt_deg`, so the number the UI labels a mount
    # with can be checked against the pose that mount publishes.  A camera looks down its -Z.
    M = np.asarray(local, float).reshape(4, 4).T
    d = -M[:3, 2]
    n = np.linalg.norm(d)
    if n < 1e-12:
        return 0.0
    return round(float(-math.degrees(math.asin(max(-1.0, min(1.0, d[2] / n))))), 4)


def stock_camera_blocks(vis, pose, front):
    """The two stock LeKiwi camera poses, as slot-option camera blocks."""
    # BOTH packages ship these exact bytes, so one physical camera on one physical bracket
    # cannot be in two places depending on which package was opened.  `carrier` is the frame
    # features/cameras.js resolves `local` through on every getPose(), so the pose rides the arm.
    Mv_front = vis['Camera-Model-v3']['M'].copy()
    Mv_front[:3, 3] *= 1000.0
    L_front = np.asarray(front['pose']['local'], float).reshape(4, 4).T
    K = np.linalg.inv(Mv_front) @ L_front          # camera frame inside the raw mesh frame
    Mv_wrist = vis['Camera-Model-v3-1']['M'].copy()
    Mv_wrist[:3, 3] *= 1000.0
    L_wrist = Mv_wrist @ K

    def robot_tilt(link, local):
        """What the tile reads at the URDF zero pose - documentation, not the label."""
        W = pose[link].copy()
        W[:3, 3] *= 1000.0
        d = -(W @ np.asarray(local, float))[:3, 2]      # the camera looks down local -Z
        return round(float(-math.degrees(math.asin(max(-1.0, min(1.0, d[2] / np.linalg.norm(d)))))), 4)

    return {
        'front': {
            'carrier': 'Camera-Model-v3', 'local': front['pose']['local'],
            'tilt_deg': tilt_of_local(front['pose']['local']),
            'tilt_robot_deg_at_zero': robot_tilt('Camera-Model-v3', L_front),
            'source': 'the stock LeKiwi front bracket, recovered from the URDF visual origin '
                      'of Camera-Model-v3 (see the package note). `tilt_deg` is nose-down in '
                      'the CARRIER frame (this camera link); in the ROBOT frame, at the URDF '
                      'zero pose, the lens sits %g deg nose-down. Intrinsics from '
                      % robot_tilt('Camera-Model-v3', L_front) + DF200_SOURCE['url'] + '.',
        },
        'wrist': {
            'carrier': 'Camera-Model-v3-1', 'local': cm(L_wrist),
            'tilt_deg': tilt_of_local(cm(L_wrist)),
            'tilt_robot_deg_at_zero': robot_tilt('Camera-Model-v3-1', L_wrist),
            'source': 'the stock SO-101 wrist bracket (Wrist-Camera-Mount-v11), recovered '
                      'from the URDF: the camera-in-mesh transform of the front module '
                      'Camera-Model-v3, re-applied to the Camera-Model-v3-1 instance the '
                      'wrist carries - the two are the same mesh. `tilt_deg` is nose-down in '
                      'the CARRIER frame (this camera link); in the ROBOT frame, at the URDF '
                      'zero pose, the lens sits %g deg nose-down. Intrinsics from '
                      % robot_tilt('Camera-Model-v3-1', L_wrist) + DF200_SOURCE['url'] + '.',
        },
    }


def lek_stock_cameras(lek):
    """The stock camera poses, read back out of the `lekiwi` package's own options."""
    # Copied, never recomputed: one bracket, one camera, one pose, whichever package is open.
    want = {'front': ('front_camera', 'stock'), 'wrist': ('wrist_camera_mount', 'stock_v11')}
    out = {}
    for cam, (sid, oid) in want.items():
        slot = (lek.get('slots') or {}).get(sid) or {}
        opt = next((o for o in slot.get('options', []) if o.get('id') == oid), None)
        block = ((opt or {}).get('cameras') or {}).get(cam)
        if not block:
            raise SystemExit('make_robots.py: assets/robots/lekiwi/robot.json slots.%s.%s publishes no '
                             'cameras.%s — rebuild the lekiwi package first' % (sid, oid, cam))
        out[cam] = copy.deepcopy(block)
    return out
