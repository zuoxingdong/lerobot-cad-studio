"""Zone B appliances (world frame, mm): a TSX400-class -80 °C upright freezer (720 x 880 x 1980, white
powder coat, a full-height lever handle, a 7" panel, castors, the frost line at the gasket, a rear vent
grille, inventory stickers, a cord to the wall socket) and two stacked CO2 incubators (637 x 880 x 900
each on a 100 mm roller base; the upper outer door ajar on its glass inner door and polished shelves,
a display per door, gas lines to a wall regulator)."""

import numpy as np

import _bl as B
import _hw as H
import _kit as K

ROLE = "dressing"
FZ = (560.0, 1280.0, 1020.0, 1900.0, 1980.0)       # freezer x0 x1 y0 y1 h
CO = (1560.0, 2197.0, 1020.0, 1900.0)              # CO2 stack x0 x1 y0 y1
WALL = 1950.0


def castor(x, y, h=90.0):
    P = [K.span(x - 30, x + 30, y - 30, y + 30, h - 8, h, "steel", 1.0, 2), K.cyl(6, h - 40, h - 8, "steel", 12, 0.5, at=(x, y)),
         K.lathe([(0, -12), (35, -12), (38, -8), (38, 8), (35, 12), (0, 12)], K.nseg(24), "rubber").moved(K.rot("x", 90), (x, y, 38))]
    return P


def inventory_label(cx, y, cz, l1, l2, seed):
    """a white laminated 80 x 50 inventory label on a -y face: a 1 mm ink border, two text lines, a 10 x 10 code"""
    x0, x1, z0, z1 = cx - 40, cx + 40, cz - 25, cz + 25
    P = [K.span(x0, x1, y - 0.3, y, z0, z1, "tag_white", 0.2, 1)]
    P += [K.span(a, b, y - 0.34, y - 0.3, c, d, "label_ink", 0, 0) for a, b, c, d in
          ((x0 + 2, x1 - 2, z1 - 3, z1 - 2), (x0 + 2, x1 - 2, z0 + 2, z0 + 3), (x0 + 2, x0 + 3, z0 + 2, z1 - 2), (x1 - 3, x1 - 2, z0 + 2, z1 - 2))]
    P.append(K.text(l1, 9, "label_ink", align="LEFT", web_keep=True).moved(K.FACE_Y, (x0 + 6, y - 0.34, z1 - 16)))
    P.append(K.text(l2, 5.5, "label_ink", align="LEFT", web_keep=True).moved(K.FACE_Y, (x0 + 6, y - 0.34, z1 - 26)))
    P.append(H.matrix_code(10, 1.8, seed, "label_ink", lift=0.04).moved(K.FACE_Y, (x1 - 16, y - 0.3, z0 + 14)))
    return P


def freezer():
    x0, x1, y0, y1, h = FZ
    yd = y0 + 70
    P = [K.span(x0, x1, yd, y1, 110, h, "inst_white", 3.0, 3), K.span(x0 + 20, x1 - 20, yd, y1 - 20, 20, 110, "kick_dark", 2.0, 2)]
    P += [p for x in (x0 + 60, x1 - 60) for y in (yd + 60, y1 - 60) for p in castor(x, y, 110)]
    # the door, its gasket and frost line, the handle, the panel
    P.append(K.span(x0 + 4, x1 - 4, y0, yd - 6, 120, h - 60, "inst_white", 4.0, 3))
    P.append(K.span(x0 + 10, x1 - 10, yd - 6, yd + 0.5, 126, h - 66, "rubber", 1.0, 2))
    P.append(K.span(x0 + 12, x1 - 12, yd - 6.6, yd - 5.9, 128, 140, "tape_white", 0.2, 1))
    hx = x1 - 50
    P.append(K.sweep(K.fillet_path([(hx, y0, 600), (hx, y0 - 45, 640), (hx, y0 - 45, 1500), (hx, y0, 1540)], 30, 5), 13, "steel_brushed", 16))
    P.append(K.span(x0 + 210, x0 + 510, y0 - 3, y0, h - 330, h - 150, "black", 3.0, 3))
    P.append(K.span(x0 + 222, x0 + 498, y0 - 3.8, y0 - 3, h - 318, h - 162, "touchscreen", 0.5, 1))
    scr = [K.span(x0 + 226, x0 + 494, y0 - 3.1, y0 - 3.05, h - 314, h - 166, "screen_ui", 0, 0)]
    scr.append(K.text("-80", 60, "led_red", web_keep=True).moved(K.FACE_Y, (x0 + 330, y0 - 3.2, h - 280)))
    for k, (cx, cz, l1, l2) in enumerate(((x0 + 110, 1130, "A-0417", "rack 3 · box 12"), (x0 + 205, 1075, "A-0422", "rack 3 · box 14"))):
        P += inventory_label(cx, y0, cz, l1, l2, 31 + k)
    P.append(H.slots_grille(500, 300, 12, 460, 8, "inst_white", back=-0.05, t=2.0).moved(K.FACE["+y"], ((x0 + x1) / 2, y1 + 2, 400)))
    cord = K.fillet_path([(x0 + 100, y1, 250), (x0 + 100, y1 + 30, 250), (x0 + 100, y1 + 30, 30), (x0 + 250, WALL - 20, 20),
                          (x0 + 340, WALL - 20, 20), (x0 + 340, WALL - 20, 300)], 40, 5)
    P.append(K.sweep(cord, 5, "cable", 10))
    P.append(K.span(x0 + 290, x0 + 390, WALL - 12, WALL, 280, 360, "polymer_white", 2.0, 2))
    return P, scr


