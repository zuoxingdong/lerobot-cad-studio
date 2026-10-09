"""Liquid handler, compact Flex-like (820 x 420 x 740 over T, station frame, mm): black anodised front
bezel, brushed-alu side cheeks with PC windows, a 5 mm PC door and roof, a machined deck with 12 SBS
slots (clips, engraved A1..C4) and labware, rear vents and connectors, 4 feet.  Sub-objects:
`gantry` (beam, carriages; follows anim_lh_gantry_0 along local x), `head` (the 8-channel
pipette on its Z carriage; follows anim_lh_gantry_1), `chain` (the
drag chain, bent on a hooked path so its loop runs at half the gantry speed), `led` (status strip),
`screen` (7" touchscreen UI)."""
import math

import bpy
import numpy as np

import _bl as B
import _hw as H
import _kit as K

ROLE = "station"

X0, X1, Y0, Y1, HT = -410, 410, 140, 560, 740
DECK = 110.0                                # deck top over T
SLOT = (127.76, 85.48)
COLS, ROWS = (-225, -75, 75, 225), (460, 350, 240)      # A (back) .. C (front)
RAIL_Z, RAIL_Y = 655.0, (190.0, 510.0)
HEAD_Y = 330.0
CH = {"R": 22.0, "S": 300.0, "z": 668.0, "y": 490.0}    # drag chain: bend radius, free length, lower run


def cheek(sx):
    """one side: posts and rails in brushed alu around a 5 mm PC window, Torx screws outside"""
    xa, xb = (386, 410) if sx > 0 else (-410, -386)
    P = [K.span(xa, xb, Y0, 184, 12, HT, "alu_brushed", 2.0, 2), K.span(xa, xb, 516, Y1, 12, HT, "alu_brushed", 2.0, 2),
         K.span(xa, xb, 184.3, 515.7, 12, 130, "alu_brushed", 1.5, 2), K.span(xa, xb, 184.3, 515.7, 690, HT, "alu_brushed", 1.5, 2)]
    xm = (xa + xb) / 2
    G = [K.span(xm - 2.5, xm + 2.5, 182, 518, 128, 692, "glass", 0.8, 2)]
    face = K.FACE["+x"] if sx > 0 else K.FACE["-x"]
    xo = xb if sx > 0 else xa
    for y in (162, 538):
        for z in (40, 300, 560, 715):
            P.append(H.screw(3.0, "steel").moved(face, (xo, y, z)))
    return P, G


def bezel():
    P = [K.span(-386, 386, Y0, 152, 12, 130, "black_anod", 1.5, 2), K.span(-386, 386, Y0, 152, 670, HT, "black_anod", 1.5, 2)]
    for sx in (-1, 1):
        P.append(K.span(min(sx * 356, sx * 386), max(sx * 356, sx * 386), Y0, 152, 130.3, 669.7, "black_anod", 1.5, 2))
    # the door: PC with rounded corners, top hinges, a pull bar along the bottom
    door = K.prism(K.rrect(724, 552, 10, 4, 0, 400), 0, 5, "glass", bev=1.0, seg=2).moved(K.FACE_Y, (0, 139, 0))
    for x in (-250, 250):
        P.append(K.span(x - 30, x + 30, 128, 140, 676, 690, "black_anod", 1.0, 2))
    P.append(H.handle_d(300, 10, 8, "black_anod").moved(t=(0, 134, 146)))
    # the status strip across the top band, in an opal channel
    hs, df = H.led_bar(600, 8, "led_off", "black_anod", depth=2.0, lip=2.0)
    return P, door, hs.moved(t=(0, Y0, 705)), df.moved(t=(0, Y0, 705))


