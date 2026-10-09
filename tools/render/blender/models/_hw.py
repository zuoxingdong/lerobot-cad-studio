"""Hardware and details for the lab models, built from _kit parts (mm): wraps onto cylinders, hinges,
screws, feet, handles, LED channels, labels, grilles, fiducials and matrix codes."""
import math

import numpy as np

from _kit import (EMPTY, Part, cat, chamfered, circle, fillet_path, lathe, nseg, plate_holes, prism, rot, rrect,
                  span, stadium, sweep, web, cyl)


def hinged(part, y, z, deg):
    """a part turned by deg about the local +x line through (y, z)"""
    return part.moved(t=(0, -y, -z)).moved(rot("x", deg), (0, y, z))


def flipped(p):
    """the same part with its faces wound the other way"""
    L, i = p.L.copy(), 0
    for c in p.C:
        L[i:i + c] = L[i:i + c][::-1]
        i += c
    return Part(p.V, L, p.C, p.K)


def wrap_cyl(part, r):
    """bend a part given as (u = arc length, w = radial offset, z) onto a cylinder of radius r about
    +z, u = 0 at azimuth 0, u increasing CCW"""
    V = part.V
    a = V[:, 0] / r
    rr = r + V[:, 1]
    return flipped(Part(np.stack([rr * np.cos(a), rr * np.sin(a), V[:, 2]], 1), part.L, part.C, part.K))


def to_wrap(part, z, w):
    """an XY part (text, a code) as (u, w, z) for wrap_cyl: its +z normal becomes the radial"""
    V = part.V
    return flipped(Part(np.stack([V[:, 0], w + V[:, 2], z + V[:, 1]], 1), part.L, part.C, part.K))


def screw(d=3.0, key="steel", recess="tag_black", flat=False):
    """a button (or countersunk-flush) head on +z at z = 0, recess dark; skipped on web"""
    if web():
        return EMPTY
    r = d * 0.95
    if flat:
        head = lathe([(0, -0.3), (r, -0.3), (r, 0.0), (d * 0.45, 0.0), (d * 0.45, -0.2), (0, -0.2)], 16, key)
    else:
        h = d * 0.45
        head = lathe([(0, 0), (r, 0), (r, h * 0.35), (r * 0.8, h * 0.85), (d * 0.45, h), (d * 0.45, h - 0.4), (0, h - 0.4)], 16, key)
    return head


def foot_levelling(d=40.0, h=60.0, key_pad="rubber", key_metal="steel"):
    """a levelling foot: rubber pad, steel disc, hex nut and threaded stem, floor at z = 0"""
    parts = [lathe(chamfered(d / 2, 0, 6, 1.0), nseg(32), key_pad),
             lathe(chamfered(d / 2 - 2, 6, 11, 0.8), nseg(32), key_metal),
             prism(circle(d * 0.28, 6, a0=math.pi / 6), 11, 21, key_metal, bev=0.6, seg=1),
             cyl(d * 0.2, 21, h, key_metal, 16, bev=0.3)]
    return cat(parts)


def foot_rubber(d=24.0, h=10.0, key="rubber"):
    return lathe([(0, 0), (d / 2 - 1.5, 0), (d / 2, 1.5), (d / 2 - 0.5, h), (0, h)], nseg(24), key)


def handle_d(centres=128.0, dia=10.0, standoff=32.0, key="steel_brushed"):
    """a D pull on the XZ plane of a -y face: legs along -y from y = 0, bar along x"""
    c = centres / 2
    path = fillet_path([(-c, 0, 0), (-c, -standoff, 0), (c, -standoff, 0), (c, 0, 0)], dia * 1.2, 5)
    return sweep(path, dia / 2, key, 12)


def led_bar(w, h, key_led, key_housing="alu", depth=4.0, lip=3.0):
    """an opal LED channel on a -y face: housing proud by depth, diffuser inset 0.5, at x/z centred 0"""
    hs = span(-w / 2 - lip, w / 2 + lip, -depth, 0, -h / 2 - lip, h / 2 + lip, key_housing, bev=0.8, seg=2)
    df = span(-w / 2, w / 2, -depth - 0.2, -depth + 1.0, -h / 2, h / 2, key_led, bev=0.4, seg=1)
    return hs, df


def label_plate(w, h, key="label", t=0.15):
    return span(-w / 2, w / 2, -t, 0, -h / 2, h / 2, key, bev=0.05, seg=1, web_keep=True)


def slots_grille(w, h, n, sw, sh, key, key_back="tag_black", t=1.5, back=6.0, horizontal=True):
    """a panel w x h (XY plane, z 0..t) with n stadium slots, and a dark back plate `back` below"""
    holes = []
    for k in range(n):
        if horizontal:
            cy = -h / 2 + h * (k + 0.5) / n
            holes.append(list(reversed(stadium(sw, sh, 0, cy))))
        else:
            cx = -w / 2 + w * (k + 0.5) / n
            holes.append(list(reversed(stadium(sh, sw, cx, 0))))
    return cat([plate_holes(rrect(w, h, 2.0, 3), holes, 0, t, key),
                span(-w / 2 + 1, w / 2 - 1, -h / 2 + 1, h / 2 - 1, -back, -back + 0.5, key_back, bev=0, seg=0)])


def fiducial(bits, cell=10.0, key_w="tag_white", key_b="tag_black", lift=0.12):
    """a square tag of len(bits) data cells in a one-cell black border, XY plane, top at z = lift"""
    n = len(bits)
    s = (n + 2) * cell
    P = [span(-s / 2, s / 2, -s / 2, s / 2, 0, lift * 0.5, key_b, bev=0, seg=0)]
    for i, row in enumerate(bits):
        for j, b in enumerate(row):
            if b == "1":
                x0, y0 = -s / 2 + (j + 1) * cell, s / 2 - (i + 2) * cell
                P.append(span(x0, x0 + cell, y0, y0 + cell, 0, lift, key_w, bev=0, seg=0))
    return cat(P)


def matrix_code(n, mod, seed, key, lift=0.05):
    """a pseudo DataMatrix: a solid L finder and a deterministic dot field, XY plane"""
    rng = np.random.default_rng(seed)
    P = []
    for i in range(n):
        for j in range(n):
            on = j == 0 or i == n - 1 or (i == 0 and j % 2 == 0) or (j == n - 1 and i % 2 == 1) or rng.random() < 0.45
            if on:
                P.append(span(j * mod, (j + 1) * mod, i * mod, (i + 1) * mod, 0, lift, key, bev=0, seg=0))
    return cat(P).moved(t=(-n * mod / 2, -n * mod / 2, 0))


