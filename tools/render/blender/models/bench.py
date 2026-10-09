"""The back bench, zone A (world frame, mm): 900 high, 750 deep, a 25 mm epoxy top with an upstand,
white HPL casework (a drawer unit, a kneehole, a door unit; 2 mm gaps, brushed D handles on 128 mm
centres), dado trunking at 1050..1150 with double sockets and data points, the lab stool tucked under
and a 50 L pedal bin at the bench end."""
import math

import numpy as np

import _bl as B
import _hw as H
import _kit as K

ROLE = "dressing"
X0, X1, Y0, Y1 = -2100.0, -700.0, 1200.0, 1950.0
TOP = 900.0


def casework():
    P = [K.span(X0, X1, Y0 - 20, Y1, TOP - 25, TOP, "epoxy", 3.0, 3),
         K.span(X0, X1, Y1 - 20, Y1, TOP, TOP + 100, "epoxy", 2.0, 2)]
    units = [(X0 + 2, -1500.0, "drawers"), (-1500.0, -1000.0, "knee"), (-1000.0, X1 - 2, "doors")]
    y0 = Y0 + 20
    for x0, x1, kind in units:
        if kind == "knee":
            P.append(K.span(x0, x1, Y1 - 40, Y1 - 20, 100, TOP - 25, "lab_white", 1.0, 2))
            continue
        P.append(K.span(x0, x1, y0 + 20, Y1 - 20, 100, TOP - 25, "lab_white", 1.0, 2))
        P.append(K.span(x0 + 10, x1 - 10, y0 + 40, Y1 - 40, 0, 100, "kick_dark", 1.0, 1))
        fronts = [(110, 330), (332, 552), (554, 862)] if kind == "drawers" else [(110, 862)]
        cols = [(x0, x1)] if kind == "drawers" else [(x0, (x0 + x1) / 2 - 1), ((x0 + x1) / 2 + 1, x1)]
        for c0, c1 in cols:
            for z0, z1 in fronts:
                P.append(K.span(c0 + 1, c1 - 1, y0, y0 + 19, z0, z1, "lab_white", 1.5, 2))
                hx = (c0 + c1) / 2 if kind == "drawers" else (c1 - 40 if c0 < (x0 + x1) / 2 - 2 else c0 + 40)
                hz = z1 - 45 if kind == "drawers" else z1 - 120
                R = K.rot("y", 90) if kind == "doors" else None
                h = H.handle_d(128, 10, 30, "steel_brushed")
                P.append(h.moved(R, (hx, y0, hz)) if R is not None else h.moved(t=(hx, y0, hz)))
    return P


def trunking():
    y = Y1 - 50
    P = [K.span(X0, X1, y, Y1, 1050, 1150, "polymer_white", 2.0, 2), K.span(X0, X1, y - 1, y, 1098, 1102, "polymer_white", 0.3, 1)]
    for k, x in enumerate(np.arange(X0 + 250, X1 - 100, 400)):
        P.append(K.span(x - 72, x + 72, y - 9, y, 1062, 1138, "polymer_white", 2.0, 2))
        for dx in (-35, 35):
            P.append(K.span(x + dx - 16, x + dx + 16, y - 9.5, y - 9, 1082, 1118, "polymer_grey", 0.6, 1))
            for px in (-6, 6):
                P.append(K.span(x + dx + px - 1.5, x + dx + px + 1.5, y - 9.6, y - 9.5, 1104, 1110, "black", 0, 0))
        if k % 2:
            P.append(K.span(x + 110, x + 160, y - 9, y, 1075, 1125, "polymer_white", 1.5, 2))
            P.append(K.span(x + 124, x + 146, y - 9.4, y - 9, 1092, 1108, "black", 0.4, 1))
    return P


def stool(cx, cy):
    P = [K.lathe([(0, 590), (180, 590), (190, 600), (188, 640), (175, 650), (0, 652)], K.nseg(40), "black"),
         K.cyl(22, 380, 590, "steel", 24, 1.0), K.cyl(28, 120, 400, "black", 24, 1.0),
         K.sweep([(250 * math.cos(a), 250 * math.sin(a), 320) for a in np.linspace(0, 2 * math.pi, 33)], 7, "steel", 8, closed=True)]
    for k in range(3):
        a = 2 * math.pi * k / 3
        P.append(K.bar((22 * math.cos(a), 22 * math.sin(a), 330), (240 * math.cos(a), 240 * math.sin(a), 322), 6, "steel", 8))
    for k in range(5):
        a = 2 * math.pi * k / 5 + 0.3
        e = (300 * math.cos(a), 300 * math.sin(a))
        P.append(K.bar((0, 0, 130), (e[0], e[1], 90), 16, "black", 10))
        P.append(K.lathe([(0, 0), (20, 0), (26, 12), (26, 38), (18, 50), (0, 52)], K.nseg(16), "black").moved(K.rot("x", 90), (e[0], e[1], 26)))
        P.append(K.cyl(9, 50, 90, "black", 12, 0.5, at=e))
    return [p.moved(t=(cx, cy, 0)) for p in P]


def pedal_bin(cx, cy):
    """a 50 L step-on bin, a biohazard label on the lid front"""
    P = [K.prism(K.rrect(380, 330, 40, 4, 0, 0), 20, 640, "polymer_white", bev=3.0, seg=3),
         K.prism(K.rrect(390, 340, 42, 4, 0, 0), 640, 680, "polymer_red", bev=4.0, seg=3),
         K.span(-90, 90, -205, -165, 10, 40, "black", 3.0, 2)]
    for sx in (-1, 1):
        for sy in (-1, 1):
            P.append(H.foot_rubber(24, 20).moved(t=(sx * 150, sy * 130, 0)))
    P.append(K.span(-60, 60, -166.4, -165.5, 520, 600, "hazard_yellow", 0.5, 1))
    P.append(K.text("BIOHAZARD", 13, "label_ink").moved(K.FACE_Y, (0, -166.5, 530)))
    return [p.moved(t=(cx, cy, 0)) for p in P]


def build(ctx):
    m = B.Model(ctx, ctx.name)
    m.add(*casework(), *trunking(), *stool(-1250, 1520), *pedal_bin(-500, 1760))
    return m.finish()
