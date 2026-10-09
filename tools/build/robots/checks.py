"""What a generated package may and may not say, refused at build time.

Text fixes, the typography pass and the structural rules (forbidden paths, house style,
camera slots, slot groups, plate names); every write_* calls these before json.dump.  The
names, groups and colours of the stock links are labels.py.
"""
import os
import re

# The user reads these strings (Package info, the joint-limit tooltip, the preset chips), so a
# path copied out of the v3 profile is rewritten here into the FACT it names.
# Left-hand sides are the profile's OWN spelling — never rewrite them by a tree-wide rename or
# every fix silently becomes a no-op.  check_text() refuses to write a package that still
# carries a path-shaped string, which is the backstop.
PROFILE_TEXT_FIXES = [
    ('matches docs/analysis/real_front.png', 'matches a photograph of the real front feed'),
    ('the four presets shipped in docs/VERIFY.md', 'the four presets shipped in v3'),
    ('presets shipped in docs/VERIFY.md', 'presets shipped in v3'),
    ('studio/docs/MOTION.md', 'the SO-101 motion reference'),
    ('studio/docs/CAMERAS.md', 'the camera reference'),
    ('docs/analysis/wrist.py', 'a least-squares fit of the real wrist feed'),
    ('docs/analysis/README.md', 'a least-squares fit of the real top feed'),
    ('docs/SLOTS.md', 'the slot documentation'),
    ('docs/gripper_options.md', 'the 2025-26 gripper survey'),
    ('docs/VERIFY.md', 'the v3 verification run'),
    # ...and two sentences of the wrist-flange derivation, split so the Ask-an-agent prompt
    # reads as sentences and the mesh ids are named on first use.
    ('APPROXIMATE, derived from the stock gripper: +X = the arm_wrist_roll axis '
     '(0,0.42262,-0.90631) = the stock finger direction; +Z = -arm_gripper hinge axis '
     '(0,0.90631,0.42262) so the PincOpen camera stack points the same way as the stock '
     'Wrist-Camera-Mount-v11; +Y = Z x X = robot -X = the stock jaw opening direction.',
     'APPROXIMATE, derived from the stock gripper. +X = the arm_wrist_roll axis '
     '(0,0.42262,-0.90631), the stock finger direction. +Z = -arm_gripper hinge axis '
     '(0,0.90631,0.42262), so the PincOpen camera stack points the same way as the stock '
     'wrist camera bracket. +Y = Z x X = robot -X, the stock jaw opening direction.'),
    ('Origin: the PincOpen back face (full-gripper X_min = -53.49 mm) is put on the '
     'wrist-roll output flange (the stock Wrist_Roll_08c-v1 bracket starts 1.0 mm behind it) '
     'and the PincOpen mirror plane Y=0 and finger mid-plane Z=0 are put on the stock gripper '
     'centreline.',
     'Origin: the PincOpen back face (full-gripper X_min = -53.49 mm) is put on the wrist-roll '
     'output flange; the stock fixed jaw starts 1.0 mm behind it. The PincOpen mirror plane '
     'Y=0 and finger mid-plane Z=0 are put on the stock gripper centreline.'),
]
# Strings a generated package may NOT contain, matched case-insensitively.  A package is
# published: a home-directory path would leak one maintainer's filesystem, and a tool name
# would tie neutral provenance to whichever assistant happened to run the generator.
FORBIDDEN_TEXT = ('ai-space/', 'studio/legacy/', 'docs/', '~/', '/home/', 'claude')

