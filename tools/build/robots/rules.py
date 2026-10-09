"""The composition's slots: the cross-slot rules, the option lists and what each option owns.

A part option is its part id (`option:part` when the two differ); `parts.py` writes the part.
The resolver lists the part's components, its camera and its rules on the option.
"""
from .parts import DEFAULT_DESIGN

# Cross-slot rules.  `any` = the option ids of that slot this option can live with; `else` =
# what the cascade switches that slot to when it cannot.  Every `any` has to be a SUBSET of
# the ids the slot offers, or the rule can never fire — checks.check_slot_rules() enforces it.
NEEDS_PINCOPEN = {'gripper': {'any': ['pincopen'], 'else': 'pincopen'}}
# Without PincOpen the wrist can still carry the stock LeKiwi wrist camera (it bolts to the
# wrist-roll link, not to the gripper), but only `stock_jaw` falls back to it — that restores
# the stock robot whole, while "no gripper" / "import" fall back to an empty wrist.
# The fingertips are PincOpen's: they bolt to its fingers on a 3x M2 pattern, so with no
# PincOpen there is nothing to bolt them to and the slot allows only `none` or an import.
NO_PINCOPEN = {'wrist_camera_mount': {'any': ['stock', 'none', 'import'], 'else': 'none'},
               'fingertips': {'any': ['none', 'import'], 'else': 'none'}}
STOCK_JAW = {'wrist_camera_mount': {'any': ['stock', 'none', 'import'], 'else': 'stock'},
             'fingertips': NO_PINCOPEN['fingertips']}
# PincOpen on the wrist rules the STOCK bracket out (its top plate is in the same place) and
# nothing else: the DF200 arch, PincOpen's own holder, nothing at all, or an import.
WITH_PINCOPEN = {'wrist_camera_mount': {
    'any': [DEFAULT_DESIGN['wrist_camera_mount'], 'pincopen_holder', 'none', 'import'],
    'else': DEFAULT_DESIGN['wrist_camera_mount']}}
# ...and the stock wrist camera needs a wrist WITHOUT PincOpen on it: the PincOpen top plate
# occupies the same space as the stock Wrist-Camera-Mount-v11 bracket.
NEEDS_NO_PINCOPEN = {'gripper': {'any': ['stock_jaw', 'none', 'import'], 'else': 'stock_jaw'}}


# The two component sets wrist_camera_mount owns on top of this project's own mounts, by their
# LOCAL ids (the attachment loader resolves "camera_basement" to "pincopen/camera_basement").
# NOT the upstream `Cam` (32 x 32 x 6.85 mm at Z -2.7..4.15): that is the gripper's own cam
# disc on the STS3215 horn, and hiding it would take the four-bar drive off the robot.  Only
# Camera_basement (Z 19.5..70.7) and Camera_mobile_sup (Z 60.7..104.9) are the holder.
PINCOPEN_HOLDER = ['camera_basement', 'camera_mobile_sup']
STOCK_WRIST_CAMERA = ['Wrist-Camera-Mount-v11', 'Camera-Model-v3-1']
# PincOpen's own fingertips, by their LOCAL ids — the same four assets/robots/pincopen/robot.json
# lists.  Naming them here is what makes the composition's fingertips slot OWN them; claimed
# only through a `replaces:` list they would fall to the gripper slot instead.
PINCOPEN_TIPS = ['tip_support', 'tip_support_2', 'removable_tip', 'removable_tip_2']


# `pincopen_holder` publishes NO camera, and that is a measurement, not an omission: upstream
# Camera_mobile_sup SLIDES in Camera_basement and frames.camera_plate is a SEAT (four M2 holes
# at Z 19.50), not a sensor datum.  With no height, lens or look direction to publish, the
# honest answer is null — fitting the holder switches the wrist camera off.
PINCOPEN_HOLDER_CAMERA = None


# (slot, option) -> the `requires` rule the resolver puts on that option
RULES = [
    ('wrist_camera_mount', DEFAULT_DESIGN['wrist_camera_mount'], NEEDS_PINCOPEN),
    ('wrist_camera_mount', 'pincopen_holder', NEEDS_PINCOPEN),
    ('wrist_camera_mount', 'stock', NEEDS_NO_PINCOPEN),
    ('gripper', 'pincopen', WITH_PINCOPEN),
    ('gripper', 'stock_jaw', STOCK_JAW),
    ('gripper', 'none', NO_PINCOPEN),
    ('gripper', 'import', NO_PINCOPEN),
    ('fingertips', 'original', NEEDS_PINCOPEN),
]


