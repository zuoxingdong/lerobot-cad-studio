"""Fluorescence reader, a 4-position tube fluorometer (360 x 310 x 220 over T; station frame, mm):
textured grey ABS body with a front sill, a matte-black optical chamber wall and window, a 100 x 50
LCD bezel (the capture's animated bars show through its glass), side vents, a rear inlet and cable.
Parts: `lid` (the smoked clamshell hood, polished 3 mm acrylic with quarter-disc sides, OPEN as
anim_reader_lid_0), `glow` (the excitation light lining the chamber inside it: both side walls and the back of
the top, so it spills through the smoke instead of reading as a plane) and `led` (the status bar)."""
import math

import _bl as B
import _hw as H
import _kit as K

ROLE = "station"

HINGE = (115.0, 140.0)


def hood(deg):
    y, z = HINGE
    P = [K.span(-95, 95, -5, 115, 140, 143, "smoked_glass", 0.8, 2), K.span(-95, 95, -5, -2, 127, 140.5, "smoked_glass", 0.8, 2)]
    arc = [(y - 120 * math.cos(math.radians(a)), z - 120 * math.sin(math.radians(a))) for a in range(0, 91, 5)]
    sector = [(y, z)] + arc
    for x0 in (-95, 92):
        side = K.prism(sector, x0, x0 + 3, "smoked_glass", bev=0.6, seg=2)
        V = side.V[:, [2, 0, 1]]
        P.append(K.Part(V, side.L, side.C, side.K))
    P.append(K.cyl(6, -58, 58, "alu", 24, 0.6).moved(K.rot("y", 90), (0, y, z)))
    # the excitation glow lines the chamber: both quarter-disc walls inside the smoked sides and the back of the top
    inner = [(y, z)] + [(y - 112 * math.cos(math.radians(a)), z - 112 * math.sin(math.radians(a))) for a in range(0, 91, 5)]
    glow = []
    for x0 in (-91.6, 90.8):
        side = K.prism(inner, x0, x0 + 0.8, "glow_off", bev=0, seg=0)
        glow.append(K.Part(side.V[:, [2, 0, 1]], side.L, side.C, side.K))
    glow.append(K.span(-88, 88, 60, 110, 138.4, 139.2, "glow_off", 0, 0))
    return [H.hinged(p, y, z, -deg) for p in P], [H.hinged(g, y, z, -deg) for g in glow]


def body():
    P = [K.prism(K.rrect(360, 272, 12, 4, 0, 285), 8, 74, "inst_grey", bev=2.0, seg=3),
         K.prism(K.rrect(360, 272, 12, 4, 0, 285), 74.6, 220, "inst_grey", bev=2.0, seg=3),
         K.prism(K.rrect(360, 46, 6, 4, 0, 133), 8, 134, "inst_grey", bev=2.0, seg=3)]
    for sx in (-1, 1):
        for yy in (135, 395):
            P.append(H.foot_rubber(20, 8).moved(t=(sx * 155, yy, 0)))
        x0, x1 = (62, 86) if sx > 0 else (-86, -62)
        P.append(K.span(x0, x1, 108, 122, 128, 136, "inst_grey", 1.5, 2))
        P.append(K.cyl(6, 62, 86, "alu", 24, 0.6).moved(K.rot("y", 90 * sx), (0, HINGE[0], HINGE[1])))
        face = K.FACE["+x"] if sx > 0 else K.FACE["-x"]
        P.append(H.slots_grille(120, 40, 14, 26, 3, "inst_grey", back=-0.05, t=2.0, horizontal=False).moved(face, (sx * 180, 330, 150)))
    # the black optical chamber wall on the sill, the excitation/emission window
    P.append(K.span(-94, 94, 109.0, 110.3, 10, 132, "chamber_black", 0.6, 2))
    P.append(K.lathe([(15, 0), (21, 0), (21, 1.6), (20, 2.4), (15, 2.4), (15, 0)], K.nseg(48), "black").moved(K.FACE_Y, (0, 109.0, 60)))
    P.append(K.cyl(15.2, 0, 1.2, "smoked_glass", 48, 0.3).moved(K.FACE_Y, (0, 109.2, 60)))
    return P


def lcd():
    """bezel 116 x 70 around a 100 x 50 window, the background behind the capture's bars, glass in front"""
    cx, z0, z1, y = 130.0, 142.0, 206.0, 150.0
    P = [K.span(cx - 58, cx - 50, y - 4.4, y, z0, z1, "black", 1.0, 2), K.span(cx + 50, cx + 58, y - 4.4, y, z0, z1, "black", 1.0, 2),
         K.span(cx - 50, cx + 50, y - 4.4, y, z0, z0 + 7, "black", 1.0, 2), K.span(cx - 50, cx + 50, y - 4.4, y, z1 - 7, z1, "black", 1.0, 2)]
    P.append(K.span(cx - 50, cx + 50, y - 2.35, y - 2.3, z0 + 7, z1 - 7, "screen_ui", 0, 0))
    for k in range(4):
        P.append(K.text(str(k + 1), 4.2, "screen_ui_hi", web_keep=True).moved(K.FACE_Y, (110 + 17 * k, y - 2.4, z0 + 7.8)))
    P.append(K.span(cx - 50.5, cx + 50.5, y - 4.8, y - 4.1, z0 + 6.5, z1 - 6.5, "touchscreen", 0.2, 1))
    P.append(K.span(-172, -108, y - 1.6, y, 193, 205, "black", 0.8, 2))
    led = K.span(-168, -112, y - 2.4, y - 1.2, 196, 202, "led_off", 0.5, 2)
    return P, led


def build(ctx):
    sid = B.sid_of(ctx) or "reader"
    st = B.station(ctx, sid)
    T = st["T"]
    deg = st["lid"]["closed_deg"] if st.get("lid") else 95
    m = B.Model(ctx, ctx.name, base=(0, 0, T))
    m.origin["led"] = B.item_at(ctx, "anim_reader_led_0", T)
    up = lambda p: p.moved(t=(0, 0, T))
    P, led = lcd()
    m.add(*map(up, body() + P))
    m.add(up(K.span(-110, -60, 420, 421.2, 40, 75, "black", 0.5, 1)), up(K.span(-98, -72, 421, 432, 50, 66, "polymer_grey", 1.0, 2)))
    cab = K.fillet_path([(-85, 431, 58), (-85, 435, 58), (-85, 435, 170), (0, 436, 245), (0, 440, 292)], 30, 6)
    m.add(up(K.sweep(cab, 4.0, "cable", 10)))
    H_, glow = hood(deg)
    m.add(*map(up, H_), sub="lid")
    m.add(*map(up, glow), sub="glow")
    m.add(up(led), sub="led")
    return m.finish(tint=("led", "glow"))
