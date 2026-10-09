"""A work spot in use on the back bench (world frame, mm, top at 900): an open lab notebook with a
written page and a pen on it, a pair of used nitrile gloves beside it, and a lab coat dropped on the
tucked-in stool (a folded bundle on the seat, the front panel and one sleeve hanging clear of the foot ring)."""
import math

import numpy as np

import _bl as B
import _hw as H
import _kit as K
from room import drape

ROLE = "dressing"
Z = 900.0
STOOL = (-1250.0, 1520.0, 652.0)          # bench.py's stool: centre, seat top


def hsh(k):
    """a deterministic 0..1 from an int"""
    return (math.sin(k * 12.9898) * 43758.5453) % 1.0


PAGE = [(3, 2.2), (146, 2.2), (147, 5.6), (132, 6.9), (90, 7.6), (40, 7.6), (14, 6.6), (5, 4.4), (3, 3.2)]


def page_z(x):
    top = PAGE[2:][::-1]
    return float(np.interp(abs(x), [p[0] for p in top], [p[1] for p in top]))


def ink_line(x0, x1, y, key, w=1.1):
    """a written line following the page curl, in 18 mm pieces"""
    n = max(1, int(math.ceil((x1 - x0) / 18)))
    xs = np.linspace(x0, x1, n + 1)
    return [K.span(a, b, y - w / 2, y + w / 2, page_z((a + b) / 2) + 0.02, page_z((a + b) / 2) + 0.08, key, 0, 0)
            for a, b in zip(xs[:-1], xs[1:])]


def notebook(cx, cy, yaw):
    """an A5 hardcover notebook open flat, spine along y; the left page full, the right half written"""
    P = [K.span(-152, 152, -107, 107, 0, 2.2, "polymer_black", 0.8, 2)]
    for s in (-1, 1):
        P.append(K.prism([(s * x, z) for x, z in PAGE], -102, 102, "paper", bev=0.6, seg=1).moved(K.rot("x", 90)))
    for r in range(17):
        y = 88 - 10.4 * r
        P += ink_line(-138, -138 + 50 + 60 * hsh(r), y, "label_ink")
    P += ink_line(-138, -60, 98, "polymer_blue", 1.4)
    for r in range(8):
        y = 88 - 10.4 * r
        P += ink_line(22, 22 + 40 + 70 * hsh(40 + r), y, "label_ink")
    for k, h in enumerate((10, 16, 30, 13)):             # a small hand-drawn bar plot under the notes
        x = 30 + 16 * k
        P += [K.span(u - 0.5, u + 0.5, -10 - h, -10, page_z(u) + 0.02, page_z(u) + 0.08, "label_ink", 0, 0) for u in (x - 5, x + 5)]
        P += ink_line(x - 5, x + 5, -10 - h, "label_ink", 1.0)
    P += ink_line(20, 100, -42, "label_ink", 1.0)
    P += [p.moved(K.rot("z", -34), (70, -40, 12.2)) for p in pen()]
    return [p.moved(K.rot("z", yaw), (cx, cy, Z)) for p in P]


def pen():
    """a click ballpoint lying along +x, its clip to +y"""
    P = [K.lathe([(0, 0), (0.6, 0), (1.3, 3), (3.6, 12), (0, 12)], K.nseg(16), "steel"),
         K.lathe([(0, 12), (3.6, 12), (4.6, 16), (4.6, 118), (4.1, 122), (0, 122)], K.nseg(20), "polymer_black"),
         K.lathe([(0, 122), (2.6, 122), (2.6, 129), (2.0, 130), (0, 130)], K.nseg(12), "polymer_blue"),
         K.span(-1.2, 1.2, 4.2, 5.8, 82, 119, "polymer_blue", 0.5, 1)]
    return [p.moved(K.rot("y", 90), (-65, 0, 0)) for p in P]


def flat(p, s=0.55, lift=0.0):
    return p.moved(np.diag([1.0, 1.0, s]), (0, 0, lift))


FINGERS = [(-33, 70, 8.0, 0.10), (-11, 79, 8.4, 0.04), (11, 73, 8.2, -0.03), (33, 57, 7.4, -0.12)]


def glove(cx, cy, yaw, mirror=False, curl=1.0):
    """a used nitrile glove lying flat, fingers along +y, the thumb to -x (+x mirrored), a beaded cuff"""
    P = [K.prism(K.rrect(92, 104, 30, 6, 0, 0), 0, 9.5, "nitrile", bev=4.0, seg=2),
         K.prism(K.rrect(84, 76, 10, 4, 0, -86), 0, 5.5, "nitrile", bev=2.4, seg=2),
         flat(K.bar((-42, -124, 0), (42, -124, 0), 3.2, "nitrile", 10), 0.8, 2.6)]
    for x, ln, r, bend in FINGERS:
        a, b = np.array([x, 40.0, 0]), np.array([x + ln * math.sin(bend * curl), 40 + ln * math.cos(bend * curl), 0])
        m = (a + b) / 2 + np.array([ln * 0.06 * (1 if x < 0 else -1), 0, 0])
        P.append(flat(K.sweep(K.fillet_path([a, m, b], 30, 4), r, "nitrile", 12), 0.55, r * 0.55))
    t = [(-40, -10, 0), (-72, 22, 0), (-86, 52, 0)]
    P.append(flat(K.sweep(K.fillet_path(t, 30, 4), 9.0, "nitrile", 12), 0.55, 5.0))
    if mirror:
        P = [H.flipped(p.moved(np.diag([-1.0, 1.0, 1.0]))) for p in P]
    return [p.moved(K.rot("z", yaw), (cx, cy, Z)) for p in P]


def coat_on_stool():
    """a lab coat dropped on the seat: a folded bundle, the front panel and a sleeve hanging"""
    cx, cy, zs = STOOL
    P = [K.prism(K.rrect(360, 320, 70, 6, 0, -25), 0, 26, "fabric_white", bev=11.0, seg=3).moved(K.rot("z", 12), (cx, cy, zs - 2)),
         K.prism(K.rrect(290, 190, 60, 6, 10, 20), 0, 20, "fabric_white", bev=9.0, seg=3).moved(K.rot("z", -9), (cx, cy, zs + 20))]
    front = lambda v: float(np.interp(v, (0, 0.3, 1), (118, 128, 140)))  # noqa: E731
    P.append(drape(front, 235, 15, 3.0, 12, 0.7, "fabric_white").moved(K.rot("z", 180) @ K.rot("y", 5), (cx + 30, cy - 186, zs + 8)))
    P.append(drape(lambda v: 36 + 5 * v, 290, 14, 1.5, 6, 2.2, "fabric_white", 8, 16).moved(K.rot("z", -90) @ K.rot("y", -4), (cx + 187, cy - 70, zs + 4)))
    return P


def build(ctx):
    m = B.Model(ctx, ctx.name)
    m.add(*notebook(-1560, 1305, 6))
    m.add(*glove(-1990, 1330, 8, mirror=True), *glove(-1840, 1325, -14, mirror=True, curl=1.8))
    m.add(*coat_on_stool())
    return m.finish()
