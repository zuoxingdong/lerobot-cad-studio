"""Incubator, a motorised-lid heated block (300 x 290 x 190 over T; station frame, mm): a white body
with a front fascia step, a small OLED "37.0 °C", buttons, side louvres, a rear fan and inlet with its
cable, feet.  Parts: `lid` (a grey heated-lid body with side skirts, the alu pad under it, modelled OPEN as anim_inc_lid_0), `led`
(the status lens) and `ring` (the progress ring), both tinted by the capture."""
import math

import _bl as B
import _hw as H
import _kit as K

ROLE = "station"

HINGE = (115.0, 118.0)       # (y, z over T), axis +x


def lid(deg):
    """the heated lid: a 48 mm deep grey body; under it a ribbed black heater plate with the alu presser and
    its gasket over the nest; deep side skirts that shroud the nest when closed (outboard of the reach
    corridor when open), a short front lip with a latch"""
    P = [K.prism(K.rrect(200, 120, 8, 4, 0, 55), 112, 160, "inst_grey", bev=3.0, seg=3),
         K.span(-80, 80, 4, 106, 110.8, 112.4, "black_anod", 0.6, 2),
         K.span(-31, 31, 29, 91, 109.2, 110.8, "alu", 0.8, 2), K.ring(22, 25, 108.6, 109.2, "rubber", 32, 0.2).moved(t=(0, 60, 0))]
    P += [K.span(-78, 78, y, y + 2.0, 110.0, 110.8, "black_anod", 0.3, 1) for y in (10, 18, 96, 104) if not K.web()]
    P += [K.cyl(7, -60, 60, "inst_grey", 24, 0.8).moved(K.rot("y", 90), (0, HINGE[0], HINGE[1]))]
    for sx in (-1, 1):
        x0, x1 = (97, 100) if sx > 0 else (-100, -97)
        P.append(K.span(x0, x1, -3, 108, 62, 113, "inst_grey", 1.0, 2))
    P.append(K.span(-97, 97, -5, -2, 100, 113, "inst_grey", 1.0, 2))
    P.append(K.span(-26, 26, -9.5, -5, 104, 150, "inst_grey", 2.0, 2))
    P.append(K.span(-20, 20, -11, -9.4, 108, 116, "black", 0.6, 1))
    return [H.hinged(p, HINGE[0], HINGE[1], -deg) for p in P]


def front():
    """fascia panel, OLED window over the digits, buttons, the ring bezel; the lens and ring apart"""
    P = [K.span(-140, 140, 109.0, 110.2, 16, 88, "inst_grey", 1.0, 2)]
    P.append(K.span(-124, -66, 108.0, 109.0, 35, 57, "black", 0.6, 2))       # OLED backing behind the digits
    P.append(K.span(-122, -68, 107.6, 107.95, 37, 55, "touchscreen", 0.2, 1))
    P.append(K.text("37.0 °C", 8.5, "oled_amber", web_keep=True).moved(K.FACE_Y, (-95, 107.97, 42)))
    for x in (-40, -18):
        P.append(K.lathe([(0, 0), (5, 0), (5, 1.2), (4.2, 2.0), (0, 2.1)], K.nseg(24), "inst_grey").moved(K.FACE_Y, (x, 109.0, 46)))
    P.append(K.lathe([(11, 0), (22, 0), (22, 1.0), (21, 1.8), (19.3, 1.8), (19.3, 0.6), (12.7, 0.6), (12.7, 1.8), (11, 1.8), (11, 0)],
                     K.nseg(64), "black").moved(K.FACE_Y, (95, 109.0, 50)))
    ring = K.lathe([(12.9, 0.5), (19.1, 0.5), (19.1, 1.4), (12.9, 1.4), (12.9, 0.5)], K.nseg(64), "led_off").moved(K.FACE_Y, (95, 109.0, 50))
    P.append(K.span(-117, -73, 107.6, 109.0, 75, 83, "black", 0.8, 2))
    led = K.span(-115, -75, 107.2, 108.4, 77, 81, "led_off", 0.6, 2)
    return P, led, ring


def body():
    P = [K.prism(K.rrect(300, 240, 10, 4, 0, 280), 8, 60, "inst_white", bev=2.0, seg=3),
         K.prism(K.rrect(300, 240, 10, 4, 0, 280), 60.6, 190, "inst_white", bev=2.0, seg=3),
         K.prism(K.rrect(300, 54, 6, 4, 0, 137), 8, 100, "inst_white", bev=2.0, seg=3)]
    for sx in (-1, 1):
        for y in (135, 380):
            P.append(H.foot_rubber(20, 8).moved(t=(sx * 128, y, 0)))
        x0, x1 = (65, 95) if sx > 0 else (-95, -65)
        P.append(K.span(x0, x1, 108, 122, 99, 113, "inst_grey", 1.5, 2))
        P.append(K.cyl(7, 65, 95, "inst_grey", 24, 0.8).moved(K.rot("y", 90 * sx), (0, HINGE[0], HINGE[1])))
        face = K.FACE["+x"] if sx > 0 else K.FACE["-x"]
        P.append(H.slots_grille(96, 34, 12, 20, 3, "inst_white", back=-0.05, t=2.0, horizontal=False).moved(face, (sx * 150, 300, 140)))
    # rear: fan grille, inlet, the cable up to the drop
    fan = [list(reversed(K.circle(r, K.nseg(48), 0, 0))) for r in (34, 26, 18, 10)]
    holes = []
    for a0 in range(0, 360, 60):
        arc = [(r * math.cos(math.radians(a)), r * math.sin(math.radians(a))) for r, a in
               [(30, a0 + 6), (30, a0 + 54)] + [(22, a0 + 54), (22, a0 + 6)]]
        holes.append(list(reversed(arc)))
    P.append(K.plate_holes(K.circle(38, K.nseg(48)), holes, 0, 1.5, "inst_grey").moved(K.FACE["+y"], (70, 400, 110)))
    P.append(K.cyl(36, 0, 0.5, "black", 48, 0).moved(K.FACE["+y"], (70, 399.6, 110)))
    P.append(K.span(-110, -60, 400, 401.2, 40, 75, "black", 0.5, 1))
    P.append(K.span(-98, -72, 401, 412, 50, 66, "polymer_grey", 1.0, 2))
    return P, fan


def build(ctx):
    sid = B.sid_of(ctx) or "inc"
    st = B.station(ctx, sid)
    T = st["T"]
    deg = st["lid"]["closed_deg"] if st.get("lid") else 100
    m = B.Model(ctx, ctx.name, base=(0, 0, T))
    m.origin["led"] = B.item_at(ctx, "anim_inc_led_0", T)
    up = lambda p: p.moved(t=(0, 0, T))
    P, _ = body()
    F, led, ring = front()
    m.add(*map(up, P + F))
    cab = K.fillet_path([(-85, 411, 58), (-85, 415, 58), (-85, 415, 150), (0, 418, 215), (0, 425, 262)], 30, 6)
    m.add(up(K.sweep(cab, 4.0, "cable", 10)))
    m.add(*map(up, lid(deg)), sub="lid")
    m.add(up(led), sub="led")
    m.add(up(ring), sub="ring")
    return m.finish(tint=("led", "ring"))