def composition_rules():
    """The composition's `rules` list."""
    return [{'slot': s, 'option': o, 'requires': dict(r)} for s, o, r in RULES]


def composition_slots(stock_cams=None):
    """The composition's slots, one design per slot; part options are part ids."""
    # Every list is the same four rows — latest design (the default), stock part, none, import
    # — plus, on the wrist, PincOpen's own holder, the stock part of the gripper that is fitted.
    SC = stock_cams or {}
    return {
        'top_camera_mount': {
            'label': 'Overhead camera mount', 'anchor': 'deck_top_centre_rear',
            'hint': 'The mast that carries the top-down camera over the deck.',
            'provides': ['cameras.top'], 'default': DEFAULT_DESIGN['top_camera_mount'],
            'covers': [],
            'options': [
                DEFAULT_DESIGN['top_camera_mount'],
                # stock LeKiwi carries NO overhead camera at all, so `none` IS the stock row
                {'id': 'none', 'label': 'No overhead camera (stock LeKiwi)', 'kind': 'none',
                 'cameras': {'top': None},
                 'note': 'Stock LeKiwi has no mast and no top camera - the deck is bare. '
                         "The overhead view is this project's addition."},
                {'id': 'import', 'label': 'Import alternative STL...', 'kind': 'import',
                 'mount': 'deck_grid'},
            ]},
        'wrist_camera_mount': {
            'label': 'Wrist camera mount', 'anchor': 'wrist_flange',
            'hint': 'The camera that looks down the fingers; seats on the PincOpen camera face (Z 19.5).',
            'provides': ['cameras.wrist'], 'default': DEFAULT_DESIGN['wrist_camera_mount'],
            # EVERY mount that can sit on this seat, whoever ships it: a component not
            # covered here is not the slot's to hide, so it stays drawn under whatever is
            # fitted.  That is why the PincOpen camera stack and the two stock LeKiwi wrist
            # parts are listed even though another package ships them.
            'covers': PINCOPEN_HOLDER + STOCK_WRIST_CAMERA,
            'interface': {'seat_z': 19.50, 'hole_pattern_mm': [15.00, 37.82],
                          'note': 'the camera face of the PincOpen gripper, as that package '
                                  'publishes it'},
            'options': [
                DEFAULT_DESIGN['wrist_camera_mount'],
                {'id': 'pincopen_holder', 'label': 'PincOpen camera holder (as assembled)',
                 'kind': 'components', 'show': PINCOPEN_HOLDER,
                 'cameras': {'wrist': PINCOPEN_HOLDER_CAMERA},
                 'note': 'The camera stack upstream PincOpen ships: the basement bolted to the '
                         '4x M2 seat at Z 19.5, with the sliding support in it up to Z 104.9. '
                         'It publishes NO camera pose, and that is a measurement, not an '
                         'omission. The PincOpen package declares no sensor and no lens for '
                         'this holder, and the camera face is a SEAT (four M2 at Z 19.50), not '
                         'a sensor datum. The support slides, so there is no height to publish '
                         'either. Fitting this therefore switches the wrist camera OFF: measure '
                         'your own head and type the pose in under "As installed".'},
                {'id': 'stock', 'label': 'Stock LeKiwi wrist camera', 'kind': 'components',
                 'show': STOCK_WRIST_CAMERA,
                 'cameras': {'wrist': dict(SC['wrist'])},
                 'note': 'The stock SO-101 wrist bracket and its camera module, on the '
                         'wrist-roll link - the same pose the stock LeKiwi package publishes, '
                         'to the byte. It cannot share the wrist with PincOpen, whose top plate '
                         'is in the same place, so fitting it swaps the gripper back to the '
                         'stock jaw.'},
                {'id': 'none', 'label': 'No wrist camera', 'kind': 'none',
                 'cameras': {'wrist': None}},
                {'id': 'import', 'label': 'Import alternative STL...', 'kind': 'import',
                 'mount': 'wrist_flange'},
            ]},
        'gripper': {
            'label': 'Gripper', 'anchor': 'wrist_flange', 'hint': 'What is bolted to the wrist-roll flange.',
            'default': 'pincopen',
            # THE WHOLE STOCK GRIPPER, or the slot cannot take it off.  `Wrist_Roll_08c-v1`
            # is the SO-101 STATIC JAW (its fixed finger is the other half of the grasp),
            # not a link of the arm: on the real robot it unbolts with the moving jaw and
            # the jaw servo, and PincOpen's Interface_ARM100 goes onto the bare wrist-roll
            # horn.  Left out of `covers` it was drawn under every option - a fixed finger
            # hanging 11.0 mm below the PincOpen bottom plate and 47.9 mm past its front
            # face, which is the "Wrist_Roll_08c-v1 x ball" contact the physics suite used
            # to forgive.  The LINK of the same name, and `frames.wrist_flange` on it, are
            # kinematics: hiding a component never removes either.
            'covers': ['attachment:pincopen', 'Wrist_Roll_08c-v1',
                       'Moving_Jaw_08d-v1', 'STS3215_03a-v1-4'],
            'options': [
                {'id': 'pincopen', 'label': 'PincOpen (as assembled)', 'kind': 'attachment',
                 'package': 'pincopen'},
                {'id': 'stock_jaw', 'label': 'Stock SO-101 jaw', 'kind': 'components',
                 'show': ['Wrist_Roll_08c-v1', 'Moving_Jaw_08d-v1', 'STS3215_03a-v1-4'],
                 'note': 'The whole stock gripper back on the wrist: the fixed jaw, the '
                         'moving jaw it closes onto and the gripper motor in its stock place, '
                         'with the stock wrist camera back on its bracket. PincOpen reuses that '
                         'same motor, remounted.'},
                {'id': 'none', 'label': 'No gripper (bare wrist)', 'kind': 'none'},
                {'id': 'import', 'label': 'Import alternative STL...', 'kind': 'import',
                 'mount': 'wrist_flange'},
            ]},
        'fingertips': {
            'label': 'Fingertips', 'anchor': 'fingertip_pad', 'mirrored': True,
            'hint': 'The Tip_Support that bolts to each finger on the 3x M2 pattern.',
            'default': 'original', 'covers': PINCOPEN_TIPS,
            'interface': {'holes_mm': [[51.64, 3.50], [51.64, -3.50], [61.64, 0.0]],
                          'note': 'the 3x M2 tip pattern, as the PincOpen package publishes it'},
            'options': [
                # the tips upstream PincOpen ships ARE the latest design here: this project's
                # six fingertip concepts were never printed and are retired.  They are named
                # explicitly (`kind: "components"`, exactly as the pincopen package's own
                # fingertips slot does) rather than left to `attachment_default`, which shows
                # "whatever the other options replace" and therefore nothing at all now.
                {'id': 'original', 'label': 'Original PincOpen tips', 'kind': 'components',
                 'show': PINCOPEN_TIPS,
                 'note': 'The Tip_Support pair and their removable noses as upstream PincOpen '
                         'ships them - what is on the robot. They bolt to the PincOpen fingers '
                         'on the 3x M2 pattern, so they need the PincOpen gripper: fitting them '
                         'brings it back, and taking it off takes them off.'},
                # every slot carries an empty option, so "Remove" has somewhere to go
                {'id': 'none', 'label': 'No fingertips (bare fingers)', 'kind': 'none'},
                {'id': 'import', 'label': 'Import alternative STL...', 'kind': 'import',
                 'mount': 'fingertip_pad'},
            ]},
        'pi_case': {
            'label': 'Raspberry Pi case', 'anchor': 'deck_rear_pocket',
            'hint': 'The Pi 5 enclosure in the deck rear pocket.', 'default': 'vertical_revI',
            'covers': ['Bottom-V2-v3', 'Top-V2-v2'],
            'options': [
                DEFAULT_DESIGN['pi_case'] + ':pi_case_vertical',
                {'id': 'stock', 'label': 'Stock LeKiwi case (Bottom-V2 + Top-V2)', 'kind': 'components',
                 'show': ['Bottom-V2-v3', 'Top-V2-v2'],
                 'note': 'The flat stock case - it lies across the rear deck and blocks the mast legs.'},
                {'id': 'none', 'label': 'No Pi case', 'kind': 'none'},
                {'id': 'import', 'label': 'Import alternative STL...', 'kind': 'import',
                 'mount': 'deck_grid'},
            ]},
        'front_camera': {
            'label': 'Front camera', 'anchor': 'Camera-Mount-v8', 'default': 'stock',
            'hint': 'The forward-looking camera on the base bracket.',
            'provides': ['cameras.front'], 'covers': ['Camera-Model-v3', 'Camera-Mount-v8'],
            'options': [
                {'id': 'stock', 'label': 'Stock LeKiwi front camera', 'kind': 'components',
                 'show': ['Camera-Model-v3', 'Camera-Mount-v8'],
                 'cameras': {'front': dict(SC['front'])}},
                {'id': 'none', 'label': 'No front camera', 'kind': 'none',
                 'cameras': {'front': None}},
                {'id': 'import', 'label': 'Import alternative STL...', 'kind': 'import',
                 'mount': 'Camera-Mount-v8'},
            ]},
    }
