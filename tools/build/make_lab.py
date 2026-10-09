#!/usr/bin/env python3
"""Generate the lab decor meshes into assets/scenes/lab/props/*.obj (visual only, mm).

    uv run --extra sim python tools/build/make_lab.py [--out <dir>]

Each file is one material.  Station meshes are in their station frame (x right, +y into the
station) with z = 0 at the deck T; plinth-front and floor meshes have z = 0 at the floor.  Nest
collars, keep-out bands and labels are sized from scene.json.  A decal stands LIFT (1.2 mm) proud
of the face it is on, so no renderer's depth buffer mixes the two.  The room props are in lab/room.py.
Output is byte-identical on a re-run.  Budget: 60 000 triangles.
"""
import argparse
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lab.mesh import (Mesh, box, cyl, cyl_between, disc, extrude, moved, rbox, revolve, ring, rot, text,  # noqa: E402
                      write_obj)
from lab.room import room_props  # noqa: E402

STUDIO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LAB = os.path.join(STUDIO, 'assets', 'scenes', 'lab')
BUDGET = 60000
FACE_Y = rot('x', 90)                                # a flat XY part turned to face -y
LIFT = 1.2                                           # decal over its surface, mm


def hinged(mesh, hinge, deg):
    """`mesh` turned by deg about the local +x line through hinge (y, z)."""
    R, h = rot('x', deg), np.array([0.0, hinge[0], hinge[1]])
    return moved(moved(mesh, None, -h), R, h)


def square_frame(r_in, r_out, z0, z1, top_in=None):
    """A square frame, flats at r_in / r_out; the inner top edge at top_in (a chamfer to z1)."""
    s = math.sqrt(2)
    ti = z1 if top_in is None else top_in
    return revolve([(r_out * s, z0), (r_out * s, z1), (r_in * s, ti), (r_in * s, z0), (r_out * s, z0)], 4, 45, 405)


def nest(D, ch):
    """The anodised pocket: the collar with its 45° lead-in (as the collision fixture) and a flange."""
    ri, t, lead = D['inner'] / 2, D['wall'], D['lead']
    return Mesh().add(square_frame(ri, ri + t, 0, ch + lead, ch)).add(square_frame(ri + t, ri + t + 11, 0, 1.5))


def tag_cells(bits):
    """The white data cells of a 4 x 4 fiducial on a 60 mm tag (10 mm cells), facing -y."""
    m = Mesh()
    for i, row in enumerate(bits):
        for j, b in enumerate(row):
            if b == '1':
                m.add(box((10, 10, LIFT), (-15 + 10 * j, 15 - 10 * i, LIFT / 2)))
    return m


TAGS = {'lh': ['1011', '0110', '1100', '0101'], 'inc': ['0110', '1011', '0011', '1101'], 'reader': ['1101', '0100', '1011', '0110']}


def stripes(x0, x1, y0, y1, pitch=100, w=50):
    """45° black stripes inside the rectangle, as convex quads clipped to it."""
    m, h = Mesh(), y1 - y0
    x = x0 - h
    while x < x1:
        q = [(x, y0), (x + w, y0), (x + w + h, y1), (x + h, y1)]
        q = [(min(max(a, x0), x1), b) for a, b in q]
        if max(a for a, _ in q) - min(a for a, _ in q) > 1:
            m.add(extrude(q, 0, LIFT))
        x += pitch
    return m


def keepout(w, d, band=100):
    """The yellow band 100 mm around a plinth (floor to LIFT, level with the lanes) and its black
    stripes on top (LIFT to 2 LIFT); station frame, floor."""
    yellow, black = Mesh(), Mesh()
    sides = [(-w / 2 - band, w / 2 + band, -band, 0), (-w / 2 - band, w / 2 + band, d, d + band),
             (-w / 2 - band, -w / 2, 0, d), (w / 2, w / 2 + band, 0, d)]
    for i, (a, b, c, e) in enumerate(sides):
        yellow.add(box((b - a, e - c, LIFT), ((a + b) / 2, (c + e) / 2, LIFT / 2)))
        if i < 2:
            black.add(stripes(a, b, c, e), None, (0, 0, LIFT))
        else:                                        # a side band: stripes along y
            black.add(moved(stripes(c, e, a, b), np.array([[0, 1, 0], [1, 0, 0], [0, 0, -1]]), (0, 0, 2 * LIFT)))
    return yellow, black


