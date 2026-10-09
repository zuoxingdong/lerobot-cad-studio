"""On the back bench (world frame, mm, top at 900): a microcentrifuge (lid closed, status LED), a vortex
mixer, a pipette carousel with 4 pipettes against the upstand, 2 tip boxes (one lid open) and a tube
rack, a laptop on a riser showing a warm analysis plot, two 1 L media bottles with blue GL45 caps, a
wash bottle and a 600 mL beaker, each with real liquid levels and labels."""
import math


import _bl as B
import _hw as H
import _kit as K

ROLE = "dressing"
Z = 900.0


def centrifuge(cx, cy):
    P = [K.prism(K.rrect(250, 290, 60, 6, 0, 0), 0, 95, "lab_white", bev=4.0, seg=3),
         K.lathe([(0, 95), (108, 95), (110, 98), (104, 118), (80, 132), (0, 136)], K.nseg(48), "polymer_grey").moved(t=(0, 12, 0)),
         K.span(-70, 70, -146, -140, 30, 80, "polymer_grey", 2.0, 2), K.span(-50, 10, -146.6, -146, 48, 66, "screen", 0.5, 1),
         K.span(30, 44, -146.8, -146, 52, 62, "led_green", 0.5, 1)]
    P += [H.foot_rubber(14, 6).moved(t=(sx * 100, sy * 120, -6)) for sx in (-1, 1) for sy in (-1, 1)]
    return [p.moved(t=(cx, cy, Z + 6)) for p in P]


def vortex(cx, cy):
    P = [K.prism(K.rrect(130, 160, 30, 5, 0, 0), 0, 70, "lab_white", bev=4.0, seg=3),
         K.lathe([(0, 70), (28, 70), (32, 78), (30, 92), (22, 96), (0, 90)], K.nseg(32), "rubber"),
         K.cyl(14, 0, 8, "polymer_blue", 24, 1.0).moved(K.FACE_Y, (0, -80, 35))]
    return [p.moved(t=(cx, cy, Z)) for p in P]


def pipette(ang):
    P = [K.lathe([(0, 0), (2.5, 0), (4.5, 40), (9, 95), (11, 180), (13, 230), (9, 245), (0, 246)], K.nseg(16), "polymer_white"),
         K.cyl(5, 246, 262, "cap_amber", 12, 1.0), K.span(-5, 5, 11, 26, 200, 222, "polymer_grey", 2.0, 2)]
    return [p.moved(K.rot("z", ang), (0, 0, 0)) for p in P]


def carousel(cx, cy):
    P = [K.lathe([(0, 0), (90, 0), (92, 4), (88, 14), (20, 18), (0, 18)], K.nseg(40), "polymer_grey"),
         K.cyl(9, 18, 420, "steel", 16, 0.5), K.cyl(70, 330, 342, "polymer_grey", 32, 2.0)]
    for k in range(4):
        a = math.pi / 2 * k + 0.4
        x, y = 58 * math.cos(a), 58 * math.sin(a)
        P += [p.moved(t=(x, y, 70)) for p in pipette(math.degrees(a))]
    return [p.moved(t=(cx, cy, Z)) for p in P]


def tipbox(cx, cy, yaw, open_lid):
    P = [K.span(-61, 61, -41, 41, 0, 50, "polymer_blue", 1.5, 2), K.span(-60, 60, -40, 40, 50, 54, "polymer_white", 1.0, 2)]
    for i in range(8):
        for j in range(12):
            P.append(K.lathe([(0, 0), (3.2, 0), (3.2, 7), (2.6, 7), (2.6, 2), (0, 2)], K.nseg(10, 5), "tip_natural")
                     .moved(t=(-49.5 + 9 * j, -31.5 + 9 * i, 54)))
    lid = K.span(-62, 62, -42, 42, 0, 26, "plate_clear", 1.5, 2)
    P.append(H.hinged(lid.moved(t=(0, 0, 54)), 42, 54, -105).moved(t=(0, 0, 0)) if open_lid else lid.moved(t=(0, 0, 54)))
    return [p.moved(K.rot("z", yaw), (cx, cy, Z)) for p in P]


def tube_rack(cx, cy):
    P = [K.span(-60, 60, -25, 25, 0, 4, "polymer_yellow", 1.0, 2), K.span(-60, 60, -25, 25, 40, 44, "polymer_yellow", 1.0, 2)]
    for sx in (-1, 1):
        P.append(K.span(sx * 60 - 2, sx * 60 + 2, -25, 25, 0, 44, "polymer_yellow", 0.8, 2))
    for k in range(5):
        P.append(K.cyl(7, 8, 105, "tube_clear", 20, 1.0, at=(-40 + 20 * k, 0)))
        P.append(K.cyl(8, 105, 118, ["cap_blue", "cap_amber", "cap_green", "cap_pink", "cap_blue"][k], 20, 1.0, at=(-40 + 20 * k, 0)))
    return [p.moved(K.rot("z", 8), (cx, cy, Z)) for p in P]


