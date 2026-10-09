"""Zone C storage (world frame, mm): a 3-tier stainless wire consumables cart on castors (tip boxes on
top, plate stacks in sleeves, a kraft box with a lifted flap) and the plate-hotel carousel: a square
PC enclosure 560 x 560 x 1400 on a graphite base, 5 SBS racks round a central column, a status bar."""
import math

import numpy as np

import _bl as B
import _hw as H
import _kit as K

ROLE = "dressing"
CART = (-1840.0, -350.0)       # centre; long side along y
HOTEL = (-1805.0, 350.0)


def wire_shelf(z, w=440.0, d=600.0):
    P = [K.sweep([(-w / 2, -d / 2, z), (w / 2, -d / 2, z), (w / 2, d / 2, z), (-w / 2, d / 2, z)], 4.0, "steel_polished", 8, closed=True),
         K.sweep([(-w / 2, -d / 2, z + 25), (w / 2, -d / 2, z + 25), (w / 2, d / 2, z + 25), (-w / 2, d / 2, z + 25)], 2.5, "steel_polished", 6, closed=True)]
    if not K.web():
        for x in np.arange(-w / 2 + 20, w / 2, 20):
            P.append(K.bar((x, -d / 2, z + 1), (x, d / 2, z + 1), 1.6, "steel_polished", 5))
        for y in np.arange(-d / 2 + 100, d / 2, 100):
            P.append(K.bar((-w / 2, y, z - 3), (w / 2, y, z - 3), 2.5, "steel_polished", 6))
    return P


def cart():
    P = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = sx * 205, sy * 285
            P.append(K.cyl(12.5, 90, 1000, "steel_polished", 20, 1.0, at=(x, y)))
            P.append(K.lathe([(0, 0), (12.5, 0), (13.5, 3), (13.5, 10), (0, 12)], K.nseg(20), "black").moved(t=(x, y, 1000)))
            P += [K.span(x - 20, x + 20, y - 20, y + 20, 80, 90, "steel", 1.0, 2),
                  K.lathe([(0, -14), (40, -14), (42, -10), (42, 10), (40, 14), (0, 14)], K.nseg(24), "rubber").moved(K.rot("x", 90), (x, y, 42))]
    for z in (150.0, 500.0, 850.0):
        P += wire_shelf(z)
    for k, col in enumerate(("polymer_blue", "polymer_yellow", "polymer_blue")):
        y = -180 + 140 * k
        P += [K.span(-61, 61, y - 41, y + 41, 852, 902, col, 1.5, 2), K.span(-62, 62, y - 42, y + 42, 902, 916, "plate_clear", 1.5, 2)]
    for k, n in enumerate((6, 9, 4)):
        y = -170 + 150 * k
        P.append(K.span(-66, 66, y - 45, y + 45, 502, 502 + 15 * n, "plate_clear", 1.0, 2))
        P.append(K.span(-67, 67, y - 46, y + 46, 502 + 15 * n - 20, 502 + 15 * n + 2, "polymer_white", 0.5, 1))
    box = [K.span(-120, 120, -250, 0, 152, 400, "cardboard", 1.0, 2), K.span(-120, 120, 0.5, 240, 152, 400, "cardboard", 1.0, 2)]
    flap = K.span(-118, 118, -248, -130, 400, 403, "cardboard", 0.5, 1)
    box.append(H.hinged(flap, -248, 401.5, 110))
    box.append(K.span(-40, 40, -250.3, -250, 250, 300, "label", 0.2, 1))
    P += box
    return [p.moved(t=(CART[0], CART[1], 0)) for p in P]


def hotel():
    s, h = 280.0, 1400.0
    P = [K.span(-s, s, -s, s, 0, 110, "frame_dark", 3.0, 3), K.span(-s, s, -s, s, h - 60, h, "inst_white", 3.0, 3)]
    for sx in (-1, 1):
        for sy in (-1, 1):
            P.append(K.span(sx * s - (30 if sx > 0 else 0), sx * s + (30 if sx < 0 else 0), sy * s - (30 if sy > 0 else 0),
                            sy * s + (30 if sy < 0 else 0), 110, h - 60, "alu", 1.5, 2))
    G = []
    for sx, sy, ax in ((1, 0, "x"), (-1, 0, "x"), (0, 1, "y"), (0, -1, "y")):
        if ax == "x":
            G.append(K.span(sx * s - 3 - (4 if sx > 0 else -4), sx * s - (4 if sx > 0 else -4) + 3, -s + 30, s - 30, 112, h - 62, "glass", 0.8, 2))
        else:
            G.append(K.span(-s + 30, s - 30, sy * s - 3 - (4 if sy > 0 else -4), sy * s - (4 if sy > 0 else -4) + 3, 112, h - 62, "glass", 0.8, 2))
    P.append(K.cyl(30, 110, h - 60, "alu", 32, 1.0))
    for k in range(5):
        a = math.radians(72 * k + 18)
        R, c = K.rot("z", 72 * k + 18), (150 * math.cos(a), 150 * math.sin(a))
        rack = [K.span(-44, 44, -64, 64, 130, 134, "alu", 0.8, 1), K.span(-44, 44, -64, 64, h - 120, h - 116, "alu", 0.8, 1)]
        for sy in (-1, 1):
            rack.append(K.span(-44, 44, sy * 64 - 2, sy * 64 + 2, 130, h - 116, "alu", 0.6, 1))
        for j in range(18):
            if (j * 7 + k * 3) % 11 == 4:
                continue
            z = 150 + 62 * j
            rack.append(K.span(-43, 43, -63, 63, z, z + 14, "polymer_white", 0.6, 2))
        P += [p.moved(R, (c[0], c[1], 0)) for p in rack]
    hs, df = H.led_bar(400, 10, "led_blue", "alu", depth=2.5, lip=2.0)
    P.append(hs.moved(t=(0, -s, h - 30)))
    led = df.moved(t=(0, -s, h - 30))
    P.append(K.span(-60, 60, -s - 0.4, -s, 60, 90, "label", 0.3, 1))
    at = lambda ps: [p.moved(t=(HOTEL[0], HOTEL[1], 0)) for p in ps]
    return at(P), at(G), at([led])


def build(ctx):
    m = B.Model(ctx, ctx.name)
    m.add(*cart())
    P, G, led = hotel()
    m.add(*P)
    m.add(*G, sub="glass")
    m.add(*led, sub="led")
    return m.finish()