def screen():
    """the 7" touchscreen at the front right, in front of the door, on a short arm to the right stile"""
    R, at = K.FACE_Y, np.array([330.0, 133.0, 475.0])
    body = [K.prism(K.rrect(178, 110, 6, 3), 0, 10, "black_anod", bev=1.5, seg=2).moved(R, at),
            K.span(350, 376, 132, 139.5, 465, 485, "black_anod", 1.0, 2), K.span(366, 380, 132, 152, 463, 487, "black_anod", 1.0, 2)]
    glass = K.prism(K.rrect(172, 104, 4, 3), 10.15, 11.35, "touchscreen", bev=0.3, seg=1).moved(R, at)
    ui = [K.span(-77, 77, -43, 43, 10.02, 10.06, "screen_ui", 0, 0)]
    for y, w in ((31, 150), (14, 110), (0, 132), (-14, 72)):
        ui.append(K.span(-72, -72 + w, y - 3, y + 3, 10.06, 10.09, "screen_ui_hi", 0, 0))
    ui.append(K.span(40, 72, -38, -26, 10.06, 10.09, "led_green", 0, 0))
    return body, glass, K.cat(ui).moved(R, at)


def tip(h=52.0):
    return K.lathe([(0, -h), (0.45, -h), (2.9, -12), (3.1, -10), (3.6, -8.5), (3.6, 0), (3.0, 0), (2.6, -11), (0, -11)],
                   K.nseg(12, 5), "tip_natural")


def tiprack(cx, cy, used=0):
    sx, sy = SLOT
    P = [K.span(cx - sx / 2, cx + sx / 2, cy - sy / 2, cy + sy / 2, DECK, DECK + 62, "tiprack", 1.0, 2),
         K.span(cx - sx / 2 + 2, cx + sx / 2 - 2, cy - sy / 2 + 2, cy + sy / 2 - 2, DECK + 62, DECK + 66, "tiprack_blue", 0.8, 2)]
    t = tip()
    top = DECK + 76
    for k in range(96):
        i, j = divmod(k, 12)
        if j < used:
            continue
        P.append(t.moved(t=(cx - 49.5 + 9 * j, cy + 31.5 - 9 * i, top)))
    return P


def pcr_plate(cx, cy, z):
    sx, sy = SLOT
    return [K.span(cx - sx / 2, cx + sx / 2, cy - sy / 2, cy + sy / 2, z, z + 6, "polymer_white", 0.6, 2),
            K.span(cx - 61, cx + 61, cy - 40, cy + 40, z + 6, z + 16, "polymer_white", 0.8, 2),
            K.span(cx - 60.5, cx + 60.5, cy - 39.5, cy + 39.5, z + 16, z + 16.15, "foil", 0.05, 1)]


def reservoir(cx, cy):
    sx, sy = SLOT
    x0, x1, y0, y1, z0, z1 = cx - sx / 2, cx + sx / 2, cy - sy / 2, cy + sy / 2, DECK, DECK + 31
    P = [K.span(x0, x1, y0, y1, z0, z0 + 4, "plate_clear", 0.8, 2)]
    P += [K.span(x0, x1, y0, y0 + 2, z0, z1, "plate_clear", 0.6, 2), K.span(x0, x1, y1 - 2, y1, z0, z1, "plate_clear", 0.6, 2),
          K.span(x0, x0 + 2, y0, y1, z0, z1, "plate_clear", 0.6, 2), K.span(x1 - 2, x1, y0, y1, z0, z1, "plate_clear", 0.6, 2)]
    for k in range(1, 12):
        x = x0 + 2 + k * (sx - 4) / 12
        P.append(K.span(x - 0.6, x + 0.6, y0 + 2, y1 - 2, z0 + 4, z1 - 3, "plate_clear", 0.3, 1))
    return P


def heater_shaker(cx, cy):
    P = [K.prism(K.rrect(152, 90, 8, 4, cx, cy), DECK, DECK + 72, "inst_grey", bev=2.0, seg=3),
         K.span(cx - 64, cx + 64, cy - 43, cy + 43, DECK + 72, DECK + 82, "alu", 1.0, 2),
         K.span(cx - 20, cx + 20, cy - 45.4, cy - 44.9, DECK + 30, DECK + 45, "label", 0, 0)]
    P.append(K.span(cx + 50, cx + 58, cy - 45.6, cy - 44.8, DECK + 50, DECK + 54, "led_green", 0, 0))
    P += pcr_plate(cx, cy, DECK + 82)
    return P