# ---------------------------------------------------------------- house style
# One spelling per unit, applied to every PROSE string a package publishes, so the notes a
# tooltip renders read like one document instead of like ASCII source comments.  A string is
# prose when it has a space in it and is not a URL; an id, a mesh name, a file path and a
# matrix element therefore pass through untouched.
TYPO_RULES = [
    (re.compile(r'(?<=\d)\s*(?:deg\b|degrees\b)'), '\u00b0'),      # 45 deg      -> 45°
    (re.compile(r'(?<=\d)\s*x\s*(?=\d)'), ' \u00d7 '),             # 36 x 36     -> 36 × 36
    (re.compile(r'(?<=\d)\s(mm|cm)2\b'), ' \\g<1>\u00b2'),         # 975.8 mm2   -> 975.8 mm²
    (re.compile(r'(?<=\d)\s(mm|cm)3\b'), ' \\g<1>\u00b3'),         # 158 cm3     -> 158 cm³
    (re.compile(r'\bO(?=\d)'), '\u00d8'),                          # O3.50       -> Ø3.50
    (re.compile(r'\+-\s*(?=\d)'), '\u00b1'),                       # +-3.5       -> ±3.5
]
# ...and the style the gate below refuses, so none of it can come back by hand.
STYLE_RULES = [
    (re.compile(r'\d\s*x\s*\d'), '" x " between digits (write "\u00d7")'),
    (re.compile(r'\d\s(?:mm|cm)2\b'), 'mm2/cm2 (write mm\u00b2)'),
    (re.compile(r'\d\s(?:mm|cm)3\b'), 'mm3/cm3 (write mm\u00b3)'),
    (re.compile(r'\d\s*deg\b'), '"deg" after a number (write \u00b0)'),
    (re.compile(r'\bO\d'), 'a capital O for a diameter (write \u00d8)'),
    (re.compile(r'\+-\d'), '"+-" (write \u00b1)'),
]
MAX_SENTENCE_WORDS = 40
# ...measured on the keys the UI actually renders as a name, a card or a hover.  A reference
# text (a derivation, a residual note) is read on purpose and may be as long as it needs.
TOOLTIP_KEYS = frozenset(('label', 'name', 'note', 'notes', 'hint', 'option_note',
                          'print_fit_note', 'summary', 'what', 'gates', 'gates_note',
                          'droop_note', 'description'))
# Keys whose value is machine-read or a proper name, never prose.
RAW_KEYS = frozenset(('url', 'repo', 'commit', 'mesh', 'print_file', 'part_file', 'print_name',
                      'file', 'files', 'raw', 'tool', 'generator', 'generated_by', 'thumbnail',
                      'id', 'schema', 'version', 'origin', 'from'))


def _is_prose(s):
    """A string the house style applies to: words, not an id, a path or a URL."""
    return ' ' in s.strip() and '://' not in s


def typography(v, key=None):
    """Apply the house style to every prose string in a package document."""
    if isinstance(v, str):
        if key in RAW_KEYS or not _is_prose(v):
            return v
        for rx, rep in TYPO_RULES:
            v = rx.sub(rep, v)
        return v
    if isinstance(v, list):
        return [typography(x, key) for x in v]
    if isinstance(v, dict):
        return {k: typography(x, k) for k, x in v.items()}
    return v


def _sentences(s):
    """Split prose into sentences, keeping decimals and abbreviations together."""
    return [t for t in re.split(r'(?<=[.!?])\s+(?=[-+\d"ØA-Z`(])', s) if t.strip()]


def check_style(doc, where):
    """Refuse a package whose user-visible prose drifts back off the house style.

    typography() fixes the six unit spellings on the way out, so anything this finds is a
    string the pass could not reach - and a sentence over MAX_SENTENCE_WORDS words is a
    tooltip nobody reads to the end.
    """
    bad = []

    def walk(v, path, key=None):
        if isinstance(v, str):
            if key in RAW_KEYS or not _is_prose(v):
                return
            for rx, what in STYLE_RULES:
                m = rx.search(v)
                if m:
                    bad.append('%s: %s - ...%s...'
                               % (path, what, v[max(0, m.start() - 30):m.end() + 30]))
            for s in (_sentences(v) if key in TOOLTIP_KEYS else ()):
                n = len(s.split())
                if n > MAX_SENTENCE_WORDS:
                    bad.append('%s: a %d-word sentence (limit %d) - "%s..."'
                               % (path, n, MAX_SENTENCE_WORDS, ' '.join(s.split()[:12])))
        elif isinstance(v, list):
            for i, x in enumerate(v):
                walk(x, '%s[%d]' % (path, i), key)
        elif isinstance(v, dict):
            for k, x in v.items():
                walk(x, '%s.%s' % (path, k), k)

    walk(doc, where)
    if bad:
        raise SystemExit('make_robots.py: %s breaks the house style for user-visible text '
                         '(see TYPO_RULES / STYLE_RULES in checks.py):\n  %s'
                         % (where, '\n  '.join(bad[:10])))
    return doc


def check_text(doc, where):
    """Refuse to write a package whose prose still points into a tree we do not ship."""
    bad = []

    def walk(v, path):
        if isinstance(v, str):
            low = v.lower()
            for needle in FORBIDDEN_TEXT:
                if needle in low:
                    i = low.index(needle)
                    bad.append('%s: ...%s...' % (path, v[max(0, i - 40):i + 60]))
        elif isinstance(v, list):
            for i, x in enumerate(v):
                walk(x, '%s[%d]' % (path, i))
        elif isinstance(v, dict):
            for k, x in v.items():
                walk(x, '%s.%s' % (path, k))

    walk(doc, where)
    if bad:
        raise SystemExit('make_robots.py: %s still carries text this product does not ship '
                         '(see PROFILE_TEXT_FIXES / FORBIDDEN_TEXT):\n  %s' % (where, '\n  '.join(bad[:8])))
    return doc


