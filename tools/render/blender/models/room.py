"""The closed room (world frame, mm): eggshell walls with a 100 mm flash cove and alu cap, the T24
ceiling (600 tiles, 15 mm tees), 6 + 1 recessed LED panels as emitter parts `panel_<k>`, the glass
partition at x 2300 (float glass, frosted band, alu mullions, a door with push plate and a BSL-2 sign)
and a plain corridor beyond it with its own panels and a distant daylight window (part `daylight`).
The front wall (y -1500) has the anteroom door with a vision panel onto a lit anteroom, lab coats on a
rail, a whiteboard, a clock, a sanitiser, a switch and sockets. Everything is
camera-visible; the web LOD keeps the open front and no ceiling (its orbit camera sits outside)."""
import math

import _bl as B
import _kit as K

ROLE = "room"
X0, X1, Y0, Y1, ZC = -2100.0, 2300.0, -1500.0, 1950.0, 2700.0
PANELS = [(x, y, 600, 600) for x in (-1200, 0, 1200) for y in (150, 1350)] + [(-1500, 1800, 1200, 300)]
DOOR = (-1100.0, -100.0)     # partition door span in y
FDOOR = (-1250.0, -250.0)    # front-wall door opening span in x (frame outside), height FH
FH = 2150.0
FY = Y0 - 100                # the front wall's back face


def cove(a, b, n):
    """a flash cove along the wall face from a to b (xy), n = the room-side normal: an r 20 quarter
    round, the vinyl up to 100 and an alu cap"""
    import numpy as np
    a, b, n = np.array(a, float), np.array(b, float), np.array(n, float)
    t = (b - a) / np.linalg.norm(b - a)
    rows = [(20 - 20 * math.sin(math.radians(g)), 20 - 20 * math.cos(math.radians(g))) for g in range(0, 91, 15)] + [(0.0, 100.0)]
    V = [tuple(q + n * (d + 0.05)) + (z + 0.05,) for q in (a, b) for d, z in rows]
    m, flip = len(rows), t[0] * n[1] - t[1] * n[0] > 0
    L = []
    for j in range(m - 1):
        L += [j, j + 1, m + j + 1, m + j] if flip else [j, m + j, m + j + 1, j + 1]
    cv = K.Part(V, L, [4] * (m - 1), [K.kid("floor_vinyl")] * (m - 1))
    lo, hi = np.minimum(a, b) + np.minimum(n * 4, 0), np.maximum(a, b) + np.maximum(n * 4, 0)
    return [cv, K.span(lo[0], hi[0], lo[1], hi[1], 98, 104, "skirting", 0.8, 2)]


def ceiling():
    """600 tiles on 15 mm white tees (the grid centred on x 0 and y 150)"""
    P = [K.span(X0, X1, Y0, Y1, ZC, ZC + 15, "ceiling_tile", 0, 0)]
    for x in range(-2100, 2301, 600):
        P.append(K.span(x - 7.5, x + 7.5, Y0, Y1, ZC - 8, ZC, "ceiling_grid", 1.0, 1))
    for y in range(-1350, 1951, 600):
        P.append(K.span(X0, X1, y - 7.5, y + 7.5, ZC - 8, ZC, "ceiling_grid", 1.0, 1))
    return P


def panel(cx, cy, w, d):
    """a lay-in panel: a 10 mm frame ring (hiding the tee under a 1200 module) and, inside it behind a 2 mm
    shadow gap, the opal diffuser (the emitter), open to the room below"""
    x0, x1, y0, y1, f = cx - w / 2 + 8, cx + w / 2 - 8, cy - d / 2 + 8, cy + d / 2 - 8, 10.0
    fr = [K.span(x0, x1, y0, y0 + f, ZC - 10, ZC - 1, "ceiling_grid", 0.8, 2), K.span(x0, x1, y1 - f, y1, ZC - 10, ZC - 1, "ceiling_grid", 0.8, 2),
          K.span(x0, x0 + f, y0 + f, y1 - f, ZC - 10, ZC - 1, "ceiling_grid", 0.8, 2), K.span(x1 - f, x1, y0 + f, y1 - f, ZC - 10, ZC - 1, "ceiling_grid", 0.8, 2),
          K.span(x0 + f, x1 - f, y0 + f, y1 - f, ZC - 1.5, ZC - 1, "tag_black", 0, 0)]
    g = f + 2.0
    df = K.span(x0 + g, x1 - g, y0 + g, y1 - g, ZC - 9.0, ZC - 8.0, "panel_light", 0.4, 1)
    return fr, df