def incubator(z0, ajar=0.0):
    """one CO2 incubator from z0: body, outer door (hinge right; ajar degrees) with a display,
    inner glass door and shelves"""
    x0, x1, y0, y1 = CO
    yd = y0 + 60
    w = 45.0                                          # wall: the chamber opening is inset by w
    P = [K.span(x0, x0 + w, yd, y1, z0, z0 + 900, "inst_white", 3.0, 3), K.span(x1 - w, x1, yd, y1, z0, z0 + 900, "inst_white", 3.0, 3),
         K.span(x0 + w - 1, x1 - w + 1, yd, y1, z0, z0 + w, "inst_white", 3.0, 3), K.span(x0 + w - 1, x1 - w + 1, yd, y1, z0 + 900 - w, z0 + 900, "inst_white", 3.0, 3),
         K.span(x0 + w - 1, x1 - w + 1, y1 - w, y1, z0 + w - 1, z0 + 901 - w, "inst_white", 3.0, 3)]
    inner = [K.span(x0 + w - 2, x0 + w, yd + 2, y1 - w, z0 + w, z0 + 900 - w, "steel_polished", 0, 0),
             K.span(x1 - w, x1 - w + 2, yd + 2, y1 - w, z0 + w, z0 + 900 - w, "steel_polished", 0, 0),
             K.span(x0 + w, x1 - w, yd + 2, y1 - w, z0 + w - 2, z0 + w, "steel_polished", 0, 0),
             K.span(x0 + w, x1 - w, yd + 2, y1 - w, z0 + 900 - w, z0 + 902 - w, "steel_polished", 0, 0),
             K.span(x0 + w, x1 - w, y1 - w - 2, y1 - w, z0 + w, z0 + 900 - w, "steel_polished", 0, 0)]
    G = [K.span(x0 + 60, x1 - 60, yd - 14, yd - 8, z0 + 80, z0 + 820, "glass_float", 1.0, 2)]
    P += [K.span(x0 + 55, x1 - 55, yd - 16, yd - 8, z0 + 70, z0 + 80, "steel_brushed", 1.0, 2),
          K.span(x0 + 55, x1 - 55, yd - 16, yd - 8, z0 + 820, z0 + 830, "steel_brushed", 1.0, 2)]
    for k in range(1, 4):
        inner.append(K.span(x0 + w + 4, x1 - w - 4, yd + 30, y1 - w - 10, z0 + 60 + 190 * k, z0 + 64 + 190 * k, "steel_polished", 1.0, 1))
        for x in (x0 + w, x1 - w - 8):
            inner.append(K.span(x, x + 8, yd + 40, y1 - w - 20, z0 + 52 + 190 * k, z0 + 60 + 190 * k, "steel_polished", 0.5, 1))
    door = [K.span(x0, x1, y0, yd - 20, z0 + 10, z0 + 890, "inst_white", 4.0, 3), K.span(x0 + 20, x1 - 20, yd - 20, yd - 14, z0 + 30, z0 + 870, "rubber", 1.5, 2),
            K.span(x0 + 60, x0 + 76, y0 - 30, y0, z0 + 350, z0 + 550, "steel_brushed", 3.0, 3),
            K.span(x0 + 200, x0 + 440, y0 - 2.5, y0, z0 + 700, z0 + 800, "black", 2.0, 2),
            K.span(x0 + 208, x0 + 432, y0 - 3.2, y0 - 2.5, z0 + 708, z0 + 792, "touchscreen", 0.5, 1)]
    ui = [K.span(x0 + 212, x0 + 428, y0 - 2.6, y0 - 2.55, z0 + 712, z0 + 788, "screen_ui", 0, 0),
          K.text("37.0  5.0%", 22, "screen_ui_hi", web_keep=True).moved(K.FACE_Y, (x0 + 320, y0 - 2.7, z0 + 740))]
    if ajar:
        R = K.rot("z", ajar)
        hinge = np.array([x1, y0, 0.0])
        door = [p.moved(t=-hinge).moved(R, hinge) for p in door]
        ui = [p.moved(t=-hinge).moved(R, hinge) for p in ui]
    return P + inner + door, G, ui


def build(ctx):
    m = B.Model(ctx, ctx.name)
    P, scr = freezer()
    m.add(*P)
    m.add(*scr, sub="screen")
    x0, x1, y0, y1 = CO
    base = [K.span(x0 + 10, x1 - 10, y0 + 70, y1 - 10, 70, 100, "steel_brushed", 2.0, 2)]
    base += [p for x in (x0 + 60, x1 - 60) for y in (y0 + 120, y1 - 60) for p in castor(x, y, 70)]
    m.add(*base)
    for z0, aj in ((100.0, 0.0), (1000.0, 18.0)):
        P, G, ui = incubator(z0, aj)
        m.add(*P)
        m.add(*G, sub="glass")
        m.add(*ui, sub="screen")
    # gas lines from the rear ports up to a two-gauge regulator on the back wall
    reg = (2240.0, WALL, 1500.0)
    P = [K.span(reg[0] - 60, reg[0] + 40, WALL - 20, WALL, 1400, 1600, "steel_brushed", 2.0, 2)]
    for dz in (-40, 40):
        P.append(K.cyl(28, 0, 18, "steel", 32, 2.0).moved(K.FACE_Y, (reg[0] - 10, WALL - 20, 1500 + dz)))
        P.append(K.cyl(24, 18, 19, "glass_float", 32, 0).moved(K.FACE_Y, (reg[0] - 10, WALL - 20, 1500 + dz)))
    for zp in (700.0, 1600.0):
        path = [(x1 - 80, y1, zp), (x1 - 80, WALL - 25, zp), (reg[0] - 10, WALL - 25, zp), (reg[0] - 10, WALL - 25, 1420)]
        P.append(K.sweep(K.fillet_path(path, 30, 5), 3.0, "copper", 8))
    m.add(*P)
    return m.finish()