# THE CAMERA RULE.  A camera is a DEVICE bolted to a MOUNT, and the mount is a slot option:
#   1. every option of a slot that provides `cameras.<id>` publishes that camera — a pose, or
#      the literal null for "no camera while this option is fitted".  Silence leaves the
#      frustum wherever the package last put it.
#   2. the package-level `cameras[]` entry is the DEVICE only (lens, intrinsics, name); a base
#      pose there would hide an option that published none.
#   3. an option may not change the lens: its `hfov_deg` has to be the device's own.
# `kind: "import"` is exempt — an imported STL is not a mount until its meta.json says so.
def check_camera_slots(doc, where):
    """Refuse to write a package that breaks the camera rule above."""
    bad = []
    cams = {c['id']: c for c in (doc.get('cameras') or [])}
    for sid, slot in (doc.get('slots') or {}).items():
        for prov in (slot.get('provides') or []):
            if not prov.startswith('cameras.'):
                continue
            cid = prov[len('cameras.'):]
            dev = cams.get(cid)
            if dev is None:
                bad.append('slots.%s provides cameras.%s, which the package does not declare' % (sid, cid))
                continue
            for key in ('local', 'link'):
                if dev.get(key) is not None:
                    bad.append('cameras.%s carries a mount pose (`%s`) although slots.%s poses it: '
                               'the package-level camera is the DEVICE only' % (cid, key, sid))
            for opt in (slot.get('options') or []):
                if opt.get('kind') == 'import':
                    continue
                block = opt.get('cameras')
                if not isinstance(block, dict) or cid not in block:
                    bad.append('slots.%s.options[%s] publishes no cameras.%s — give it a pose, '
                               'or the literal null for "no camera on this option"'
                               % (sid, opt.get('id'), cid))
                    continue
                pose = block[cid]
                if pose is None:
                    continue
                if not isinstance(pose, dict) or not (pose.get('local') or pose.get('origin')
                                                      or pose.get('matrix')):
                    bad.append('slots.%s.options[%s].cameras.%s is neither null nor a pose '
                               '(needs `local`, `matrix` or `origin`)' % (sid, opt.get('id'), cid))
                    continue
                h = pose.get('hfov_deg')
                if h is not None and abs(float(h) - float(dev.get('hfov_deg') or 0)) > 1e-6:
                    bad.append('slots.%s.options[%s].cameras.%s declares hfov %s, but the device '
                               'is %s — an option may not change the lens'
                               % (sid, opt.get('id'), cid, h, dev.get('hfov_deg')))
    if bad:
        raise SystemExit('make_robots.py: %s breaks the camera-slot rule '
                         '(see check_camera_slots):\n  %s' % (where, '\n  '.join(bad[:12])))
    return doc


def fix_text(v):
    """Apply PROFILE_TEXT_FIXES to every string in a value copied out of the v3 profile."""
    if isinstance(v, str):
        for a, b in PROFILE_TEXT_FIXES:
            v = v.replace(a, b)
        return v
    if isinstance(v, list):
        return [fix_text(x) for x in v]
    if isinstance(v, dict):
        return {k: fix_text(x) for k, x in v.items()}
    return v


def check_slot_groups(doc, where):
    """A component a slot OWNS may not be filed under `arm`.  See SLOT_PART_RELABEL."""
    comp = {c['id']: c for c in doc['components']}
    bad = []
    for sid, s in (doc.get('slots') or {}).items():
        owned = set(s.get('covers') or [])
        for o in s.get('options') or []:
            for k in ('show', 'hide', 'parts'):
                owned |= set(o.get(k) or [])
        for cid in sorted(owned):
            c = comp.get(cid)                      # an `attachment:<pkg>` id has no component here
            if c and c.get('group') == 'arm':
                bad.append('%s owns %s, which is filed under group "arm" (label %r)'
                           % (sid, cid, c.get('label')))
    if bad:
        raise SystemExit('%s: a slot owns a part filed under the stock arm '
                         '(see check_slot_groups / SLOT_PART_RELABEL):\n  %s'
                         % (where, '\n  '.join(bad)))


def note_unstated_plates(doc):
    """Say, on the component, WHY a printable states no bed pose."""
    # A print_file that IS the display mesh names the bytes to export and nothing about how
    # they lie on the bed; without this note the studio would read an assembly pose as a
    # bed-contact verdict.  The Checks section prints what is written here.
    for c in doc['components']:
        if not c.get('printable') or c.get('print_transform') or c.get('print_fit_note'):
            continue
        pf, mesh = c.get('print_file'), c.get('mesh')
        if not pf:
            continue
        if mesh and os.path.basename(pf) == os.path.basename(mesh):
            c['print_fit_note'] = ('this file IS the display mesh - the package names the bytes '
                                   'to print and no bed pose for them')
        else:
            c['print_fit_note'] = 'the package names this file but states no bed pose for it'