def partition():
    """float glass at x 2300 between alu mullions, a frosted band 900..1500, and the door"""
    x, P, G = X1, [], []
    posts = [-1500, -1100, -100, 300, 1000, 1950]
    for y in posts:
        P.append(K.span(x - 25, x + 25, y - 25, y + 25, 0, ZC, "alu", 1.5, 2))
    P.append(K.span(x - 30, x + 30, Y0, Y1, 0, 60, "alu", 1.5, 2))
    P.append(K.span(x - 30, x + 30, Y0, Y1, ZC - 60, ZC, "alu", 1.5, 2))
    P.append(K.span(x - 25, x + 25, DOOR[0], DOOR[1], 2100, 2160, "alu", 1.5, 2))
    for y0, y1 in zip(posts[:-1], posts[1:]):
        if (y0, y1) == DOOR:
            continue
        G.append(K.span(x - 5, x + 5, y0 + 25, y1 - 25, 60, ZC - 60, "glass_float", 0.8, 2))
        G.append(K.span(x - 5.1, x - 5.0, y0 + 25, y1 - 25, 900, 1500, "glass_frosted", 0, 0))
    # the door: a glass leaf in an alu frame, push plate, closer
    y0, y1 = DOOR[0] + 30, DOOR[1] - 30
    P += [K.span(x - 22, x + 22, y0, y0 + 60, 5, 2095, "alu", 1.5, 2), K.span(x - 22, x + 22, y1 - 60, y1, 5, 2095, "alu", 1.5, 2),
          K.span(x - 22, x + 22, y0 + 60, y1 - 60, 5, 150, "alu", 1.5, 2), K.span(x - 22, x + 22, y0 + 60, y1 - 60, 2040, 2095, "alu", 1.5, 2)]
    G.append(K.span(x - 5, x + 5, y0 + 55, y1 - 55, 145, 2045, "glass_float", 0.8, 2))
    G.append(K.span(x - 5, x + 5, DOOR[0] + 25, DOOR[1] - 25, 2160, ZC - 60, "glass_float", 0.8, 2))
    P.append(K.span(x - 27, x - 22, y1 - 300, y1 - 200, 1000, 1300, "steel_brushed", 0.8, 2))
    P.append(K.span(x - 60, x - 22, y0 + 100, y0 + 400, 2060, 2110, "alu", 3.0, 2))
    # BSL-2 sign by the door (the standard trefoil stands in as a ring glyph), room side
    P.append(K.span(x - 27, x - 26, DOOR[1] + 60, DOOR[1] + 260, 1500, 1700, "hazard_yellow", 0.3, 1))
    P.append(K.text("BSL-2", 34, "label_ink", web_keep=True).moved(K.FACE["-x"], (x - 27.1, DOOR[1] + 160, 1530)))
    P.append(K.lathe([(26, 0), (34, 0), (34, 0.3), (26, 0.3), (26, 0)], K.nseg(32), "label_ink").moved(K.FACE["-x"], (x - 27.05, DOOR[1] + 160, 1630)))
    return P, G


def corridor():
    x0, x1 = X1 + 30, X1 + 1830
    P = [K.span(x0, x1, Y0 - 800, Y1 + 400, -20, 0, "floor_vinyl", 0, 0),
         K.span(x1, x1 + 100, Y0 - 800, Y1 + 400, 0, ZC, "wall", 0, 0),
         K.span(x0, x1, Y0 - 800, Y1 + 400, ZC, ZC + 20, "ceiling_tile", 0, 0)]
    em = [K.span(x0 + 600, x0 + 1200, y - 300, y + 300, ZC - 6, ZC, "panel_light", 0, 0) for y in (-1000, 500, 2000)]
    win = K.span(x1 - 5, x1, -900, 1300, 700, 2400, "daylight", 0, 0)
    return P, em, win


