"""The robot as built hardware (parts follow the LeKiwi / SO-101 / PincOpen bodies, _robot.BODY): a Raspberry
Pi 5 with its dual-fan cooler and ports in the vertical case, a bus-servo driver board on the controller mount,
DF200 camera modules in place of the stand-in boxes (black board with its rear sticker, lens barrel and hood,
cover glass, rear connector), and screw heads in the holes found on the mounts, the standoffs, the arm
pivots and the PincOpen pins.  Board positions come from the package's Pi fit (tools/cad/vendor/pidummy)."""
import math

import numpy as np

import _bl as B
import _kit as K
import _robot as R

ROLE = "robot"
CAMS = {"base": "^vis_corner_mast_printed_df200$", "wroll": "^vis_df200_arch_df200$"}
# the front camera's rear connector (base frame, mm): the board's back under the mount's cable slot, its
# socket axis (out of the back) and image up
FRONT_USB = ((-7.0, 106.37, 38.32), (0.0, -0.9848, -0.1736), (0.0, -0.1736, 0.9848))
# PincOpen pins (body frame, mm): the fixed pivots and each rod's far pivot, along z
PINS = {"pinc": [(0, -32.5), (0, -44), (0, 32.5), (0, 44)]}
MOUNTS = ["^vis_drive_motor_mount-v11(-[12])?$", "^vis_servo_controller_mount-v3$", "^vis_lipo_battery_mount-v3$",
          "^vis_Camera-Mount-v8$", "^vis_pi_case_cradle$"]


def cap(d, key):
    """a socket-cap head on +z from z = 0, a dark round socket"""
    r, h = 0.92 * d, 0.95 * d
    return K.cat([K.lathe([(0, 0), (r, 0), (r, h - 0.3), (r - 0.3, h), (0.45 * d, h), (0.45 * d, h - 0.2), (0, h - 0.2)], K.nseg(16, 6), key),
                  K.cyl(0.42 * d, h - 1.4, h - 0.15, "tag_black", 6, 0)])


def screw(p, n, r_hole, key="screw_zinc"):
    d = 3.0 if r_hole > 1.35 else 2.0
    if K.web():                                   # a plain head, 8 round
        return K.cyl(0.92 * d, 0, 0.95 * d, key, 24, 0).moved(K.frame_axis(n), p)
    return cap(d, key).moved(K.frame_axis(n), p)


# ---- the Pi 5 in the vertical case: board coordinates as pidummy (x microSD -> IO, y HDMI -> GPIO, z up
# from the solder side) -> base: (-y, -z - 59.5, x + 106.5)

def pb(x0, x1, y0, y1, z0, z1, key, bev=0.3):
    a, b = np.array([-y0, -z0 - 59.5, x0 + 106.5]), np.array([-y1, -z1 - 59.5, x1 + 106.5])
    lo, hi = np.minimum(a, b), np.maximum(a, b)
    return K.span(lo[0], hi[0], lo[1], hi[1], lo[2], hi[2], key, bev, 1)


def usb(y0, tongue):
    """a USB-A stack at the IO edge: shell, two port mouths facing +x (up), tongues"""
    P = [pb(41.0, 53.0, y0, y0 + 13.1, 1.6, 15.2, "steel", 0.4)]
    for z0 in (2.6, 9.4):
        P.append(pb(52.6, 53.1, y0 + 1.0, y0 + 12.1, z0, z0 + 5.0, "tag_black", 0))
        P.append(pb(49.0, 53.15, y0 + 2.0, y0 + 11.1, z0 + 2.9, z0 + 4.4, tongue, 0))
    return P