def deck():
    P = [K.span(-386, 386, 152, 540, 90, DECK - 0.6, "alu", 1.0, 2)]
    for r, cy in zip("ABC", ROWS):
        for c, cx in enumerate(COLS):
            sx, sy = SLOT
            P.append(K.span(cx - sx / 2 - 1, cx + sx / 2 + 1, cy - sy / 2 - 1, cy + sy / 2 + 1, DECK - 0.8, DECK, "alu", 0.3, 1))
            for qx, qy in ((-1, 1), (1, -1)):
                x, y = cx + qx * (sx / 2 + 1), cy + qy * (sy / 2 + 1)
                P.append(K.span(min(x, x - qx * 10), max(x, x - qx * 10), min(y, y + qy * 2.5), max(y, y + qy * 2.5), DECK, DECK + 6, "black_anod", 0.4, 1))
                P.append(K.span(min(x, x + qx * 2.5), max(x, x + qx * 2.5), min(y, y - qy * 10), max(y, y - qy * 10), DECK, DECK + 6, "black_anod", 0.4, 1))
            P.append(K.text("%s%d" % (r, c + 1), 5.0, "label_ink").moved(t=(cx - sx / 2 + 6, cy - sy / 2 - 8.5, DECK + 0.02)))
    P += tiprack(COLS[0], ROWS[0]) + tiprack(COLS[1], ROWS[0], used=2)
    P += reservoir(COLS[0], ROWS[1]) + pcr_plate(COLS[1], ROWS[1], DECK) + heater_shaker(COLS[2], ROWS[1])
    # the trash chute in A4: an open black bin
    x0, x1, y0, y1 = COLS[3] - 63, COLS[3] + 63, ROWS[0] - 42, ROWS[0] + 42
    for a in ((x0, x1, y0, y0 + 2.5), (x0, x1, y1 - 2.5, y1), (x0, x0 + 2.5, y0, y1), (x1 - 2.5, x1, y0, y1)):
        P.append(K.span(*a, DECK, DECK + 110, "tiprack", 0.8, 2))
    P.append(K.span(x0, x1, y0, y1, DECK, DECK + 2, "tiprack", 0.5, 1))
    return P


def gantry():
    """rails are static; the moving part: beam across y on two carriages, Z carriage, 8-channel head"""
    y0, y1 = RAIL_Y
    M = [K.span(-35, 35, y0 - 20, y0 + 20, RAIL_Z - 12, RAIL_Z + 18, "black_anod", 1.5, 2),
         K.span(-35, 35, y1 - 20, y1 + 20, RAIL_Z - 12, RAIL_Z + 18, "black_anod", 1.5, 2),
         K.span(-30, 30, y0 + 20, y1 - 20, RAIL_Z - 42, RAIL_Z - 2, "inst_white", 2.0, 3),
         K.span(-20, 20, HEAD_Y - 40, HEAD_Y + 40, RAIL_Z - 150, RAIL_Z - 42, "black_anod", 1.5, 2)]
    hz = RAIL_Z - 150
    Hd = []
    # Flex-like 8-channel: a white body with a dark front window, a tapered lower body, the grey ejector
    # sleeve over the nozzle row, 8 nozzles with shoulders
    Hd.append(K.prism(K.rrect(78, 118, 10, 4, 0, HEAD_Y), hz - 120, hz, "inst_white", bev=3.0, seg=3))
    Hd.append(taper((78, 118), (46, 96), hz - 170, hz - 120, HEAD_Y))
    Hd.append(K.span(-39.5, -38.8, HEAD_Y - 40, HEAD_Y + 40, hz - 100, hz - 30, "black_anod", 0.2, 1))
    Hd.append(K.span(-39.7, -39.4, HEAD_Y - 36, HEAD_Y - 24, hz - 26, hz - 20, "led_white", 0.1, 1))
    Hd.append(K.prism(K.rrect(30, 94, 6, 3, 0, HEAD_Y), hz - 186, hz - 170, "inst_grey", bev=1.5, seg=2))
    for k in range(8):
        y = HEAD_Y - 31.5 + 9 * k
        noz = [(0, -24), (1.3, -24), (1.9, -12), (2.3, -10.5), (2.3, -9), (3.2, -8), (3.4, 0), (0, 0)]
        Hd.append(K.lathe(noz, K.nseg(16, 6), "steel").moved(t=(0, y, hz - 186)))
    # the chain's moving end bracket on the rear carriage
    M.append(K.span(-10, 10, CH["y"] - 18, y1 - 20, RAIL_Z + 18, CH["z"] + 2 * CH["R"] + 6, "black_anod", 0.8, 1))
    return M, Hd