def _wall_part(poly, t, key, bev, at):
    """an outline in (x, z) extruded t mm off the front wall's face into the room, placed at at=(x, y, z)"""
    import numpy as np
    R = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], float)          # outline y -> z, extrusion z -> -y
    return K.prism(poly, -t, 0, key, bev, 3).moved(R, at)


def _face(p, at):
    """a lathe / XY part turned to face into the room (+y)"""
    return p.moved(K.rot("x", -90), at)


def door():
    """a steel frame, a 40 mm beech-HPL leaf with a wired-glass vision panel, lever, hinges, kick plate, closer"""
    a, b, y = FDOOR[0], FDOOR[1], Y0
    P = [K.span(a, a + 50, FY, y + 12, 0, FH, "inst_grey", 1.5, 2), K.span(b - 50, b, FY, y + 12, 0, FH, "inst_grey", 1.5, 2),
         K.span(a, b, FY, y + 12, FH - 50, FH, "inst_grey", 1.5, 2), K.span(a + 50, b - 50, FY, y, -1, 4, "steel_brushed", 1.0, 1)]
    x0, x1, z0, z1 = a + 53, b - 53, 6.0, FH - 53
    ly0, ly1 = y - 58, y - 18
    vx0, vx1, vz0, vz1 = (x0 + x1) / 2 - 140, (x0 + x1) / 2 + 140, 1250.0, 1900.0
    # a beech HPL leaf: it is what the LH door mirrors around the robot, and a white one set the robot off as a dark figure
    P += [K.span(x0, vx0, ly0, ly1, z0, z1, "door_hpl", 1.5, 2), K.span(vx1, x1, ly0, ly1, z0, z1, "door_hpl", 1.5, 2),
          K.span(vx0, vx1, ly0, ly1, z0, vz0, "door_hpl", 1.5, 2), K.span(vx0, vx1, ly0, ly1, vz1, z1, "door_hpl", 1.5, 2)]
    for u0, u1, w0, w1 in ((vx0 - 12, vx0 + 8, vz0 - 12, vz1 + 12), (vx1 - 8, vx1 + 12, vz0 - 12, vz1 + 12),
                           (vx0 - 12, vx1 + 12, vz0 - 12, vz0 + 8), (vx0 - 12, vx1 + 12, vz1 - 8, vz1 + 12)):
        P.append(K.span(u0, u1, ly1, ly1 + 6, w0, w1, "alu", 1.0, 1))
    G = [K.span(vx0, vx1, y - 41, y - 35, vz0, vz1, "glass_float", 0, 0)]
    P.append(K.span(x0 + 8, x1 - 8, ly1, ly1 + 1.5, z0 + 4, 300, "steel_brushed", 0.5, 1))
    hx, hz = x1 - 70, 1050.0
    P += [_face(K.cyl(28, 0, 10, "steel_brushed", 32, 1.5), (hx, ly1, hz)),
          K.bar((hx, ly1 + 55, hz), (hx - 130, ly1 + 55, hz - 4), 9, "steel_brushed", 16),
          K.bar((hx, ly1 + 8, hz), (hx, ly1 + 58, hz), 9, "steel_brushed", 16),
          _face(K.cyl(16, 0, 8, "steel_brushed", 24, 1.0), (hx, ly1, hz - 110))]
    P += [K.cyl(9, z, z + 110, "steel_brushed", 16, 1.5, at=(x0 - 1, y - 12)) for z in (240.0, 1050.0, 1840.0)]
    P += [K.span(x0 + 90, x0 + 360, y - 18, y + 38, z1 - 70, z1 - 20, "alu", 3.0, 2),
          K.bar((x0 + 330, y + 30, z1 - 45), (x0 + 520, y + 20, FH - 25), 7, "black", 12)]
    P += [K.span(b + 90, b + 290, y, y + 2, 1450, 1640, "tag_white", 0.3, 1),
          K.text("ANTEROOM", 26, "label_ink", web_keep=True).moved(K.FACE["+y"], (b + 190, y + 2.1, 1580)),
          K.text("lab coat + gloves", 17, "label_ink", web_keep=True).moved(K.FACE["+y"], (b + 190, y + 2.1, 1500))]
    P += [K.span(b + 110, b + 196, y, y + 9, 1010, 1096, "tag_white", 1.5, 2), K.span(b + 140, b + 166, y + 9, y + 14, 1030, 1076, "tag_white", 1.0, 1)]
    P += [K.span(b + 250, b + 350, y, y + 95, 1180, 1400, "polymer_white", 6.0, 3), K.span(b + 280, b + 320, y + 60, y + 90, 1165, 1180, "polymer_grey", 2.0, 2),
          K.span(b + 262, b + 338, y + 95, y + 96, 1330, 1380, "polymer_grey", 0.3, 1)]
    return P, G


