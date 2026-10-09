"""Room props for make_lab.py: bench glassware, a centrifuge, pipettes, a stool, a laptop with an
analysis plot, the sample carousel's racks, the e-stop head and the wall text (world frame, mm).
numpy only, deterministic."""
import math

from .mesh import (Mesh, bar, box, circle, cyl, cyl_between, extrude, moved, rbox, revolve, rot, rrect,
                      text, torus)

SEG = 32
FACE_Y = rot('x', 90)


def beaker(R, H, t=1.6, fill=None):
    glass = Mesh().add(revolve([(0, 0), (R - 3, 0), (R, 3), (R, H - 4), (R + 1.5, H), (R + 1.5 - t, H), (R - t, H - 4),
                                (R - t, t + 2), (R - t - 2, t), (0, t)], SEG))
    liq = fill and Mesh().add(revolve([(0, t + 0.3), (R - t - 2.2, t + 0.3), (R - t - 0.3, t + 2.3), (R - t - 0.3, fill), (0, fill)], SEG))
    return glass, liq


def flask(R, H, neck, neck_z, t=1.6, fill=None):
    o = [(0, 0), (R - 5, 0), (R - 1, 2), (R, 6), (neck + 2, neck_z - 6), (neck, neck_z), (neck, H - 3), (neck + 1.5, H - 1.5), (neck + 1.5, H)]
    i = [(neck - t, H), (neck - t, neck_z), (neck + 2 - t, neck_z - 7), (R - t, 7), (R - t - 4, t), (0, t)]
    glass = Mesh().add(revolve(o + i, SEG))
    liq = None
    if fill:
        # the cone's inner radius at the fill height
        z0, z1, r0, r1 = 7.0, neck_z - 7, R - t, neck + 2 - t
        rf = r0 + (r1 - r0) * (fill - z0) / (z1 - z0) - 0.4
        liq = Mesh().add(revolve([(0, t + 0.3), (R - t - 4.2, t + 0.3), (R - t - 0.4, 7.2), (rf, fill), (0, fill)], SEG))
    return glass, liq


def bottle(R, H, fill=None):
    """A GL45 reagent bottle as a solid (the glass reads through alpha), with its cap."""
    prof = [(0, 0), (R - 4, 0), (R, 4), (R, H * 0.68), (R - 6, H * 0.77), (R * 0.62, H * 0.85), (24, H * 0.9), (24, H), (0, H)]
    glass = Mesh().add(revolve(prof, SEG))
    liq = fill and Mesh().add(revolve([(0, 1.5), (R - 4.5, 1.5), (R - 1.2, 4.5), (R - 1.2, fill), (0, fill)], SEG))
    knurl = [((27 if j % 2 else 26.2) * math.cos(2 * math.pi * j / 40), (27 if j % 2 else 26.2) * math.sin(2 * math.pi * j / 40)) for j in range(40)]
    cap = Mesh().add(revolve([(0, H - 22), (28.5, H - 22), (28.5, H - 17), (0, H - 17)], SEG)).add(extrude(knurl, H - 17, H + 6))
    return glass, liq, cap


def microscope():
    white, dark, steel = Mesh(), Mesh(), Mesh()
    white.add(extrude(rrect(190, 240, 24, 5), 0, 42))
    white.add(extrude(rrect(64, 70, 12, 3), 36, 300), t=(0, 82, 0))
    white.add(extrude(rrect(84, 200, 20, 4), 268, 330), t=(0, 8, 0))
    white.add(extrude(rrect(56, 60, 10, 3), 330, 368), t=(0, -24, 0))
    for sx in (-1, 1):
        dark.add(cyl_between((sx * 17, -34, 356), (sx * 21, -92, 414), 11, 24))
        dark.add(cyl_between((sx * 21, -92, 414), (sx * 22, -100, 422), 13, 24))
        dark.add(cyl_between((sx * 32, 86, 150), (sx * 48, 86, 150), 28, 32))
        dark.add(cyl_between((sx * 48, 86, 150), (sx * 60, 86, 150), 16, 24))
    dark.add(cyl(32, 260, 270, 32), t=(0, -50, 0))
    dark.add(box((150, 140, 12), (0, -52, 176)))
    dark.add(box((44, 44, 30), (0, 34, 168)))
    dark.add(cyl(18, 140, 170, 24), t=(0, -52, 0))
    for a in (0, 120, 240):
        x, y = 16 * math.sin(math.radians(a)), -50 - 16 * math.cos(math.radians(a))
        steel.add(cyl_between((x, y, 262), (x * 1.3, y - (y + 50) * 0.3, 226), 7.5, 20))
    steel.add(cyl(22, 42, 48, 32), t=(0, -52, 0))
    return {'microscope_white': white, 'microscope_dark': dark, 'microscope_steel': steel}


