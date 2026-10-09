"""Resolve an `rps/robot@2` composition into the flat `rps/robot@1` form, in Python.

The twin of `src/core/compose.js resolveRobot`: base components minus `hide`, plus the
attached robots, plus one component per mesh of every part a slot option names.  Paths in
the result are relative to the composition's folder.  Stdlib only: the generator checks run
on it, and tools/tests/build/resolve-parity.test.mjs holds it to the JS twin.

    python3 tools/build/robots/resolve.py --json <robot id>     the resolved robot.json on stdout
"""
import copy
import json
import os
import sys

ROBOT2 = 'rps/robot@2'
PART = 'rps/part@1'
I16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def load_parts(parts_dir):
    """{id: part.json} for every folder under parts_dir; `_`-prefixed folders are skipped."""
    out = {}
    if not os.path.isdir(parts_dir):
        return out
    for d in sorted(os.listdir(parts_dir)):
        p = os.path.join(parts_dir, d, 'part.json')
        if d.startswith('_') or not os.path.isfile(p):
            continue
        doc = json.load(open(p, encoding='utf-8'))
        if doc.get('schema') == PART:
            out[doc['id']] = doc
    return out


def _mul(a, b):
    """Column-major 4x4 product a @ b."""
    return [sum(a[r + 4 * k] * b[k + 4 * c] for k in range(4)) for c in range(4) for r in range(4)]


def option_ref(spec):
    """(option id, part id) of a part option string `part` or `option:part`; None otherwise."""
    if not isinstance(spec, str):
        return None
    oid, _, pid = spec.partition(':')
    return (oid, pid or oid)


def part_components(part, frames, attach_at, default_on, prefix):
    """One component per drawable mesh of a part, in the composition's frames."""
    local = part.get('local') or I16
    link = None
    frame = 'robot'
    if part.get('frame') == 'attachment':
        f = frames[attach_at]
        link, frame, local = f['link'], 'link', _mul(f['local'], local)
    out = []
    for m in part['meshes']:
        if not m.get('file'):
            continue                                   # print-only: nothing to draw
        pr = m.get('print')
        shared = bool(pr) and pr.startswith('part:')
        printable = m.get('printable', not m.get('hardware') and not shared)
        c = {'id': m.get('component') or '%s_%s' % (part['id'], m['id']), 'label': m.get('label') or m['id'],
             'link': link, 'group': 'upgrade', 'slot': part.get('slot'),
             'mesh': prefix + m['file'], 'frame': frame, 'local': list(local),
             'color': m.get('color') or '#9aa3ad', 'printable': bool(printable),
             'print_file': (prefix + pr) if pr and not shared else None,
             'print_name': m.get('print_name'), 'source': part.get('source'),
             'note': m.get('note'), 'hidden_by_default': not default_on,
             'part_of': part['id'], 'part_mesh': m['id']}
        for k in ('print_transform', 'print_fit_rmse_mm', 'print_fit_worst_mm', 'print_bbox_mm',
                  'print_fit_note', 'faces'):
            if m.get(k) is not None:
                c[k] = m[k]
        out.append(c)
    return out


def resolve_slots(doc, parts, robot_id, frames, attach_at, part_prefix):
    """Expand part options into `kind: parts`, merge `rules`, list matching parts."""
    rules = {}
    for r in doc.get('rules') or []:
        rules.setdefault((r['slot'], r['option']), {}).update(r['requires'])
    comps, used = [], {}
    slots = {}
    default = doc.get('default_design') or {}
    for sid, raw in (doc.get('slots') or {}).items():
        s = {k: copy.deepcopy(v) for k, v in raw.items() if k != 'options'}
        named = {option_ref(o)[1] for o in raw.get('options') or [] if option_ref(o)}
        extra = [pid for pid, p in parts.items() if p.get('slot') == sid and pid not in named
                 and p.get('robot') in (None, robot_id)]
        specs = list(raw.get('options') or [])
        at = max([i + 1 for i, o in enumerate(specs) if option_ref(o)] or [0])
        specs[at:at] = extra
        opts, covers = [], []
        for o in specs:
            ref = option_ref(o)
            if ref is None:
                opt = copy.deepcopy(o)
            else:
                oid, pid = ref
                part = parts.get(pid)
                if part is None:
                    continue
                on = s.get('default') == oid or default.get(sid) == oid
                pc = part_components(part, frames, attach_at, on, part_prefix(pid))
                comps.extend(pc)
                used[pid] = part
                covers.extend(c['id'] for c in pc)
                opt = {'id': oid, 'label': part['label'], 'kind': 'parts',
                       'parts': [c['id'] for c in pc], 'frame': part.get('frame', 'robot')}
                if part.get('cameras'):
                    opt['cameras'] = copy.deepcopy(part['cameras'])
                opt.update({'from': 'assets/parts/%s/' % pid, 'source': part.get('source'),
                            'part': pid})
                if part.get('notes'):
                    opt['note'] = part['notes']
            req = rules.get((sid, opt['id']))
            if req:
                opt['requires'] = copy.deepcopy(req)
            opts.append(opt)
        s['covers'] = covers + list(raw.get('covers') or [])
        s['options'] = opts
        slots[sid] = s
    for pid, p in parts.items():                       # print-only kit parts ride along
        if p.get('slot') is None and p.get('robot') == robot_id:
            used.setdefault(pid, p)
    return slots, comps, used