def anteroom():
    """the lit anteroom behind the door: seen through the vision panel"""
    x0, x1, y0, y1 = FDOOR[0] - 500, FDOOR[1] + 500, FY - 1800, FY
    P = [K.span(x0, x1, y0, y1, -20, 0, "floor_vinyl", 0, 0), K.span(x0, x1, y0 - 100, y0, 0, ZC, "wall", 0, 0),
         K.span(x0 - 100, x0, y0 - 100, y1, 0, ZC, "wall", 0, 0), K.span(x1, x1 + 100, y0 - 100, y1, 0, ZC, "wall", 0, 0),
         K.span(x0 - 100, x1 + 100, y0 - 100, y1, ZC, ZC + 20, "ceiling_tile", 0, 0),
         K.span(x0 + 150, x1 - 150, y0, y0 + 2, 1100, 1800, "cardboard", 1.0, 1)]
    for k, (u, w, h) in enumerate(((x0 + 260, 210, 297), (x0 + 520, 297, 210), (x0 + 900, 210, 297), (x0 + 1200, 150, 150))):
        P.append(K.span(u, u + w, y0 + 2, y0 + 3, 1350 - 60 * (k % 2), 1350 - 60 * (k % 2) + h, "label", 0, 0))
    P += [K.span(x0, x1, y0, y0 + 350, 0, 900, "lab_white", 2.0, 2), K.span(x0, x1, y0, y0 + 370, 900, 925, "epoxy", 1.0, 2)]
    em = [K.span((x0 + x1) / 2 - 300, (x0 + x1) / 2 + 300, (y0 + y1) / 2 - 300, (y0 + y1) / 2 + 300, ZC - 6, ZC, "panel_light", 0, 0)]
    return P, em


def drape(prof, h, depth, folds, amp, phase, key, nu=18, nv=24):
    """a hanging cloth sheet in (x across, y off the wall, z down from the hook), mm: prof(v) is the half
    width at v (0 at the hook, 1 at the hem); the front bulges `depth` and carries `folds` hanging folds whose
    amplitude grows to `amp` at the hem; a thin back and closed edges"""
    import numpy as np
    V = []
    for back in (0, 1):
        for j in range(nv + 1):
            v = j / nv
            for i in range(nu + 1):
                u = 2 * i / nu - 1
                fold = amp * v ** 1.3 * math.sin(math.pi * folds * (u + 1) + phase + 1.9 * v)
                y = 2.0 + 0.3 * fold if back else 5.0 + depth * math.sqrt(max(0.0, 1 - u * u)) * (0.55 + 0.45 * v) + fold
                V.append((u * prof(v), y, -h * v))
    at = lambda b, i, j: b * (nu + 1) * (nv + 1) + j * (nu + 1) + i  # noqa: E731
    F = [(at(0, i, j), at(0, i + 1, j), at(0, i + 1, j + 1), at(0, i, j + 1)) for j in range(nv) for i in range(nu)]
    F += [(at(1, i, j + 1), at(1, i + 1, j + 1), at(1, i + 1, j), at(1, i, j)) for j in range(nv) for i in range(nu)]
    rim = [(i, 0) for i in range(nu)] + [(nu, j) for j in range(nv)] + [(i, nv) for i in range(nu, 0, -1)] + [(0, j) for j in range(nv, 0, -1)]
    for (i, j), (k, m) in zip(rim, rim[1:] + rim[:1]):
        F.append((at(0, i, j), at(1, i, j), at(1, k, m), at(0, k, m)))
    return K.Part(np.array(V, float), [x for f in F for x in f], [4] * len(F), [K.kid(key)] * len(F))