def liquid_handler():
    """A Flex-like cabinet: white frame, smoked glass, a deck with labware, rails; the gantry apart."""
    white, glass, grey, alu, rack, tips, wells, head = (Mesh() for _ in range(8))
    white.add(rbox(820, 420, 90, 24, (0, 350, 0))).add(rbox(820, 420, 60, 24, (0, 350, 560)))
    for x in (-390, 390):
        for y in (160, 540):
            white.add(rbox(40, 40, 470, 12, (x, y, 90)))
    white.add(box((740, 12, 470), (0, 552, 325)))
    glass.add(box((740, 6, 470), (0, 143, 325)))
    for x in (-405, 405):
        glass.add(box((6, 340, 470), (x, 350, 325)))
    grey.add(box((760, 360, 10), (0, 350, 95)))
    for y in (172, 528):
        alu.add(box((760, 24, 16), (0, y, 548)))
    # labware on a 3 x 4 SBS grid, deck top z 100
    for x, y, n in ((-260, 485, 96), (-260, 395, 48)):
        rack.add(box((122, 82, 55), (x, y, 127.5)))
        for k in range(n):
            i, j = divmod(k, 12)
            tips.add(revolve([(3.0, 155), (2.6, 162), (0, 162)], 6), None, (x - 49.5 + 9 * j, y + 31.5 - 9 * i, 0))
    for x, y in ((0, 305), (260, 485), (260, 305)):
        z = 118 if (x, y) == (260, 305) else 100
        rack.add(box((127, 85, 14), (x, y, z + 7)))
        for k in range(96):
            i, j = divmod(k, 12)
            wells.add(disc(3.2, 8, (x - 49.5 + 9 * j, y + 31.5 - 9 * i, z + 14 + LIFT)))
    grey.add(rbox(140, 100, 18, 6, (260, 305, 100)))                      # a heater-shaker under a plate
    rack.add(box((127, 85, 30), (0, 485, 115)))                           # a reservoir
    grey.add(box((110, 70, 4), (0, 485, 131)))
    # the gantry: a Y beam on two carriages, and the 8-channel head
    gantry = Mesh().add(box((44, 380, 28), (0, 350, 515)))
    for y in (172, 528):
        gantry.add(box((70, 40, 30), (0, y, 530)))
    head.add(rbox(64, 76, 120, 10, (0, 320, 380))).add(box((50, 20, 16), (0, 320, 500)))
    for k in range(8):
        head.add(cyl(2.6, 352, 380, 8), None, (-24.5 + 7 * k, 320, 0))
    grey.add(box((16, 16, 40), (330, 128, 520)))                         # the touchscreen arm
    return {'lh_white': white, 'lh_glass': glass, 'lh_grey': grey, 'lh_alu': alu, 'lh_labware': rack,
            'lh_tips': tips, 'lh_wells': wells, 'lh_gantry': gantry, 'lh_head': head}


def incubator(lid_deg):
    """A compact 37 °C incubator: a white body with a front step, hinge knuckles, a grey lid
    (modelled OPEN: the closed lid turned by -lid_deg about the hinge) and a progress ring."""
    body, knuckle = Mesh(), Mesh()
    body.add(rbox(300, 52, 100, 10, (0, 136, 0))).add(rbox(300, 240, 190, 20, (0, 280, 0)))
    for s in (-1, 1):
        knuckle.add(box((30, 14, 12), (s * 80, 115, 106)))
        knuckle.add(cyl_between((s * 65, 115, 118), (s * 95, 115, 118), 7, 20))
    lid = Mesh().add(rbox(200, 120, 24, 8, (0, 55, 112))).add(box((110, 6, 8), (0, -7, 124)))
    lid.add(cyl_between((-60, 115, 118), (60, 115, 118), 7, 20))
    ring_m = moved(Mesh().add(ring(13, 19, 0, 2, 40)), FACE_Y, (95, 110, 50))
    temp = moved(text("37.0'C", 7, t=0, lift=LIFT, align='center'), FACE_Y, (-95, 108.8, 43))
    return {'inc_body': body, 'inc_knuckle': knuckle, 'inc_lid': hinged(lid, (115, 118), -lid_deg),
            'inc_ring': ring_m, 'inc_temp': temp}