def centrifuge():
    white, grey, dark = Mesh(), Mesh(), Mesh()
    white.add(extrude(rrect(300, 360, 40, 6), 0, 210))
    grey.add(extrude(rrect(284, 250, 34, 6), 210, 236), t=(0, 40, 0))
    grey.add(revolve([(0, 236), (80, 236), (70, 250), (0, 252)], SEG), t=(0, 40, 0))
    dark.add(box((260, 80, 14), (0, 0, 0)), R=rot('x', 28), t=(0, -128, 190))
    dark.add(cyl(18, 0, 12, 24), R=rot('x', -62), t=(90, -160, 175))
    return {'centrifuge_white': white, 'centrifuge_grey': grey, 'centrifuge_dark': dark}


def pipettes():
    grey, steel, white, button = Mesh(), Mesh(), Mesh(), Mesh()
    grey.add(extrude(circle(75, 40), 0, 18))
    grey.add(extrude(circle(62, 40), 296, 308))
    steel.add(cyl(7, 18, 336, 24))
    prof = [(0, 0), (0.7, 0), (3.5, 48), (4.5, 54), (4.5, 118), (11, 132), (13.5, 188), (12.5, 226), (9, 236), (5, 238), (5, 254), (0, 254)]
    for a in (90, 210, 330):
        x, y = 50 * math.cos(math.radians(a)), 50 * math.sin(math.radians(a))
        white.add(revolve(prof, 24), t=(x, y, 70))
        button.add(cyl(7, 324, 334, 24), t=(x, y, 0))
    return {'pipette_stand': grey, 'pipette_pole': steel, 'pipettes': white, 'pipette_buttons': button}


def stool():
    black, steel, seat = Mesh(), Mesh(), Mesh()
    black.add(cyl(46, 70, 124, 32))
    for k in range(5):
        R = rot('z', 90 + 72 * k)
        black.add(box((236, 40, 30), (150, 0, 92)), R=R)
        black.add(cyl_between((262, -12, 26), (262, 12, 26), 26, 20), R=R)
        black.add(box((24, 30, 40), (262, 0, 66)), R=R)
    black.add(cyl(30, 124, 330, 32))
    steel.add(cyl(21, 330, 560, 32))
    steel.add(torus(210, 9, 48, 10), t=(0, 0, 330))
    for k in range(3):
        steel.add(cyl_between((28, 0, 330), (205, 0, 330), 6, 12), R=rot('z', 30 + 120 * k))
    seat.add(revolve([(0, 560), (168, 560), (182, 570), (186, 590), (181, 611), (166, 622), (0, 625)], 48))
    return {'stool_black': black, 'stool_steel': steel, 'stool_seat': seat}


def laptop():
    """A laptop facing -y, lid at 105°, with a warm analysis screen and its plot strokes."""
    body, screen, plot = Mesh(), Mesh(), Mesh()
    body.add(rbox(330, 230, 16, 8, (0, 0, 0)))
    R, h = rot('x', 15), (0, 115, 16)                  # the lid leans back 15° from vertical
    body.add(box((330, 8, 220), (0, 4, 110)), R, h)
    screen.add(box((300, 1, 190), (0, -0.6, 112)), R, h)
    pts = [(-130, 60), (-100, 72), (-70, 66), (-40, 98), (-10, 90), (20, 130), (50, 122), (80, 150), (120, 146)]
    for p, q in zip(pts[:-1], pts[1:]):                # 1.2 mm proud of the screen face (y -1.1)
        plot.add(moved(Mesh().add(bar(p, q, 3, 0), None, (0, 0, 0.6)), FACE_Y, (0, -1.7, 0)), R, h)
    for k, v in enumerate((0.22, 0.31, 0.93, 0.27)):
        plot.add(moved(Mesh().add(box((18, 60 * v, 0.6), (-120 + 26 * k, 30 * v + 20, 0.3))), FACE_Y, (0, -1.7, 0)), R, h)
    return {'laptop_body': body, 'laptop_screen': screen, 'laptop_plot': plot}