def taper(top, bot, z0, z1, cy, key="inst_white"):
    """a box whose rounded outline shrinks from top (w, d) at z1 to bot at z0, centred on (0, cy)"""
    a, b = K.rrect(*top, 10, 4, 0, cy), K.rrect(*bot, 8, 4, 0, cy)
    n = len(a)
    V = [(x, y, z1) for x, y in a] + [(x, y, z0) for x, y in b]
    L = list(range(n)) + list(range(2 * n - 1, n - 1, -1))
    C = [n, n]
    for i in range(n):
        j = (i + 1) % n
        L += [i + n, j + n, j, i]
        C.append(4)
    return K.Part(V, L, C, [K.kid(key)] * len(C))


def rails():
    P = []
    for y in RAIL_Y:
        P.append(K.span(-386, 386, y - 12, y + 12, RAIL_Z - 12 - 16, RAIL_Z - 12, "alu", 1.0, 2))
        P.append(K.span(-386, 386, y - 6, y + 6, RAIL_Z - 12, RAIL_Z - 10, "steel", 0.3, 1))
    # the chain trough over the rear rail: floor and two walls
    y = CH["y"]
    P += [K.span(-386, 60, y - 18, y + 18, CH["z"] - 3, CH["z"], "alu", 0.6, 1),
          K.span(-386, 60, y - 20, y - 18, CH["z"] - 3, CH["z"] + 30, "alu", 0.5, 1),
          K.span(-386, 60, y + 18, y + 20, CH["z"] - 3, CH["z"] + 30, "alu", 0.5, 1)]
    for y in (160, 530):
        hs, df = H.led_bar(740, 10, "led_white", "alu", depth=3, lip=2)
        m = K.rot("x", 90)
        P += [hs.moved(m, (0, y, HT - 7)), df.moved(m, (0, y, HT - 7))]
    return P


def chain_links(S):
    """a straight chain of links along +x from 0 to S, centred on the path (the curve modifier bends it)"""
    P, pitch = [], 12.0
    for k in range(int(S / pitch)):
        x = k * pitch
        for sy in (-1, 1):
            P.append(K.span(x + 0.4, x + pitch - 0.4, sy * 13 - 2, sy * 13 + 2, -9, 9, "polymer_black", 0.8, 1))
        P.append(K.span(x + 2, x + pitch - 2, -11, 11, 7, 9, "polymer_black", 0.4, 1, web_keep=False))
    return P