def check_print_names(doc, where):
    """No two components of a package may name the same exported plate."""
    # Otherwise the export invents `head_PRINT-2.stl`, and which solid gets the `-2` depends
    # on the slot options the design happens to hold.
    seen = {}
    bad = []
    for c in doc['components']:
        n = c.get('print_name')
        if not n:
            continue
        if n in seen:
            bad.append('%s and %s both export as %s' % (seen[n], c['id'], n))
        seen[n] = c['id']
    if bad:
        raise SystemExit('%s: two components claim one plate name '
                         '(see check_print_names / plate_export_name):\n  %s'
                         % (where, '\n  '.join(bad)))


def check_slot_rules(doc, where):
    """Every cross-slot `requires` rule names options that EXIST."""
    # An `any` holding a retired option id is a rule the cascade can never satisfy; an `else`
    # naming one switches that slot to nothing.  Both are invisible until a user hits them.
    bad = []
    ids = {sid: {o.get('id') for o in (sl.get('options') or [])}
           for sid, sl in (doc.get('slots') or {}).items()}
    for sid, sl in (doc.get('slots') or {}).items():
        for o in (sl.get('options') or []):
            for tgt, rule in (o.get('requires') or {}).items():
                if tgt not in ids:
                    bad.append('slots.%s.options[%s] requires slot "%s", which does not exist'
                               % (sid, o.get('id'), tgt))
                    continue
                for want in (rule.get('any') or []):
                    if want not in ids[tgt]:
                        bad.append('slots.%s.options[%s] allows %s.%s, which is not an option '
                                   'of that slot' % (sid, o.get('id'), tgt, want))
                els = rule.get('else')
                if els is not None and els not in ids[tgt]:
                    bad.append('slots.%s.options[%s] falls back to %s.%s, which is not an '
                               'option of that slot' % (sid, o.get('id'), tgt, els))
    if bad:
        raise SystemExit('%s: a cross-slot rule names an option that is not there '
                         '(see check_slot_rules):\n  %s' % (where, '\n  '.join(bad[:12])))
    return doc


PART_FRAMES = ('robot', 'slot_anchor', 'attachment')


def check_part(doc, part_dir, where, slots=None, parts=None):
    """Refuse a `rps/part@1` whose schema, files, slot or `part:` references are wrong."""
    bad = []
    if doc.get('schema') != 'rps/part@1':
        bad.append('schema is %r, not rps/part@1' % doc.get('schema'))
    if doc.get('id') != os.path.basename(os.path.normpath(part_dir)):
        bad.append('id %r is not the folder name' % doc.get('id'))
    if doc.get('frame') not in PART_FRAMES:
        bad.append('frame %r is not one of %s' % (doc.get('frame'), ', '.join(PART_FRAMES)))
    if slots is not None and doc.get('slot') is not None and doc['slot'] not in slots:
        bad.append('slot %r is not a slot of %s' % (doc['slot'], doc.get('robot')))
    seen = set()
    for m in doc.get('meshes') or []:
        mid = m.get('id')
        if not mid or mid in seen:
            bad.append('mesh id %r is missing or repeated' % mid)
        seen.add(mid)
        if not m.get('file') and not m.get('print'):
            bad.append('mesh %r has neither `file` nor `print`' % mid)
        for k in ('file', 'print'):
            p = m.get(k)
            if not p:
                continue
            if p.startswith('part:'):
                if parts is not None and p[5:] not in parts:
                    bad.append('mesh %r prints as %s, which is not a part' % (mid, p))
            elif not os.path.isfile(os.path.join(part_dir, p)):
                bad.append('mesh %r: %s is missing' % (mid, p))
    if not doc.get('meshes'):
        bad.append('no meshes')
    for pid, p in (doc.get('params') or {}).items():
        if p.get('kind') == 'hinge':
            for k in ('value', 'values', 'origin', 'axis', 'moves'):
                if p.get(k) is None:
                    bad.append('params.%s: a hinge needs `%s`' % (pid, k))
            for mv in p.get('moves') or []:
                if mv not in seen:
                    bad.append('params.%s moves %r, which is not a mesh' % (pid, mv))
    if bad:
        raise SystemExit('%s is not a valid part:\n  %s' % (where, '\n  '.join(bad)))
    return doc