def coat(cx, lean, dy, seed):
    """a lab coat on a hook, dy mm off the wall: a draped body with hanging folds, two sleeves, lapels"""
    import numpy as np
    body = lambda v: float(np.interp(v, (0, 0.07, 0.4, 1), (55, 205, 231, 236)))  # noqa: E731
    R = K.rot("y", lean)
    y = Y0 + dy
    P = [drape(body, 1040, 38, 3.5, 13, seed, "fabric_white").moved(R, (cx, y, 1690))]
    for sx in (-1, 1):
        sl = drape(lambda v: 33 + 4 * v, 700, 22, 1.5, 6, seed + sx, "fabric_white", 8, 16)
        P.append(sl.moved(R, (cx + sx * (208 + 3 * lean), y + 30, 1600)))
    P.append(_wall_part([tuple(K.rot("y", lean)[0::2, 0::2] @ np.array(p, float)) for p in [(-50, -2), (0, -330), (50, -2), (0, -60)]],
                        8, "fabric_white", 3, (cx, y + 62, 1690)))
    return P


def front():
    """the fixtures on the front wall's room face"""
    y = Y0
    P = [K.bar((-1990, y + 30, 1700), (-1370, y + 30, 1700), 12, "alu", 24),
         K.span(-1990, -1975, y, y + 40, 1680, 1720, "alu", 1.0, 1), K.span(-1385, -1370, y, y + 40, 1680, 1720, "alu", 1.0, 1)]
    for k, (cx, lean, dy) in enumerate(((-1830.0, 2.5, 26.0), (-1520.0, -1.5, 92.0))):
        P += [K.bar((cx, y + 30, 1700), (cx, y + dy + 44, 1690), 6, "alu", 12)] + coat(cx, lean, dy, 1.3 + 2.1 * k)
    bx0, bx1, bz0, bz1 = 250.0, 1850.0, 900.0, 2000.0
    P += [K.span(bx0, bx1, y, y + 16, bz0, bz1, "alu", 2.0, 2)]
    P += [K.span(bx0 + 18, bx1 - 18, y + 16, y + 17, bz0 + 18, bz1 - 18, "tag_white", 0, 0)]
    # seen from the room, the board's left edge is its +x end: left-aligned lines start there and run to -x
    ink = [("run 14 · ART-1..4", 40, 1740, 1880, "label_ink"), ("ex 480 / em 520", 30, 1740, 1800, "label_ink"),
           ("ART-3 hit!", 46, 900, 1860, "polymer_red"), ("next: round 15 (mutate C)", 28, 1740, 1100, "polymer_blue"),
           ("inc 37 °C · 30 min", 28, 1740, 1040, "polymer_blue")]
    for s, size, u, w, key in ink:
        P.append(K.text(s, size, key, align="LEFT", web_keep=True).moved(K.FACE["+y"], (u, y + 17.1, w)))
    for k, h in enumerate((90, 140, 380, 110)):
        u = 1580 - 110 * k
        P.append(K.span(u, u + 70, y + 17, y + 17.3, 1300, 1300 + h, "polymer_red" if k == 2 else "polymer_blue", 0, 0))
    P += [K.span(1230, 1664, y + 17, y + 17.3, 1296, 1300, "label_ink", 0, 0), K.span(1660, 1664, y + 17, y + 17.3, 1296, 1720, "label_ink", 0, 0)]
    P += [K.span(bx0 + 200, bx1 - 400, y, y + 60, bz0 - 22, bz0 - 2, "alu", 2.0, 2),
          K.bar((700, y + 40, bz0 - 12), (830, y + 44, bz0 - 12), 8, "polymer_blue", 12),
          K.bar((880, y + 38, bz0 - 12), (1010, y + 36, bz0 - 12), 8, "black", 12),
          K.span(1100, 1230, y + 10, y + 55, bz0 - 2, bz0 + 28, "polymer_black", 3.0, 2)]
    cx, cz = 1050.0, 2330.0
    P += [_face(K.ring(140, 158, 0, 42, "polymer_black", 64, 2.0), (cx, y, cz)), _face(K.cyl(141, 0, 30, "tag_white", 64, 0), (cx, y, cz))]
    for k in range(12):
        a = math.radians(30 * k)
        r0, r1 = (104, 128) if k % 3 else (92, 128)
        P.append(K.bar((cx + r0 * math.sin(a), y + 31, cz + r0 * math.cos(a)), (cx + r1 * math.sin(a), y + 31, cz + r1 * math.cos(a)), 3 if k % 3 else 4.5, "black", 6))
    for deg, ln, w in ((-62, 72, 4.5), (38, 112, 3.0)):
        a = math.radians(deg)
        P.append(K.bar((cx, y + 33, cz), (cx + ln * math.sin(a), y + 33, cz + ln * math.cos(a)), w, "black", 6))
    for sx in (150.0, 1950.0):
        P += [K.span(sx - 73, sx + 73, y, y + 10, 257, 343, "tag_white", 1.5, 2)]
        P += [K.span(sx + d - 18, sx + d + 18, y + 10, y + 11, 285, 315, "polymer_grey", 0.4, 1) for d in (-36, 36)]
    return P


