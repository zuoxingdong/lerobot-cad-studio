"""The wall dashboard (world frame, mm): a slim 55" display (1230 x 700, 8 mm bezel) on the back wall
over the bench, a Design / Build / Test / Learn loop (parts `loop_1..4`, tinted by anim_wall_loop_k)
over the capture's animated result bars, a static UI, and a white raceway down to the floor."""
import _bl as B
import _kit as K

ROLE = "dressing"
CX, Z0, Z1, WALL = -1300.0, 1250.0, 1950.0, 1950.0
YF = 1927.0                                     # glass front; the capture's bars stand at y 1924..1926
# depth order behind the glass (YF..+1.2): text +1.24, loop pills +1.25..1.29, UI plane +1.30..1.35, body from +1.40
STEPS = ("DESIGN", "BUILD", "TEST", "LEARN")


def build(ctx):
    m = B.Model(ctx, ctx.name)
    w = 1230.0
    x0, x1 = CX - w / 2, CX + w / 2
    m.add(K.span(x0, x1, YF + 1.40, WALL - 3, Z0, Z1, "black", 3.0, 3), K.span(x0 + 200, x1 - 200, WALL - 3, WALL, Z0 + 150, Z1 - 150, "steel", 1.0, 1))
    m.add(K.span(x0 + 8, x1 - 8, YF, YF + 1.2, Z0 + 8, Z1 - 8, "touchscreen", 0.5, 1))
    ui = [K.span(x0 + 9, x1 - 9, YF + 1.30, YF + 1.35, Z0 + 9, Z1 - 9, "screen_ui", 0, 0),
          K.text("ENZYME SCREEN  ·  ROUND 3", 28, "screen_ui_hi", web_keep=True).moved(K.FACE_Y, (CX, YF + 1.24, Z1 - 70)),
          K.text("ART candidates: activity (a.u.)", 20, "screen_ui_hi", web_keep=True).moved(K.FACE_Y, (-1615, YF + 1.24, 1560))]
    for k, s in enumerate(STEPS):
        ui.append(K.text(s, 26, "screen_ui_hi", web_keep=True).moved(K.FACE_Y, (-1750 + 300 * k, YF + 1.24, 1755)))
    for k, s in enumerate(("ART-1", "ART-2", "ART-3", "ART-4")):
        ui.append(K.text(s, 21, "screen_ui_hi", web_keep=True).moved(K.FACE_Y, (-1780 + 110 * k, YF + 1.24, 1270)))
    ui.append(K.span(-1830, -1400, YF + 1.2, YF + 1.24, 1298, 1300, "screen_ui_hi", 0, 0))
    m.add(*ui, sub="screen")
    for k in range(4):
        nm = "anim_wall_loop_%d" % (k + 1)
        m.origin["loop_%d" % (k + 1)] = B.item_at(ctx, nm, 0)
        x = -1750 + 300 * k
        # the web LOD's round ends: 8 segments a quarter
        seg = K.prism(K.rrect(236, 36, 18, 24 if K.web() else 4, x, 0), 0, 0.04, "led_off", bev=0, seg=0).moved(K.FACE_Y, (0, YF + 1.29, 1720))
        m.add(seg, sub="loop_%d" % (k + 1))
    rx = x1 + 60
    m.add(K.span(rx - 30, rx + 30, WALL - 20, WALL, 0, Z0 + 350, "polymer_white", 2.0, 2),
          K.sweep(K.fillet_path([(x1 - 40, WALL - 10, Z0 + 300), (rx, WALL - 10, Z0 + 300)], 20, 3), 6, "cable", 8))
    return m.finish(tint=tuple("loop_%d" % (k + 1) for k in range(4)))