def fan(xc, yc, z0):
    """a 30 mm cooler fan on the component side: frame, hub, 7 blades"""
    P = [pb(xc - 15, xc + 15, yc - 15, yc + 15, z0, z0 + 1.2, "black_anod", 0.3)]
    if K.web():
        return P
    for a in range(7):
        g = math.radians(a * 360 / 7)
        c, s = math.cos(g), math.sin(g)
        q = [(xc + 5 * c, yc + 5 * s), (xc + 13.5 * c - 2 * s, yc + 13.5 * s + 2 * c), (xc + 13.5 * c + 3 * s, yc + 13.5 * s - 3 * c)]
        blade = K.prism(q, z0 + 1.2, z0 + 4.8, "polymer_black", 0, 0)
        V = blade.V.copy()
        V[:, 0], V[:, 1], V[:, 2] = -V[:, 1], -V[:, 2] - 59.5, V[:, 0] + 106.5
        P.append(K.Part(V, blade.L, blade.C, blade.K))
    hub = K.cyl(5.0, 0, 5.2, "polymer_black", 24, 0.4).moved(K.rot("x", 90), (-yc, -z0 - 59.5, xc + 106.5))
    return P + [hub]


def pi5():
    P = [pb(-42.5, 42.5, -28.0, 28.0, 0.0, 1.6, "pcb", 0.5)]
    P += usb(8.0, "polymer_black") + usb(-7.0, "polymer_blue")
    P += [pb(41.0, 53.0, -25.9, -9.9, 1.6, 15.1, "steel", 0.4), pb(52.8, 53.2, -23.5, -12.3, 4.0, 12.5, "tag_black", 0)]
    P += [pb(-36.1, -26.5, -29.5, -21.5, 1.6, 4.8, "steel", 0.8), pb(-19.9, -13.3, -29.5, -21.5, 1.6, 4.6, "steel", 0.5),
          pb(-6.7, 0.5, -29.5, -21.5, 1.6, 4.6, "steel", 0.5)]
    P.append(pb(-29.0, 22.0, 22.0, 27.0, 1.6, 10.1, "connector_k", 0.3))
    P.append(pb(-28.5, 21.5, 23.0, 26.0, 10.1, 10.4, "copper", 0))
    # the cooler: a black anodised block with fins over the SoC side and two fans
    P.append(pb(-40.0, 30.0, -20.0, 20.5, 1.6, 7.6, "black_anod", 0.6))
    for k in range(9):
        y = -19.0 + 4.4 * k
        P.append(pb(-38.0, 28.0, y, y + 1.4, 7.6, 14.0, "black_anod", 0.2))
    P += fan(-20.0, 0.0, 14.0) + fan(12.0, 0.0, 14.0)
    P += [pb(34.0, 38.0, -27.0, -24.0, 1.6, 2.4, "ic", 0.1), pb(-41.0, -39.5, 18.0, 20.0, 1.6, 2.2, "led_green", 0.1)]
    return P


# ---- the bus-servo driver board on the controller mount (posts at x +-14, y 42 / 78, top z 11)

def driver():
    z = 11.0
    P = [K.span(-17.5, 17.5, 37.5, 82.5, z, z + 1.6, "pcb", 0.5, 1)]
    for x, y in ((-8.5, 47.0), (1.5, 47.0), (-8.5, 73.0), (1.5, 73.0)):
        P += [K.span(x - 3.9, x + 3.9, y - 2.9, y + 2.9, z + 1.6, z + 7.6, "connector_w", 0.3, 1),
              K.span(x - 3.0, x + 3.0, y - 1.8, y + 1.8, z + 7.0, z + 7.65, "tag_black", 0, 0)]
    P += [K.span(9.0, 17.8, 53.0, 67.0, z + 1.6, z + 12.6, "connector_k", 0.6, 1),
          K.span(-4.5, 4.5, 36.8, 44.0, z + 1.6, z + 4.8, "steel", 0.8, 1),
          K.span(-14.5, -9.5, 55.0, 65.0, z + 1.6, z + 9.6, "connector_k", 0.4, 1),
          K.span(-2.0, 5.0, 56.5, 63.5, z + 1.6, z + 2.6, "ic", 0.1, 1), K.span(9.5, 12.5, 41.5, 44.5, z + 1.6, z + 2.4, "ic", 0.1, 1),
          K.cyl(3.1, z + 1.6, z + 8.6, "black", 16, 0.3, (-3.0, 52.0)), K.cyl(2.7, z + 8.6, z + 8.8, "alu", 16, 0, (-3.0, 52.0))]
    if not K.web():
        P += [cap(2.5, "screw_zinc").moved(t=(x, y, z + 1.6)) for x in (-14, 14) for y in (42, 78)]
    return P