def build(ctx):
    m = B.Model(ctx, ctx.name)
    m.add(K.span(X0 - 100, X0, Y0 - 100, Y1 + 100, 0, ZC + 20, "wall", 0, 0), K.span(X0, X1, Y1, Y1 + 100, 0, ZC + 20, "wall", 0, 0))
    m.add(*cove((X0, Y0), (X0, Y1), (1, 0)), *cove((X0, Y1), (X1, Y1), (0, -1)))
    web = getattr(ctx, "lod", "render") == "web"
    a, b = FDOOR
    if web:
        m.add(K.span(X0, X1, FY, Y0, 0, ZC + 20, "wall", 0, 0), *cove((X0, Y0), (X1, Y0), (0, 1)), sub="front_wall")
    else:
        m.add(K.span(X0, a, FY, Y0, 0, ZC + 20, "wall", 0, 0), K.span(b, X1, FY, Y0, 0, ZC + 20, "wall", 0, 0),
              K.span(a, b, FY, Y0, FH, ZC + 20, "wall", 0, 0), *cove((X0, Y0), (a, Y0), (0, 1)), *cove((b, Y0), (X1, Y0), (0, 1)),
              *front(), sub="front_wall")
        P, G = door()
        m.add(*P, sub="front_wall")
        m.add(*G, sub="front_glass")
        P, em = anteroom()
        m.add(*P, *em, sub="anteroom")
    m.add(*ceiling(), sub="ceiling")
    for k, (cx, cy, w, d) in enumerate(PANELS):
        fr, df = panel(cx, cy, w, d)
        m.add(*fr, sub="ceiling")
        m.add(df, sub="panel_%d" % k)
    P, G = partition()
    m.add(*P)
    m.add(*G, sub="glass")
    P, em, win = corridor()
    m.add(*P, *em, sub="corridor")
    m.add(win, sub="daylight")
    out = m.finish()
    for k in ("front_wall", "ceiling") + tuple("panel_%d" % i for i in range(len(PANELS))) if web else ():
        if k in out:
            out[k].visible_camera = False           # the web's orbit camera sits outside the front and above
    return out
