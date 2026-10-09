"""What a stock URDF link is called, which group it is filed under and its colour, for the
generators (lekiwi.py).  Every name is read off the URDF; the colours are the v3 profile's.
"""
from .paths import PROF

# link name prefix -> component group; first match wins, everything else is `arm`.
GROUP_RULES = [
    ('4-Omni-Directional-Wheel', 'wheels'),
    ('omni_wheel_mount', 'wheels'),
    ('drive_motor_mount', 'wheels'),
    ('ST3215_Servo_Motor', 'wheels'),
    ('base_plate_layer', 'base'),
    ('94868A713', 'base'),
    ('lipo_battery_mount', 'base'),
    ('Battery', 'electronics'),
    ('Bottom-V2', 'electronics'),
    ('Top-V2', 'electronics'),
    ('WaveShare', 'electronics'),
    ('servo_controller_mount', 'electronics'),
    ('Camera-Mount', 'camera'),
    ('Camera-Model', 'camera'),
    ('Wrist-Camera-Mount', 'camera'),
    ('Moving_Jaw', 'gripper'),
]


def group_of(link):
    """The component group a URDF link name falls into."""
    for pre, g in GROUP_RULES:
        if link.startswith(pre):
            return g
    return 'arm'


# A part a slot owns is filed under that slot.  The URDF calls these two arm links; they are
# the SO-101 static jaw and the jaw motor, so "no gripper" would leave them hanging in mid-air
# under an ARM group.  BOTH packages apply this table, so one physical part cannot be a gripper
# part on one robot and an arm link on the other.
SLOT_PART_RELABEL = {
    'Wrist_Roll_08c-v1': ('Stock SO-101 fixed jaw (Wrist Roll 08c)', 'gripper'),
    'STS3215_03a-v1-4': ('Stock jaw servo (STS3215)', 'gripper'),
}

# What each stock link IS, for the tree row, the inspector title and the print-check dialog.
# Without this a component reads as its mesh file with the punctuation taken out ("STS3215 03a
# 1", "94868A713 NO THREADS Female Threaded Hex Standoff 3"), and six identical rows differ
# only by a trailing digit.  Every name below is READ OFF THE URDF, not guessed: the servos are
# named for the joint they drive (the joint whose parent link is the mesh's own parent), the
# wheels and drive parts for the wheel joint under them, and the two plates for the Z they sit
# at.  Repeated parts are numbered "(n of N)" so a tree row identifies one of them.
PART_LABEL = {
    # base: the two plates, the six standoffs between them, the battery tray
    'base_plate_layer1-v5': 'Base plate, lower (layer 1)',
    'base_plate_layer2-v3': 'Top deck plate (layer 2)',
    '94868A713_NO-THREADS_Female-Threaded-Hex-Standoff': 'Hex deck standoff (1 of 6)',
    '94868A713_NO-THREADS_Female-Threaded-Hex-Standoff-1': 'Hex deck standoff (2 of 6)',
    '94868A713_NO-THREADS_Female-Threaded-Hex-Standoff-2': 'Hex deck standoff (3 of 6)',
    '94868A713_NO-THREADS_Female-Threaded-Hex-Standoff-3': 'Hex deck standoff (4 of 6)',
    '94868A713_NO-THREADS_Female-Threaded-Hex-Standoff-4': 'Hex deck standoff (5 of 6)',
    '94868A713_NO-THREADS_Female-Threaded-Hex-Standoff-5': 'Hex deck standoff (6 of 6)',
    'lipo_battery_mount-v3': 'LiPo battery mount',
    # drive: three of everything, told apart by their own wheel joint
    '4-Omni-Directional-Wheel_Single_Body-v1': 'Omni wheel, left',
    '4-Omni-Directional-Wheel_Single_Body-v1-1': 'Omni wheel, right',
    '4-Omni-Directional-Wheel_Single_Body-v1-2': 'Omni wheel, back',
    'omni_wheel_mount-v5': 'Omni wheel hub, left',
    'omni_wheel_mount-v5-1': 'Omni wheel hub, right',
    'omni_wheel_mount-v5-2': 'Omni wheel hub, back',
    'drive_motor_mount-v11': 'Drive motor mount, left',
    'drive_motor_mount-v11-1': 'Drive motor mount, right',
    'drive_motor_mount-v11-2': 'Drive motor mount, back',
    'ST3215_Servo_Motor-v1': 'Drive servo, left (ST3215)',
    'ST3215_Servo_Motor-v1-1': 'Drive servo, right (ST3215)',
    'ST3215_Servo_Motor-v1-2': 'Drive servo, back (ST3215)',
    # electronics
    'Battery---Battery-5.2-Ah-DC5521-Plug-v2': 'Battery, 5.2 Ah (DC5521 plug)',
    'Bottom-V2-v3': 'Stock Pi case, bottom (V2)',
    'Top-V2-v2': 'Stock Pi case, top (V2)',
    'WaveShare_Mounting_Plate_01d-v1': 'WaveShare mounting plate (01d)',
    'servo_controller_mount-v3': 'Servo controller mount',
    # cameras: the same module on two brackets
    'Camera-Model-v3': 'Front camera module',
    'Camera-Mount-v8': 'Front camera bracket',
    'Camera-Model-v3-1': 'Wrist camera module',
    'Wrist-Camera-Mount-v11': 'Wrist camera bracket',
    # arm: each servo is named for the joint it drives
    'Base_08q-v1': 'Arm base (08q)',
    'Passive_Horn_01-v1': 'Passive pan horn (01)',
    'STS3215_03a-v1': 'Shoulder pan servo (STS3215)',
    'Rotation_Pitch_08i-v1': 'Shoulder pan bracket (08i)',
    'SO_ARM100_08k_Asym_Mirror_Clip-v1': 'Shoulder clip (08k)',
    'STS3215_03a-v1-1': 'Shoulder lift servo (STS3215)',
    'SO_ARM100_08k_116_Square-v1': 'Upper arm, 116 mm (08k)',
    'STS3215_03a-v1-2': 'Elbow servo (STS3215)',
    'SO_ARM100_08k_Mirror-v1': 'Forearm (08k)',
    'STS3215_03a-v1-3': 'Wrist flex servo (STS3215)',
    'Wrist_Roll_Pitch_08i-v1': 'Wrist bracket (08i)',
    'STS3215_03a_Wrist_Roll-v1': 'Wrist roll servo (STS3215)',
    'Moving_Jaw_08d-v1': 'Stock SO-101 moving jaw (08d)',
}


def label_for(link, group):
    """(label, group) for a stock link: the slot table first, then PART_LABEL, then the id."""
    if link in SLOT_PART_RELABEL:
        return SLOT_PART_RELABEL[link]
    return (PART_LABEL.get(link) or label_of(link), group)


COLORS = PROF['colors']


def color_of(link, group):
    """The package colour for a link, from the v3 profile's palette."""
    if link in set(PROF.get('removed_stock_links', [])):
        return COLORS.get('removed_stock', '#b5714c')
    for pre, col in COLORS.get('by_prefix', []):
        if link.startswith(pre):
            return col
    if group == 'arm' or group == 'gripper':
        return COLORS.get('arm', '#c3c8cf')
    return COLORS.get('default', '#8d949e')


def label_of(link):
    """A URDF link name as a human label: underscores out, trailing `v<n>` dropped."""
    s = link.replace('_', ' ').replace('-', ' ')
    s = ' '.join(w for w in s.split() if not (w.startswith('v') and w[1:].isdigit()))
    return s.strip()