def module(c, n, up):
    """a DF200 module in its stand-in's place: 36 mm square PCB with gold pads, the M12 barrel, hood and cover
    glass on the lens side, parts and the rear connector behind"""
    x = np.cross(up, n)
    M = np.stack([x, up, n], 1)
    P = [K.span(-18, 18, -18, 18, 2.0, 3.6, "camera_module", 0.4, 1), K.span(-9, 9, -9, 9, 3.6, 5.5, "polymer_black", 0.4, 1)]
    for sx in (-1, 1):
        for sy in (-1, 1):
            P.append(K.ring(1.1, 2.2, 3.6, 3.7, "copper", 16, 0).moved(t=(sx * 15, sy * 15, 0)))
    P.append(K.lathe([(0, 5.5), (10, 5.5), (10, 7.0), (9.4, 7.3), (10, 7.6), (10, 9.3), (9.4, 9.6), (10, 9.9), (10, 14.5), (6.5, 14.5),
                      (6.5, 17.5), (5.2, 17.5), (5.2, 17.0), (0, 17.0)], K.nseg(32), "polymer_black"))
    P.append(K.cyl(5.1, 16.4, 17.25, "touchscreen", 32, 0.2))
    P.append(K.cyl(3.4, 16.2, 16.45, "smoked_glass", 24, 0))
    P += [K.span(-13, 13, -13, 7, 1.88, 2.0, "label", 0, 0), K.span(-4.5, 4.5, 9.0, 14.0, -9.5, 1.8, "connector_w", 0.3, 1)]
    return [p.moved(M, c) for p in P]


def standoff_screws(ctx, occupied):
    P = []
    for k in range(6):
        rx = "^vis_94868A713_NO-THREADS_Female-Threaded-Hex-Standoff%s$" % ("" if k == 0 else "-%d" % k)
        V = R.mesh(ctx, rx)[0]
        cx, cy = (V[:, 0].min() + V[:, 0].max()) / 2, (V[:, 1].min() + V[:, 1].max()) / 2
        for z, n in ((57.0, (0, 0, 1)), (-7.0, (0, 0, -1))):
            p = np.array([cx, cy, z])
            if R.clear(occupied, p, n, 3.3, 4.0):
                P.append(screw(p, n, 1.6))
    return P


def mount_screws(ctx, occupied):
    P = []
    for rx in MOUNTS:
        for k in ("", "-1", "-2") if "(-[12])?" in rx else ("",):
            V = R.mesh(ctx, rx.replace("(-[12])?", k))[0]
            for p, r in R.up_holes(V):
                if R.clear(occupied, p, (0, 0, 1), 3.2, 3.5):
                    P.append(screw(p, (0, 0, 1), r))
    return P