def carousel():
    """Racks inside the sample-storage carousel: a column, 8 shelves of plate stacks."""
    frame, plates = Mesh(), Mesh()
    frame.add(cyl(18, 200, 1880, 12))
    for k in range(8):
        z = 300 + 190 * k
        frame.add(cyl(215, z, z + 6, 24))
        for j in range(6):
            a = math.radians(30 + 60 * j + 15 * (k % 2))
            plates.add(box((86, 128, 36 + 20 * ((j + k) % 3)), (0, 0, 0)), rot('z', math.degrees(a)),
                       (140 * math.cos(a), 140 * math.sin(a), z + 6 + (36 + 20 * ((j + k) % 3)) / 2))
    return {'carousel_rack': frame, 'carousel_plates': plates}


def estop():
    """The e-stop head: a red mushroom on a yellow collar, facing up."""
    red = Mesh().add(revolve([(0, 0), (26, 0), (26, 16), (38, 20), (40, 28), (34, 36), (0, 38)], 32))
    ring_m = Mesh().add(torus(34, 6, 32, 8), None, (0, 0, 2))
    return {'estop_red': red, 'estop_ring': ring_m}


def wall_text():
    """Text on the back wall's dashboard and the freezer panel, facing -y (world mm)."""
    dash = Mesh()
    y = 1925.4
    dash.add(moved(text('ENZYME SCREEN  ROUND 3', 44, t=0, lift=0.6), FACE_Y, (-1860, y, 1860)))
    for k, w in enumerate(('DESIGN', 'BUILD', 'TEST', 'LEARN')):
        dash.add(moved(text(w, 26, t=0, lift=0.6, align='center'), FACE_Y, (-1750 + 300 * k, y, 1650)))
    for k in range(3):
        dash.add(moved(text('>', 30, t=0, lift=0.6, align='center'), FACE_Y, (-1600 + 300 * k, y, 1712)))
    dash.add(moved(text('AI-DESIGNED CANDIDATES', 22, t=0, lift=0.6), FACE_Y, (-1860, y, 1560)))
    for k in range(4):
        dash.add(moved(text('ART-%d' % (k + 1), 16, t=0, lift=0.6, align='center'), FACE_Y, (-1780 + 110 * k, y, 1270)))
    dash.add(moved(text('ACTIVITY  EX 480 / EM 520', 18, t=0, lift=0.6), FACE_Y, (-1300, y, 1560)))
    hist = [(-1300, 1300), (-1220, 1330), (-1140, 1320), (-1060, 1380), (-980, 1360), (-900, 1440), (-820, 1470)]
    for p, q in zip(hist[:-1], hist[1:]):
        dash.add(moved(Mesh().add(bar((p[0], p[1] - 1300), (q[0], q[1] - 1300), 5, 0), None, (0, 0, 0.6)), FACE_Y, (0, y, 1300)))
    freezer = moved(text("-80'C", 36, t=0, lift=0.6, align='center'), FACE_Y, (1100, 1127.3, 1782))
    return {'dash_text': dash, 'freezer_text': freezer}


def room_props():
    out = {}
    b6, b6l = beaker(45, 125, fill=78)
    b2, b2l = beaker(34, 92, fill=52)
    f5, f5l = flask(52, 182, 17, 132, fill=62)
    f2, f2l = flask(40, 145, 14, 104, fill=40)
    out.update(beaker_600=b6, beaker_600_liquid=b6l, beaker_250=b2, beaker_250_liquid=b2l,
               flask_500=f5, flask_500_liquid=f5l, flask_250=f2, flask_250_liquid=f2l)
    g, gl, cap = bottle(48, 215, fill=120)
    out.update(bottle_1l=g, bottle_1l_liquid=gl, bottle_cap=cap)
    for f in (microscope, centrifuge, pipettes, stool, laptop, carousel, estop, wall_text):
        out.update(f())
    return out