def resolve(doc, load_robot, parts, rel_robot, rel_part):
    """The flat robot@1 form of `doc`.  `load_robot(id)` returns a raw robot.json; `rel_robot(id)`
    and `rel_part(id)` are the path prefixes from this composition's folder to theirs."""
    if doc.get('schema') != ROBOT2:
        return doc
    base = resolve(load_robot(doc['base']), load_robot, parts, rel_robot, rel_part)
    pre = rel_robot(doc['base'])
    hide = set(doc.get('hide') or [])
    out = {k: copy.deepcopy(v) for k, v in doc.items()
           if k not in ('base', 'attach', 'hide', 'hide_note', 'rules')}
    out['schema'] = 'rps/robot@1'
    out['source'] = dict(base.get('source') or {}, **(doc.get('source') or {}))
    for k in ('units', 'up', 'frame', 'bed'):
        out.setdefault(k, copy.deepcopy(base.get(k)))
    out['composition'] = {'base': doc['base'], 'hide': list(doc.get('hide') or []),
                          'hide_note': doc.get('hide_note')}
    atts = []
    for a in doc.get('attach') or []:
        e = {'package': a['robot'], 'at': a['at'], 'local': a.get('local') or I16}
        if a.get('note'):
            e['note'] = a['note']
        atts.append(e)
    out['attachments'] = atts
    k = copy.deepcopy(base['kinematics'])
    for key in ('urdf', 'mesh_dir'):
        if k.get(key):
            k[key] = pre + k[key]
    out['kinematics'] = k
    comps = []
    for c in base['components']:
        d = copy.deepcopy(c)
        d['mesh'] = pre + c['mesh']
        d['print_file'] = (pre + c['print_file']) if c.get('print_file') else None
        d['hidden_by_default'] = c['id'] in hide
        comps.append(d)
    frames = dict(copy.deepcopy(base.get('frames') or {}), **copy.deepcopy(doc.get('frames') or {}))
    out['frames'] = frames
    own = {c['id']: c for c in doc.get('cameras') or []}
    cams = [copy.deepcopy(own.pop(c['id'], c)) for c in base.get('cameras') or []]
    out['cameras'] = cams + [copy.deepcopy(c) for c in own.values()]
    at = atts[0]['at'] if atts else None
    slots, pcomps, used = resolve_slots(doc, parts, doc['id'], frames, at, rel_part)
    out['components'] = comps + pcomps
    out['slots'] = slots
    out['parts'] = copy.deepcopy(used)
    for key in ('presets', 'presets_source'):
        if key not in doc and key in base:
            out[key] = copy.deepcopy(base[key])
    return out


def resolve_dir(robots_dir, parts_dir, robot_id):
    """Resolve assets/robots/<robot_id>/robot.json against its sibling robots and the parts."""
    load = lambda rid: json.load(open(os.path.join(robots_dir, rid, 'robot.json'), encoding='utf-8'))  # noqa: E731
    here = os.path.join(robots_dir, robot_id)
    rel_part = lambda pid: os.path.relpath(os.path.join(parts_dir, pid), here) + '/'  # noqa: E731
    return resolve(load(robot_id), load, load_parts(parts_dir), lambda rid: '../%s/' % rid, rel_part)


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] != '--json':
        sys.exit('usage: resolve.py --json <robot id>')
    ASSETS = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'assets'))
    json.dump(resolve_dir(os.path.join(ASSETS, 'robots'), os.path.join(ASSETS, 'parts'), sys.argv[2]), sys.stdout)