def pivots(ctx):
    """screw heads in the holes around each arm axis on the links' outer faces (the pivot screw and the horn
    screws), clear of the servos and links, and the PincOpen pins"""
    out = {}
    servo = dict((b, rx) for b, rx in R.SERVOS)
    for child, parent, ax in R.JOINTS[1:]:
        solid = np.concatenate([R.apply(R.rel(ctx, child, b), R.mesh(ctx, rx)[0])
                                for b in (child, parent) for rx in (R.BODY[b], servo.get(b)) if rx])
        for body in (child, parent):
            M = R.rel(ctx, body, child)
            a, o = M[:3, :3] @ np.array(ax, float), M[:3, 3]
            V = R.mesh(ctx, R.BODY[body])[0]
            Mi = np.linalg.inv(M)
            for s in (1, -1):
                found = R.face_holes(V, o, s * a) + [h for h in [R.axis_hole(V, o, s * a)] if h]
                for p, r in found:
                    if R.clear(solid, R.apply(Mi, p[None])[0], Mi[:3, :3] @ (s * a), 2.7, 3.0):
                        out.setdefault(body, []).append(screw(p, s * a, r, "black"))
    for p0 in PINS["pinc"]:
        for rx, s in (("^vis_pincopen_top_plate$", 1), ("^vis_pincopen_bottom_plate$", -1)):
            V = R.mesh(ctx, rx)[0]
            for p, r in R.face_holes(V, (p0[0], p0[1], 0), (0, 0, s), rmax=4.0):
                out.setdefault("pinc", []).append(screw(p, (0, 0, s), r, "steel"))
    return out


def anchors(ctx):
    """empties where leads plug in, +Z out of the socket: rps_anchor.servo_<body>.<k> on each bus servo,
    rps_anchor.cam_<body> on the DF200 rear connectors and rps_anchor.cam_front on the front camera's (+Y image
    down: the lead runs down the module's back), rps_anchor.pi_usb.<k> on the Pi's USB-A mouths"""
    out = {}
    canon = R.mesh(ctx, R.CANON)[0]
    for body, rx in R.SERVOS:
        S, e = R.sockets(*R.servo_frame(ctx, body, rx, canon))
        out.setdefault(body, []).extend(("servo_%s.%d" % (body, k), p, e) for k, p in enumerate(S))
    for body, rx in CAMS.items():
        c, n, up = R.df200(ctx, rx)
        out.setdefault(body, []).append(("cam_" + body, c + up * 11.5 - n * 9.5, -n, -up))
    p, d, up = (np.array(v) for v in FRONT_USB)
    out["base"].append(("cam_front", p, d, -up))
    for k, (x, y) in enumerate(((53.1, 14.5), (53.1, -0.5))):
        for j, z in enumerate((5.1, 11.9)):
            out["base"].append(("pi_usb.%d" % (2 * k + j), np.array([-y, -z - 59.5, x + 106.5]), np.array([0.0, 0, 1])))
    return out


def empty(bpy, name, p, d, y=None):
    from mathutils import Matrix
    ob = bpy.data.objects.new("rps_anchor." + name, None)
    ob.empty_display_size = 0.004
    ob.rotation_mode = "QUATERNION"
    ob.location = tuple(float(v) * 0.001 for v in p)
    M = K.frame_axis(d) if y is None else np.stack([np.cross(y, d), y, d], 1)
    ob.rotation_quaternion = Matrix(M.tolist()).to_quaternion()
    return ob


def build(ctx):
    m = B.Model(ctx, ctx.name)
    for b in R.BODY:
        m.origin[b] = (0, 0, 0)
    occupied = np.concatenate([R.mesh(ctx, "^%s$" % g)[0] for g in ("vis_Base_08q-v1", "vis_corner_mast_printed_spar_lower",
                                                                     "vis_pi_case_cradle", "vis_lipo_battery_mount-v3",
                                                                     "vis_Battery---Battery-5.2-Ah-DC5521-Plug-v2")])
    m.add(*pi5(), *driver(), sub="base")
    m.add(*standoff_screws(ctx, occupied), *mount_screws(ctx, occupied), sub="base")
    for b, rx in CAMS.items():
        m.add(*module(*R.df200(ctx, rx)), sub=b)
    for b, parts in pivots(ctx).items():
        m.add(*parts, sub=b)
    out = {k: [v] for k, v in m.finish().items()}
    for b, items in anchors(ctx).items():
        out.setdefault(b, []).extend(empty(ctx.bpy, *it) for it in items)
    return out
