"""The floor (world frame, mm): seamless sheet vinyl in 2 m rolls with 3 mm weld rods, 50 mm yellow
lane tape on the P1, P2/P4 and P5 routes in butt-jointed lengths, white park "T"s, 75 mm 45° hazard
tape along each plinth's route-facing side with 300 mm returns, and 60 mm stencil station labels.
Tape is 0.3 mm thick and never overlaps: a lane stops 0.5 mm short of a crossing lane, a park T or a hazard
band (a butt joint), so no two tape tops are coplanar.  Nothing else is on the floor."""
import math

import numpy as np

import _bl as B
import _kit as K

ROLE = "room"
X0, X1, Y0, Y1 = -2100.0, 2300.0, -1500.0, 1950.0
TAPE, LANE, RUN = 0.3, 50.0, 1200.0
LANES = [((-900, 490), (900, 490)), ((0, 55), (0, 650)), ((-740, 490), (0, 0))]     # a later lane stops at an earlier
LABEL = {"lh": "S1 BUILD", "inc": "S2 INCUBATE", "reader": "S3 READ"}


def quad(a, b, w, gap=0.0):
    """the CCW outline of a strip from a to b (xy), w wide, shortened by gap/2 at both ends"""
    a, b = np.array(a, float), np.array(b, float)
    t = (b - a) / np.linalg.norm(b - a)
    n = np.array([-t[1], t[0]])
    a, b = a + t * gap / 2, b - t * gap / 2
    return [tuple(a - n * w / 2), tuple(b - n * w / 2), tuple(b + n * w / 2), tuple(a + n * w / 2)]


def clip(poly, p, q):
    """the part of a convex polygon left of the directed line p -> q"""
    side = lambda v: (q[0] - p[0]) * (v[1] - p[1]) - (q[1] - p[1]) * (v[0] - p[0])
    out = []
    for i, a in enumerate(poly):
        b = poly[(i + 1) % len(poly)]
        sa, sb = side(a), side(b)
        if sa >= 0:
            out.append(a)
        if (sa >= 0) != (sb >= 0):
            k = sa / (sa - sb)
            out.append((a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k))
    return out


def grow(poly, d):
    """a CCW convex polygon moved out by d along each edge normal"""
    P = np.array(poly, float)
    n = len(P)
    out = []
    for i in range(n):
        a, b, c = P[i - 1], P[i], P[(i + 1) % n]
        n0 = np.array([(b - a)[1], -(b - a)[0]]) / np.linalg.norm(b - a)
        n1 = np.array([(c - b)[1], -(c - b)[0]]) / np.linalg.norm(c - b)
        m = n0 + n1
        out.append(tuple(b + m * d / max(float(m @ n0), 1e-6)))
    return out


def minus(poly, cut):
    """convex pieces of poly outside the convex CCW polygon cut"""
    pieces, rest = [], poly
    for i in range(len(cut)):
        p, q = cut[i], cut[(i + 1) % len(cut)]
        out = clip(rest, q, p)
        if len(out) >= 3 and abs(area(out)) > 1.0:
            pieces.append(out)
        rest = clip(rest, p, q)
        if len(rest) < 3:
            break
    return pieces


def area(P):
    return 0.5 * sum(P[i][0] * P[(i + 1) % len(P)][1] - P[(i + 1) % len(P)][0] * P[i][1] for i in range(len(P)))


def lanes(cuts):
    """butt-jointed tape lengths of at most RUN, 1 mm apart, each stopping 0.5 mm short of what is in cuts
    and of every earlier lane"""
    out, cuts = [], [grow(c, 0.5) for c in cuts]
    for a, b in LANES:
        a, b = np.array(a, float), np.array(b, float)
        n = max(1, int(math.ceil(np.linalg.norm(b - a) / RUN)))
        mine = [[quad(a + (b - a) * k / n, a + (b - a) * (k + 1) / n, LANE, 1.0)] for k in range(n)]
        for pieces in mine:
            for c in cuts:
                pieces[:] = [q for p in pieces for q in minus(p, c)]
            out += [K.prism(p, 0, TAPE, "hazard_yellow", 0, 0) for p in pieces]
        cuts.append(grow(quad(a, b, LANE), 0.5))
    return out


def hazard(x0, x1, y0, y1, pitch=100.0):
    """75 mm hazard tape: yellow base, black 45° bands on top"""
    P = [K.span(x0, x1, y0, y1, 0, TAPE, "hazard_yellow", 0, 0)]
    along_x = (x1 - x0) >= (y1 - y0)
    L, h = (x1 - x0, y1 - y0) if along_x else (y1 - y0, x1 - x0)
    s = -h
    while s < L:
        q = [(s, 0), (s + pitch / 2, 0), (s + pitch / 2 + h, h), (s + h, h)]
        q = clip(clip(q, (0, 1), (0, 0)), (L, 0), (L, 1))
        if len(q) >= 3 and max(u for u, _ in q) - min(u for u, _ in q) > 1:
            poly = [(x0 + u, y0 + v) for u, v in q] if along_x else [(x0 + v, y0 + u) for u, v in q]
            if not along_x:
                poly = poly[::-1]
            P.append(K.prism(poly, TAPE, TAPE + 0.05, "hazard_black", 0, 0))
        s += pitch
    return P


def station_marks(ctx, st):
    """in the station frame: the park T, the hazard band and its returns, the stencil label; returns the parts
    and the world outlines of the tape the lanes stop at"""
    w = st["w"]
    rects = [(-150, 150, -280, -240, "tape_white"), (-20, 20, -440, -281, "tape_white")]
    P = [K.span(x0, x1, y0, y1, 0, TAPE, key, 0, 0) for x0, x1, y0, y1, key in rects]
    bands = [(-w / 2 - 75, w / 2 + 75, -75, 0), (-w / 2 - 75, -w / 2, 0.5, 300), (w / 2, w / 2 + 75, 0.5, 300)]
    for b in bands:
        P += hazard(*b)
    P.append(K.text(LABEL.get(st["id"], st["id"].upper()), 60, "tape_white", bold=True, web_keep=True).moved(K.rot("z", 0), (190, -200, TAPE + 0.1)))
    yaw, (ox, oy) = st["yaw"], st["origin"]
    R = K.rot("z", yaw)[:2, :2]
    world = lambda x, y: tuple(R @ (x, y) + (ox, oy))
    cuts = [[world(x0, y0), world(x1, y0), world(x1, y1), world(x0, y1)] for x0, x1, y0, y1, *_ in rects + bands]
    return [p.moved(K.rot("z", yaw), (ox, oy, 0)) for p in P], cuts


def build(ctx):
    m = B.Model(ctx, ctx.name)
    xs = [X0] + [x for x in np.arange(-1100, X1, 2000)] + [X1]
    for x0, x1 in zip(xs[:-1], xs[1:]):
        m.add(K.span(x0 + 1.5, x1 - 1.5, Y0, Y1, -10, 0, "floor_vinyl", 0, 0))
    for x in xs[1:-1]:
        m.add(K.span(x - 1.5, x + 1.5, Y0, Y1, -10, 0.05, "floor_seam", 0, 0))
    tape, cuts = [], []
    for s in ctx.lab["stations"]:
        P, C = station_marks(ctx, B.station(ctx, s["id"]))
        tape += P
        cuts += C
    m.add(*tape, *lanes(cuts), sub="tape")
    return m.finish()
