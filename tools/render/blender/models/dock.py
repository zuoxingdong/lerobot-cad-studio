"""The dock (world frame, mm): a 400 x 300 rubber pad 1 mm thick with a printed floor tag, the charger
tower (white, graphite cap, copper spring contacts facing the robot, a charge LED), and the e-stop
station: a 1000 mm yellow post with a yellow box and a red mushroom (ISO 13850 look)."""

import _bl as B
import _hw as H
import _kit as K

ROLE = "station"


def tower():
    P = [K.prism(K.rrect(160, 60, 10, 4, 0, -280), 0, 380, "inst_white", bev=2.0, seg=3),
         K.prism(K.rrect(168, 68, 12, 4, 0, -280), 380, 392, "frame_dark", bev=2.0, seg=2),
         K.span(-70, 70, -252, -249, 40, 360, "frame_dark", 1.0, 2),
         K.span(-75, 75, -310, -250, 0, 8, "rubber", 2.0, 2)]
    for x in (-35, 35):
        P.append(K.span(x - 16, x + 16, -250, -249, 88, 132, "black", 0.5, 1))
        for dz in (-10, 0, 10):
            P.append(K.lathe([(0, 0), (4, 0), (4, 0.6), (3, 1.2), (0, 1.4)], K.nseg(16), "copper").moved(K.FACE["+y"], (x, -249, 110 + dz)))
    led = K.span(-26, 26, -249.6, -248.4, 318, 330, "led_green", 0.5, 1)
    P.append(K.span(-30, 30, -250, -249, 314, 334, "black", 0.5, 1))
    P.append(K.text("CHARGE", 7, "tape_white").moved(K.FACE["+y"], (0, -248.95, 296)))
    return P, led


def estop():
    x, y = -600.0, -250.0
    P = [K.cyl(45, 0, 12, "frame_dark", 32, 2.0, at=(x, y)), K.cyl(30, 12, 760, "hazard_yellow", 32, 1.0, at=(x, y))]
    P.append(K.prism(K.rrect(100, 100, 8, 3, x, y), 760, 850, "hazard_yellow", bev=2.0, seg=3))
    P.append(K.lathe([(0, 0), (30, 0), (30, 6), (26, 8), (0, 8)], K.nseg(32), "hazard_yellow").moved(t=(x, y, 850)))
    P.append(K.lathe([(0, 8), (12, 8), (12, 18), (20, 20), (22, 26), (20, 31), (0, 33)], K.nseg(40), "red").moved(t=(x, y, 850)))
    P.append(K.text("STOP", 11, "label_ink").moved(K.FACE_Y, (x, y - 50.1, 800)))
    P.append(K.cyl(4, 0, 700, "cable", 12, 0, at=(x + 22, y + 22)))
    return P


def build(ctx):
    m = B.Model(ctx, ctx.name)
    pad = [K.prism(K.rrect(400, 300, 20, 4, 0, -100), 0, 1.0, "rubber", bev=0.4, seg=1)]
    tag = H.fiducial(["1001", "0110", "1011", "0100"], 15.0, lift=0.06).moved(t=(140, -30, 1.0))
    P, led = tower()
    m.add(*pad, tag, *P, *estop())
    m.add(led, sub="led")
    return m.finish()