def laptop(cx, cy):
    """a riser, the base with a keyboard field, the lid at 110°, the warm plot on the screen (part `screen`)"""
    P = [K.span(-150, 150, -120, 120, 0, 6, "alu", 1.5, 2)]
    for sx in (-1, 1):
        P.append(K.prism([(-120, 6), (120, 6), (120, 70), (-120, 30)], sx * 120 - 6, sx * 120 + 6, "alu", bev=1.5, seg=2).moved(K.rot("z", 90) @ K.rot("x", 90), (0, 0, 0)))
    base = [K.span(-165, 165, -115, 115, 0, 16, "frame_dark", 3.0, 3), K.span(-140, 140, -95, 10, 16, 16.4, "black", 0.3, 1),
            K.span(-45, 45, 25, 90, 16, 16.3, "black", 0.3, 1)]
    lid = [K.span(-165, 165, 0, 8, 0, 225, "frame_dark", 3.0, 3)]
    scr = [K.span(-150, 150, -0.4, 0, 12, 212, "screen_warm", 0, 0)]
    for k, h in enumerate((40, 70, 55, 120, 90, 150)):
        scr.append(K.span(-120 + 38 * k, -95 + 38 * k, -0.7, -0.4, 40, 40 + h * 0.9, "cap_amber" if k != 3 else "cap_green", 0, 0))
    R = K.rot("x", -20)
    lid = [p.moved(R, (0, 110, 16)) for p in lid]
    scr = [p.moved(R, (0, 110, 16)) for p in scr]
    tilt = K.rot("x", math.degrees(math.atan2(40, 240)))
    at = lambda ps, dz, R: [p.moved(R, (0, 0, dz)).moved(t=(cx, cy, Z)) for p in ps]
    return at(P, 0, None) + at(base + lid, 50, tilt), at(scr, 50, tilt)


def bottle(cx, cy, cap="cap_blue", fill=0.7, amber=False):
    g = "amber_glass" if amber else "glass_boro"
    out = [(0, 0), (40, 0), (43, 3), (43, 150), (36, 180), (22, 195), (22, 212), (19.5, 212), (19.5, 197), (33, 181),
           (40.5, 150), (40.5, 5), (0, 5)]
    P = [K.lathe(out, K.nseg(48), g), K.lathe([(0, 212), (23, 212), (24.5, 214), (24.5, 238), (22, 240), (0, 240)], K.nseg(40), cap),
         K.lathe([(0, 5.1), (40.4, 5.1), (40.4, 5.1 + 145 * fill), (0, 5.1 + 145 * fill)], K.nseg(48), "reaction" if not amber else "liquid_blue"),
         H.wrap_cyl(K.span(-50, 50, 0, 0.2, 60, 110, "label", 0, 0), 43)]
    return [p.moved(t=(cx, cy, Z)) for p in P]


def wash_bottle(cx, cy):
    P = [K.lathe([(0, 0), (35, 0), (38, 5), (38, 150), (30, 170), (14, 180), (0, 180)], K.nseg(40), "polymer_white"),
         K.cyl(16, 180, 196, "cap_blue", 24, 1.0),
         K.sweep(K.fillet_path([(0, 0, 196), (0, 0, 230), (-70, 0, 215)], 20, 5), 3.0, "polymer_white", 8)]
    return [p.moved(t=(cx, cy, Z)) for p in P]


def beaker(cx, cy):
    P = [K.lathe([(0, 0), (45, 0), (46, 2), (46, 120), (49, 124), (47.5, 124), (44, 120), (44, 2), (0, 2)], K.nseg(48), "glass_boro"),
         K.lathe([(0, 2.1), (43.9, 2.1), (43.9, 60), (0, 60)], K.nseg(48), "reaction")]
    for k, z in enumerate((30, 50, 70, 90)):
        P.append(H.wrap_cyl(K.span(-8 - 4 * (k % 2), 0, 0, 0.1, z, z + 0.8, "tape_white", 0, 0), 46))
    return [p.moved(t=(cx, cy, Z)) for p in P]


def build(ctx):
    m = B.Model(ctx, ctx.name)
    m.add(*centrifuge(-1880, 1640), *vortex(-1680, 1520), *carousel(-1560, 1840))
    m.add(*tipbox(-1150, 1720, 5, False), *tipbox(-1010, 1600, -12, True), *tube_rack(-1150, 1850))
    body, scr = laptop(-1260, 1540)
    m.add(*body)
    m.add(*scr, sub="screen")
    m.add(*bottle(-880, 1840), *bottle(-790, 1800, fill=0.45), *wash_bottle(-900, 1620), *beaker(-800, 1560))
    return m.finish()