def reader(hood_deg):
    """A 4-position tube fluorometer: grey body with a low bezel, optics port, a smoked hood
    (modelled OPEN) with its inner glow plate."""
    body, knuckle, optics = Mesh(), Mesh(), Mesh()
    body.add(rbox(360, 44, 134, 10, (0, 131, 0))).add(rbox(360, 270, 220, 16, (0, 285, 0)))
    for s in (-1, 1):
        knuckle.add(cyl_between((s * 62, 115, 140), (s * 86, 115, 140), 6, 20))
    optics.add(moved(Mesh().add(cyl(16, 0, 3, 32)), FACE_Y, (0, 110, 60)))
    arc = [(115 - 120 * math.cos(math.radians(a)), 140 - 120 * math.sin(math.radians(a))) for a in range(0, 91, 10)]
    hood = Mesh().add(box((190, 120, 6), (0, 55, 143))).add(box((190, 4, 12), (0, -3, 134)))
    for x0 in (-95, 89):                             # quarter-disc side panels about the hinge, (y, z) -> x
        V, F = extrude([(115, 140)] + arc, x0, x0 + 6)
        hood.add((V[:, [2, 0, 1]], F))
    glow = Mesh().add(box((120, 90, 2), (0, 55, 138)))
    labels = Mesh()
    for k in range(4):
        labels.add(moved(text(str(k + 1), 6, t=0, lift=0.5, align='center'), FACE_Y, (110 + 17 * k, 147.5, 142)))
    return {'reader_body': body, 'reader_knuckle': knuckle, 'reader_optics': optics,
            'reader_hood': hinged(hood, (115, 140), -hood_deg), 'reader_glow': hinged(glow, (115, 140), -hood_deg),
            'reader_labels': labels}


def station_floor(scene):
    """Per station: keep-out band and stripes, the tag cells, and the floor label."""
    out, names = {}, {'lh': 'S1 BUILD', 'inc': 'S2 INCUBATE', 'reader': 'S3 READ'}
    for st in scene['stations']:
        w, d = st['plinth']
        y, k = keepout(w, d)
        out['keepout_%s' % st['id']], out['stripes_%s' % st['id']] = y, k
        out['tag_%s' % st['id']] = moved(tag_cells(TAGS.get(st['id'], TAGS['lh'])), FACE_Y, (0, 5.3, 130))
        out['label_%s' % st['id']] = text(names.get(st['id'], st['id'].upper()), 70, t=0, lift=1.2)
    return out


def tube_label(r_wall, z0, z1, wrap=220.0, gap=0.1, t=0.08):
    """A printed label on a tube: a thin partial wrap `gap` mm off the wall, centred on +x."""
    r0 = r_wall + gap
    return Mesh().add(revolve([(r0, z1), (r0, z0), (r0 + t, z0), (r0 + t, z1)], 44, -wrap / 2, wrap / 2))


def props(scene):
    D = scene['defaults']['nest']
    out = {}
    for ch in sorted({st['nest']['collar_h'] for st in scene['stations']}):
        out['nest_%d' % ch] = nest(D, ch)
    kinds = {st['kind']: st for st in scene['stations']}
    out.update(liquid_handler())
    out.update(incubator(kinds['incubator']['lid']['closed_deg']))
    out.update(reader(kinds['reader']['lid']['closed_deg']))
    out.update(station_floor(scene))
    out.update(room_props())
    # the puck's tube labels (tube wall r 5.4): a white label and a candidate-colour band over it
    out['tube_label'] = tube_label(5.4, 0, 5.0)
    out['tube_band'] = tube_label(5.4, 5.0, 6.0)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--out', default=os.path.join(LAB, 'props'))
    a = ap.parse_args()
    with open(os.path.join(LAB, 'scene.json'), encoding='utf-8') as fh:
        scene = json.load(fh)
    os.makedirs(a.out, exist_ok=True)
    for f in os.listdir(a.out):
        if f.endswith('.obj'):
            os.remove(os.path.join(a.out, f))
    total, P = 0, props(scene)
    for name, mesh in sorted(P.items()):
        n = write_obj(os.path.join(a.out, name + '.obj'), mesh)
        total += n
        print('  %-20s %6d triangles' % (name, n))
    print('%d meshes, %d triangles (budget %d) -> %s' % (len(P), total, BUDGET, os.path.relpath(a.out, STUDIO)))
    return 1 if total > BUDGET else 0


if __name__ == '__main__':
    sys.exit(main())
