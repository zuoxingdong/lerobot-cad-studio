"""Wall-mounted dressing (world frame, mm): a Ø300 wall clock at z 2200 showing 15:40, a CO2 fire
extinguisher on its bracket with a sign, an eyewash sign and a safety-glasses dispenser at the bench
end, and two lab coats on a coat stand by the partition door."""
import math

import numpy as np

import _bl as B
import _hw as H
import _kit as K

ROLE = "dressing"
LEFT, BACK, PART = -2100.0, 1950.0, 2300.0


def clock():
    P = [K.lathe([(0, 0), (150, 0), (152, 4), (150, 40), (140, 42), (140, 36), (0, 36)], K.nseg(64), "polymer_white"),
         K.cyl(138, 34, 35, "paint_white", 64, 0)]
    for k in range(12):
        a = math.radians(90 - 30 * k)
        L = 18 if k % 3 == 0 else 9
        P.append(K.span(-1.5 if k % 3 else -3, 1.5 if k % 3 else 3, 118 - L, 118, 35, 35.6, "label_ink", 0, 0).moved(K.rot("z", math.degrees(a) - 90)))
    for ang, L, w in ((90 - 30 * 15.67, 70, 3.5), (90 - 6 * 40, 105, 2.5)):
        P.append(K.span(-w, w, -12, L, 36, 37, "label_ink", 0, 0).moved(K.rot("z", ang - 90)))
    P.append(K.span(-0.8, 0.8, -20, 112, 37.2, 37.6, "red", 0, 0).moved(K.rot("z", -140)))
    P.append(K.cyl(138, 40, 41.5, "glass_float", 64, 0))
    return [p.moved(K.FACE["+x"], (LEFT, 1350, 2200)) for p in P]


def extinguisher():
    x, y = LEFT, -1150.0
    P = [K.span(x, x + 8, y - 60, y + 60, 700, 900, "steel", 1.0, 2),
         K.lathe([(0, 0), (60, 0), (68, 10), (68, 560), (55, 600), (22, 625), (0, 628)], K.nseg(40), "red").moved(t=(x + 80, y, 280)),
         K.span(x + 60, x + 100, y - 12, y + 12, 905, 935, "black", 2.0, 2), K.span(x + 70, x + 150, y - 5, y + 5, 928, 940, "black", 2.0, 2)]
    P.append(K.sweep(K.fillet_path([(x + 110, y, 920), (x + 160, y + 40, 880), (x + 150, y + 40, 500)], 30, 5), 7, "black", 10))
    P.append(K.lathe([(0, 0), (12, 0), (40, 150), (36, 150), (9, 5), (0, 5)], K.nseg(24), "black").moved(t=(x + 150, y + 40, 350)))
    P.append(H.wrap_cyl(K.span(-60, 60, 0, 0.2, 300, 440, "label", 0, 0), 68).moved(t=(x + 80, y, 280)))
    P.append(K.span(x, x + 2, y - 100, y + 100, 1300, 1500, "red", 0.5, 1))
    P.append(K.text("CO2", 60, "tape_white", web_keep=True).moved(K.FACE["+x"], (x + 2.1, y, 1370)))
    return P


def eyewash_and_glasses():
    x = -560.0
    P = [K.span(x - 100, x + 100, BACK - 2, BACK, 1600, 1800, "cap_green", 0.5, 1),
         K.text("EYE WASH", 30, "tape_white", web_keep=True).moved(K.FACE_Y, (x, BACK - 2.1, 1640))]
    P.append(K.lathe([(0, 0), (30, 0), (30, 0.4), (0, 0.4)], K.nseg(32), "tape_white").moved(K.FACE_Y, (x, BACK - 2.05, 1735)))
    P += [K.span(x - 170, x + 170, BACK - 110, BACK, 1250, 1270, "polymer_white", 2.0, 2),
          K.span(x - 170, x + 170, BACK - 110, BACK - 104, 1270, 1420, "plate_clear", 1.5, 2),
          K.span(x - 170, x - 164, BACK - 110, BACK, 1270, 1420, "plate_clear", 1.0, 2), K.span(x + 164, x + 170, BACK - 110, BACK, 1270, 1420, "plate_clear", 1.0, 2)]
    for k in range(3):
        cx = x - 100 + 100 * k
        for sx in (-1, 1):
            P.append(K.lathe([(0, 0), (24, 0), (24, 3), (0, 3)], K.nseg(24), "plate_clear").moved(K.rot("x", 90), (cx + sx * 28, BACK - 60, 1320)))
        P.append(K.bar((cx - 50, BACK - 60, 1335), (cx - 50, BACK - 10, 1335), 2, "polymer_blue", 6))
    return P


def coat(seed):
    """a lab coat hanging from its hook at the origin: shoulders, a flared body with folds, sleeves"""
    rng = np.random.default_rng(seed)
    rows, n = [], K.nseg(28)
    for zz, hw, hd in [(0, 30, 20), (-40, 200, 90), (-120, 230, 110), (-400, 240, 120), (-800, 265, 130), (-1020, 280, 135)]:
        ph = rng.uniform(0, 2 * math.pi)
        rows.append([(hd * math.cos(a) * (1 + 0.04 * math.sin(7 * a + ph)), hw * math.sin(a) * (1 + 0.03 * math.sin(5 * a + ph)), zz)
                     for a in np.linspace(0, 2 * math.pi, n, endpoint=False)])
    V = [p for r in rows for p in r]
    L, C = [], []
    for i in range(len(rows) - 1):
        for j in range(n):
            a, b = i * n + j, i * n + (j + 1) % n
            L += [a, a + n, b + n, b]
            C.append(4)
    P = [K.Part(V, L, C, [K.kid("fabric_white")] * len(C))]
    for sy in (-1, 1):
        path = [(0, sy * 190, -70), (10, sy * 235, -300), (25, sy * 245, -620)]
        P.append(K.sweep(K.fillet_path(path, 80, 4), 55, "fabric_white", 14))
    return P


def coat_stand(cx, cy):
    """a floor coat stand: weighted base, pole, 4 hooks; a coat on the +y and on the -x hook"""
    P = [K.lathe([(0, 0), (190, 0), (195, 5), (180, 18), (0, 22)], K.nseg(48), "frame_dark"), K.cyl(16, 22, 1780, "steel_brushed", 20, 1.0),
         K.lathe([(0, 1780), (22, 1780), (22, 1800), (0, 1810)], K.nseg(20), "frame_dark")]
    for k in range(4):
        a = math.pi / 2 * k
        P.append(K.sweep(K.fillet_path([(16 * math.cos(a), 16 * math.sin(a), 1720), (80 * math.cos(a), 80 * math.sin(a), 1740),
                                        (95 * math.cos(a), 95 * math.sin(a), 1780)], 20, 4), 5, "steel_brushed", 8))
    P += [p.moved(K.rot("z", 90), (0, 100, 1735)) for p in coat(3)]
    P += [p.moved(K.rot("z", 180), (-100, 0, 1730)) for p in coat(5)]
    return [p.moved(t=(cx, cy, 0)) for p in P]


def build(ctx):
    m = B.Model(ctx, ctx.name)
    m.add(*clock(), *extinguisher(), *eyewash_and_glasses())
    m.add(*coat_stand(PART - 260, -1280))
    return m.finish()