def chain_path(ctx, gantry_ob, chain_ob):
    """a poly curve: fixed end, lower run, loop (hooked to a half-speed empty), upper run to the
    carriage (hooked to the gantry); the chain object bends along it"""
    R, S, z, y = CH["R"], CH["S"], CH["z"] + 9, CH["y"]
    xf, xc = 40.0, 0.0
    xl = (xc + xf - S) / 2
    pts = [(xf, y, z)]
    for k in range(9):
        a = math.pi * k / 8
        pts.append((xl - R * math.sin(a), y, z + R - R * math.cos(a)))
    pts.append((xc, y, z + 2 * R))
    cu = bpy.data.curves.new(ctx.name + ".chain_path", "CURVE")
    cu.dimensions = "3D"
    sp = cu.splines.new("POLY")
    sp.points.add(len(pts) - 1)
    for p, c in zip(sp.points, pts):
        p.co = (c[0] / 1000, c[1] / 1000, c[2] / 1000, 1)
    path = bpy.data.objects.new(ctx.name + ".chain_path", cu)
    path.hide_render = True
    loop = bpy.data.objects.new(ctx.name + ".chain_loop", None)
    cl = loop.constraints.new("COPY_LOCATION")
    cl.target, cl.use_y, cl.use_z, cl.use_offset, cl.influence = gantry_ob, False, False, True, 0.5
    for ob, idx in ((loop, range(1, 10)), (gantry_ob, [10])):
        h = path.modifiers.new("hook_" + ob.name, "HOOK")
        h.object = ob
        h.vertex_indices_set(list(idx))
    cm = chain_ob.modifiers.new("bend", "CURVE")
    cm.object, cm.deform_axis = path, "POS_X"
    return {"chain_path": path, "chain_loop": loop}


def build(ctx):
    T = ctx.lab["T_mm"]
    m = B.Model(ctx, ctx.name, base=(0, 0, T))
    m.origin["led"] = B.item_at(ctx, "anim_lh_led_0", T)
    m.origin["chain"] = (0, 0, 0)
    up = lambda p: p.moved(t=(0, 0, T))
    for sx in (-1, 1):
        P, G = cheek(sx)
        m.add(*map(up, P + G))
        for y in (170, 530):
            m.add(up(H.foot_rubber(30, 12).moved(t=(sx * 380, y, 0))))
    P, door, hs, df = bezel()
    m.add(*map(up, P + [door, hs]))
    m.add(up(df), sub="led")
    body, glass, ui = screen()
    m.add(*map(up, body + [glass]))
    m.add(up(ui), sub="screen")
    # base pan, rear panel with vents and connectors, roof window
    m.add(up(K.span(-386, 386, 152, 540, 12, 90, "frame_dark", 1.0, 1)))
    m.add(up(K.span(-386, 386, 540, Y1, 12, HT, "inst_white", 1.5, 2)))
    for x in (-230, 0, 230):
        m.add(up(H.slots_grille(180, 110, 8, 150, 5, "inst_white", t=1.5).moved(K.FACE["+y"], (x, Y1 + 1.5, 560))))
    m.add(up(K.span(240, 370, Y1, Y1 + 1.0, 40, 100, "black_anod", 0.5, 1)))
    m.add(up(K.span(260, 290, Y1 + 1, Y1 + 12, 55, 80, "polymer_grey", 1.0, 2)))
    for x in (320, 345):
        m.add(up(K.span(x - 7, x + 7, Y1 + 0.5, Y1 + 1.4, 62, 68, "tag_black", 0.2, 1)))
    cab = K.fillet_path([(275, Y1 + 11, 67), (275, Y1 + 15, 67), (275, Y1 + 15, HT - 40), (60, Y1 + 15, HT + 10), (0, Y1 - 5, HT + 30)], 40, 6)
    m.add(up(K.sweep(cab, 4.5, "cable", 10)))
    m.add(up(K.span(-386, 386, 152, 540, HT - 7, HT - 2, "glass", 0.8, 2)))
    m.add(*map(up, deck() + rails()))
    M, Hd = gantry()
    m.add(*map(up, M), sub="gantry")
    m.add(*map(up, Hd), sub="head")
    m.add(*chain_links(CH["S"] + math.pi * CH["R"]), sub="chain")
    out = m.finish(tint=("led",))
    if not K.web():
        out.update(chain_path(ctx, out["gantry"], out["chain"]))
    return out
