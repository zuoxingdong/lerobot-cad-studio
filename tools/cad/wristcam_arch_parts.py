"""The DF200 wrist arch itself: every measured number, the framing maths and class Arch."""
import math

import cadquery as cq
import numpy as np

from common import get
# the pocket family is single-sourced from the corner mast: same module, same retainer,
# same shims, same hinge hardware.
from corner_mast_dims import (CABLE_D, CHEEK_GAP, CHEEK_R, CHEEK_T, EAR_D, EAR_L, EAR_U,
                              FAN_HALF, FAN_R, HINGE_BOLT, HINGE_N, HINGE_U, IDX_D,
                              IDX_R_IN, IDX_R_OUT, IDX_SEAT_D, IDX_STEP, LENS_SQ, LUG_R,
                              LUG_XD0, PWALL, RET_BOSS, RET_H, RET_L, RET_T, RET_WIN,
                              SENSOR_IN, box, cyl)


PARAMS = {
    'tilt_deg':   (45.0, 30.0, 60.0),     # design tilt, below +X (the finger direction)
    'sensor_x':   (-16.0, -30.0, -5.0),
    'sensor_z':   (95.0, 80.0, 115.0),
    'mod_w':      (36.0, 20.0, 50.0),
    'mod_h':      (36.0, 20.0, 50.0),
    'mod_d':      (11.0, 6.0, 25.0),
    'fit':        (0.4, 0.0, 1.5),
    'lip':        (3.0, 1.0, 6.0),
    'hfov_deg':   (87.3, 40.0, 120.0),    # JR DF200, 100 deg diagonal at 4:3 (user-confirmed)
}

SEAT_Z = 19.50                 # PincOpen frames.camera_plate.seat_z
HOLE_X = (-41.27, -26.27)      # frames.camera_plate.holes
HOLE_Y = 18.91
M25_CLR = 1.45                 # M2.5 clearance
# The Motor_Flange's own feet sit ON the front pair of seat holes: an annular boss round each
# screw, measured on the exported mesh at TOP Z 21.36..21.49 (+Y) and 21.52..21.68 (-Y) over
# the r <= 2.7 annulus, bottom Z 19.36..19.67.  The arch STANDS ON THEM at the front - a
# stepped pad.  Rev 1 put that pad at Z 22.60, i.e. 1.05-1.25 mm of AIR over the feet, with
# only 0.48 mm of plastic left under a O5.4 x 3.0 counterbore: tightening the screw loaded a
# half-millimetre floor in bending over a void.  FLANGE_FOOT['z'] is now 21.70, which lands on
# the higher foot with 0.02 mm and on the lower one with 0.34 mm, and the counterbore is
# CB_D x CB_H, which leaves 2.50 mm.
FLANGE_FOOT = dict(x0=-31.0, x1=-22.8, y0=14.3, y1=22.1, z=21.70)
# ... and the Motor_Flange's BODY between the two feet is taller than the feet are: measured
# on the exported mesh it reaches Z 22.61 over X -29.70..-23.71, |Y| <= 16.21.  With the front
# pad dropped to the feet the rail's inboard edge would land on that instead of on the feet
# (2.599 mm3 of interference, 0.91 mm deep), so the pad is relieved over that band as well.
FLANGE_BODY = dict(y=16.7, z=22.9)
RAIL_Y0, RAIL_Y1 = 14.8, 27.1  # base rails: outboard of the Motor_Flange's legs (|Y| 14.4)
                               # and of the servo (|Y| 12.4), over the seat holes, and out to
                               # the CHEEK's own outer face so the legs stand ON them
RAIL_T = 4.0
CB_D, CB_H = 5.4, 1.5          # seat-screw counterbore: 2.50 mm of pad left under the head
LEG_T = 4.0                    # leg thickness - a TRUE 4 mm plate, measured perpendicular to
                               # its own face.  Rev 1 lofted the leg between planes at |Y| 19.5
                               # and 24.6 while the profile climbed Z 23 -> 74.5, so the "5.1 mm
                               # web" was 5.1 mm measured in Y and 0.54-0.84 mm measured
                               # perpendicular - one extrusion at a 0.4 nozzle, and the only
                               # load path from the camera to the seat.  The leg is now a flat
                               # plate at CONSTANT |Y|, coplanar with the cheek it feeds.
LEG_Y0 = 22.6                  # ... its inboard face: 0.69 mm outboard of the M2.5 driver
                               # relief (|Y| <= 21.91) and inside the cheek (22.1 .. 27.1)
LEG_WIN = 5.5                  # the lightening window is the leg inset by this much
SERVO = dict(x0=-53.2, x1=-7.8, y=12.4, z0=2.9, z1=42.5)   # measured, pincopen sts3215_drive

# The servo's own connectors, measured on pincopen/sts3215_drive.
# The STS3215 hangs horn-DOWN, so the face that carries its two 3-pin 2.54 mm sockets is the
# one pointing UP: case back Z 39.00, a raised socket shelf Z 40.80 over X -47.90..-8.00 and
# |Y| <= 9.99, and two 3-pin headers standing to Z 42.50 at X -33.05..-31.05, |Y| 1.81..8.59.
# A 2.54 mm housing is ~10 mm tall and its wires need a bend, so the plug needs ~16 mm of
# clear air above the socket face and a way OUT.  The first arch put a flat bridge at
# Z 44.50 straight over it: 5.2 mm.  CONN is the corridor the arch now keeps EMPTY - it is
# cut out of the arch unconditionally, so no later change can close it again.
CONN = dict(x0=-54.2, x1=-6.8, y=13.0, z_face=39.3, z=57.4)
CONN_CLEAR = CONN['z'] - CONN['z_face']       # 18.1 mm of headroom over the socket face
# The crossbar: flat (and gusseted) outboard of |Y| = BR_FLAT, humped over the connector.
BR_X0, BR_X1 = -51.0, -33.0
BR_Z0, BR_Z1 = 44.5, 49.5      # the flat ends, where the bar meets the two legs
HUMP_Z0, HUMP_Z1 = 57.5, 62.5  # the raised centre span, over CONN
BR_FLAT, BR_HUMP = 26.0, 13.0  # |Y| where the ramp starts / ends.  Rev 1 ramped 18 -> 13, a
                               # 13 mm climb over 5 mm of run: the ramp leaned 21 deg off
                               # vertical, so its 5.0 mm VERTICAL thickness was 1.80 mm
                               # measured perpendicular (the docstring's "4.85 mm" took the
                               # cosine of the wrong angle).  26 -> 13 is a 45 deg ramp:
                               # 5.0 / sqrt(2) = 3.54 mm perpendicular, and the inboard end
                               # lands exactly on the connector corridor's own |Y| = 13.
TIE = dict(x0=-33.0, x1=-29.0, y=7.0, slot_w=9.0, slot_h=2.2)   # zip-tie lug on the crown
DRV_D, DRV_H = 6.0, 16.0       # driver relief above each M2.5 seat counterbore (O6.0, not
                               # O6.4: it keeps 1.11 mm of rail inboard and 0.69 mm of air to
                               # the leg's inboard face, and a 2.5 mm key needs O5.5)
# The lens's ENTRANCE PUPIL, not the sensor.  `SENSOR_IN` puts the sensor point 4 mm BEHIND
# the module's front face, but an M12 board lens projects from a pupil 6-10 mm IN FRONT of
# that point - the barrel (O20 x 9) and hood (O13 x 3) stand 4..16 mm proud of it.  Occlusion
# margins taken at the sensor are therefore optimistic by the angle the offset subtends; at
# the rev-1 40 deg detent the servo LED's margin falls from +6.48 deg to +1.25 (at +6 mm) and
# -2.53 (at +10 mm), i.e. the LED is INSIDE the frame.  `framing()` now measures from
# PUPIL_FWD and `framing_table` reports the +6 / +10 mm bracket as well.
PUPIL_FWD = 8.0
PUPIL_BRACKET = (6.0, 10.0)

# The framing landmarks, PincOpen assembly frame (mm) — the framing model's own
# inputs, written down here so `params.framing` is
# REPRODUCIBLE from this file alone (mounts-review D10).  Measured on the package's own
# meshes: the drive servo's LED on its back face, the servo's forward-top corner, the grasp
# point 30 mm below the finger axis at X 55, and the fingertip pad contact point with the
# jaw closed and at a 40 mm opening (the four-bar carries the finger +5.359 mm in X and
# ±20 mm in Y between the two).
LANDMARKS = {
    'servo_led':  (-26.0, 0.0, 39.0),
    'servo_nose':  (-7.8, 0.0, 39.0),
    'grasp':       (55.0, 0.0, -30.0),
    'pad_closed':  (66.7, 0.0, 0.0),
    'pad_open40':  (72.059, 20.0, 0.0),
}


def framing_table(A, hfov=None):
    """`params.framing`: every detent's framing numbers, from LANDMARKS and `Arch.framing()`."""
    out = {}
    for t in A.detents:
        F = A.framing(t, hfov)
        uv, marg = F['uv'], F['margin']
        led, nose = LANDMARKS['servo_led'], LANDMARKS['servo_nose']
        pc, po = uv(LANDMARKS['pad_closed']), uv(LANDMARKS['pad_open40'])
        out['%g' % t] = dict(
            tilt_deg=t, sensor=F['sensor'], pupil=F['pupil'], pupil_fwd_mm=F['pupil_fwd_mm'],
            reach_mm=F['reach_mm'],
            v_led=round(uv(led)[1], 3), led_margin_deg=round(marg(led), 2),
            led_margin_deg_bracket=[round(A.framing(t, hfov, p)['margin'](led), 2)
                                    for p in PUPIL_BRACKET],
            v_servo_nose=round(uv(nose)[1], 3), servo_margin_deg=round(marg(nose), 2),
            v_grasp=round(uv(LANDMARKS['grasp'])[1], 3),
            uv_pad_closed=[round(pc[0], 3), round(pc[1], 3)],
            uv_pad_open40=[round(po[0], 3), round(po[1], 3)],
            camera_matrix16=A.matrix16(t))
    return out


def halfv(hfov, aspect=4.0 / 3.0):
    return math.degrees(math.atan(math.tan(math.radians(hfov / 2.0)) / aspect))


class Arch:
    def __init__(self, p=None):
        p = p or {}
        self.tilt = get(p, 'tilt_deg', *PARAMS['tilt_deg'])
        self.sx = get(p, 'sensor_x', *PARAMS['sensor_x'])
        self.sz = get(p, 'sensor_z', *PARAMS['sensor_z'])
        self.MOD_W = get(p, 'mod_w', *PARAMS['mod_w'])
        self.MOD_H = get(p, 'mod_h', *PARAMS['mod_h'])
        self.MOD_D = get(p, 'mod_d', *PARAMS['mod_d'])
        self.FIT = get(p, 'fit', *PARAMS['fit'])
        self.LIP = get(p, 'lip', *PARAMS['lip'])
        self.hfov = get(p, 'hfov_deg', *PARAMS['hfov_deg'])

        t = math.radians(self.tilt)
        self.CAM = np.array([self.sx, 0.0, self.sz])
        self.n = np.array([math.cos(t), 0.0, -math.sin(t)])     # forward and DOWN
        # image right = robot +X, which is PincOpen -Y (frames.wrist_flange: PincOpen +Y maps
        # to robot -X).  Taking it that way round ALSO makes (xd, n, up) right-handed exactly
        # as the corner mast's frame is, so the shared clamp-block code needs no sign flips.
        self.xd = np.array([0.0, -1.0, 0.0])
        self.up = np.cross(self.xd, self.n)                     # forward and UP
        self.POCK_W, self.POCK_H = self.MOD_W + self.FIT, self.MOD_H + self.FIT
        self.OUT_W, self.OUT_H = self.POCK_W + 2 * PWALL, self.POCK_H + 2 * PWALL
        self.POCK_D = self.MOD_D + 0.3
        self.F_OUT = SENSOR_IN + self.LIP
        self.P_BACK = SENSOR_IN - self.POCK_D
        self.EAR_BACK = self.P_BACK - 2.7
        self.LENS_SQ = min(LENS_SQ, self.MOD_W - 4.0, self.MOD_H - 4.0)
        self.HALF_W = self.OUT_W / 2.0
        self.CHEEK_IN = self.HALF_W + CHEEK_GAP
        self.CHEEK_OUT = self.CHEEK_IN + CHEEK_T
        self.LUG_BOT = HINGE_U - LUG_R
        self.HINGE = self.CAM + HINGE_N * self.n + HINGE_U * self.up
        self.detents = [self.tilt - 15.0 + IDX_STEP * k for k in range(7)]

    # frames
    def plane(self, origin=None):
        o = self.CAM if origin is None else origin
        return cq.Plane(origin=tuple(o), xDir=tuple(self.xd), normal=tuple(self.n))

    def rot(self, tilt):
        """head, design tilt -> detent tilt, about the hinge axis (the image-right axis).

        The sign is not asserted, it is SOLVED: the rotation is the one that carries the
        design optical axis onto the detent's."""
        a = math.radians(tilt - self.tilt)
        k = self.xd / np.linalg.norm(self.xd)
        K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
        R3 = np.eye(3) + math.sin(a) * K + (1 - math.cos(a)) * (K @ K)
        t2 = math.radians(tilt)
        want = np.array([math.cos(t2), 0.0, -math.sin(t2)])
        if np.linalg.norm(R3 @ self.n - want) > 1e-9:
            R3 = np.eye(3) - math.sin(a) * K + (1 - math.cos(a)) * (K @ K)
        assert np.linalg.norm(R3 @ self.n - want) < 1e-9, 'tilt rotation about the hinge axis'
        M = np.eye(4)
        M[:3, :3] = R3
        M[:3, 3] = self.HINGE - R3 @ self.HINGE
        return M

    def cam_at(self, tilt):
        M = self.rot(tilt)
        return M[:3, :3] @ self.CAM + M[:3, 3], M[:3, :3] @ self.n

    def matrix16(self, tilt=None):
        """column-major PincOpen->camera, three.js convention (col2 = -axis)."""
        cam, n = self.cam_at(self.tilt if tilt is None else tilt)
        xd = self.xd
        up = np.cross(xd, n)
        M = np.eye(4)
        M[:3, 0], M[:3, 1], M[:3, 2], M[:3, 3] = xd, up, -n, cam
        return [float(v) for v in M.T.reshape(-1)]

    # the head
    def head(self):
        n, xd, up = self.n, self.xd, self.up
        wp = cq.Workplane(self.plane())
        hh = self.OUT_H / 2.0
        body = (wp.workplane(offset=self.P_BACK).rect(self.OUT_W, self.OUT_H)
                .extrude(self.F_OUT - self.P_BACK)
                .edges(cq.selectors.ParallelDirSelector(cq.Vector(*n))).fillet(3.0)).val()
        for du in (-EAR_U, EAR_U):
            o = self.CAM + du * up + self.EAR_BACK * n
            body = body.fuse(cq.Solid.makeCylinder(EAR_D / 2, EAR_L, cq.Vector(*o),
                                                   cq.Vector(*n)))
        for sgn in (-1.0, 1.0):
            pl = cq.Plane(origin=tuple(self.CAM + sgn * LUG_XD0 * xd),
                          xDir=tuple(n), normal=tuple(sgn * xd))
            pts = [(HINGE_N - LUG_R, sgn * self.LUG_BOT), (HINGE_N + LUG_R, sgn * self.LUG_BOT),
                   (HINGE_N + LUG_R, sgn * (-hh + 1.0)), (HINGE_N - LUG_R, sgn * (-hh + 1.0))]
            body = body.fuse(cq.Workplane(pl).polyline(pts).close()
                             .extrude(self.HALF_W - LUG_XD0).val())
            o = self.HINGE + sgn * LUG_XD0 * xd
            body = body.fuse(cq.Solid.makeCylinder(LUG_R, self.HALF_W - LUG_XD0,
                                                   cq.Vector(*o), cq.Vector(*(sgn * xd))))
        body = body.cut(wp.workplane(offset=self.P_BACK - 1.0)
                        .rect(self.POCK_W, self.POCK_H)
                        .extrude(SENSOR_IN - self.P_BACK + 1.0).val())
        body = body.cut(wp.workplane(offset=SENSOR_IN).rect(self.LENS_SQ, self.LENS_SQ)
                        .extrude(40.0).val())
        for du in (-EAR_U, EAR_U):
            o = self.CAM + du * up + (self.EAR_BACK - 1.0) * n
            body = body.cut(cq.Solid.makeCylinder(1.3, EAR_L + 1.5, cq.Vector(*o),
                                                  cq.Vector(*n)))
        o = self.HINGE - (self.HALF_W + 2.0) * xd
        body = body.cut(cq.Solid.makeCylinder(HINGE_BOLT / 2, 2 * self.HALF_W + 4.0,
                                              cq.Vector(*o), cq.Vector(*xd)))
        # BLIND index seats, IDX_SEAT_D deep, in BOTH side walls - see gen_corner_mast.head().
        # This is what makes the arch's head and the mast's head the same solid: ONE plate.
        for r in (IDX_R_IN, IDX_R_OUT):
            for sgn in (-1.0, 1.0):
                o = self.HINGE + r * up + sgn * self.HALF_W * xd
                body = body.cut(cq.Solid.makeCylinder(IDX_D / 2, IDX_SEAT_D, cq.Vector(*o),
                                                      cq.Vector(*(-sgn * xd))))
        a = self.CAM - (self.POCK_H / 2 - 1.0) * up
        body = body.cut(cq.Solid.makeCylinder(CABLE_D / 2, 9.0, cq.Vector(*a),
                                              cq.Vector(*(-up))))
        return body.clean()

    # the arch
    def arch(self):
        hx, hz = float(self.HINGE[0]), float(self.HINGE[2])
        s = None

        def add(sh):
            return sh if s is None else s.fuse(sh)

        # base rails, one per side: rear half on the Z 19.50 seat, front half stepped down
        # onto the Motor_Flange's own feet
        for sgn in (-1.0, 1.0):
            y0, y1 = sgn * RAIL_Y0, sgn * RAIL_Y1
            s = add(box(-46.5, -31.2, y0, y1, SEAT_Z, SEAT_Z + RAIL_T))
            s = add(box(-31.2, -21.0, y0, y1, FLANGE_FOOT['z'], FLANGE_FOOT['z'] + RAIL_T))
            s = add(box(-32.6, -29.8, y0, y1, SEAT_Z, FLANGE_FOOT['z'] + RAIL_T))   # the step
        # the LEGS: one flat plate per side at constant |Y|, LEG_T thick measured
        # perpendicular to its own face, standing on the rail and running up into the cheek it
        # is coplanar with.  A lightening window keeps it a frame rather than a slab.
        from shapely.geometry import Polygon
        out = [(-47.0, SEAT_Z), (-28.0, SEAT_Z), (hx + 10.0, hz - 2.0), (hx - 16.0, hz + 4.0)]
        win = Polygon(out).buffer(-LEG_WIN, join_style=1, resolution=8)
        for sgn in (-1.0, 1.0):
            # one plane normal for both legs, so the profile's local (x, y) is (X, Z) either
            # way round: normal (0,-1,0) => local Y = normal x xDir = +Z.
            y0 = -LEG_Y0 if sgn < 0 else LEG_Y0 + LEG_T
            pl = cq.Plane(origin=(0, y0, 0), xDir=(1, 0, 0), normal=(0, -1, 0))
            leg = cq.Workplane(pl).polyline(out).close().extrude(LEG_T).val()
            if not win.is_empty:
                wp = list(win.exterior.coords)[:-1]
                leg = leg.cut(cq.Workplane(pl).polyline(wp).close()
                              .extrude(LEG_T + 2.0).translate(cq.Vector(0, 0, -1)).val())
            s = add(leg)
        # the bridge that makes it an ARCH: one cross member OVER the servo.  It is NOT a flat
        # plate any more.  Flat at Z 44.5..49.5 it cleared the servo's back face by 5.2 mm,
        # and that face is where the two 3-pin sockets live - the motor could not be plugged
        # in with the arch on.  The bar now HUMPS: it keeps the old Z 44.5..49.5 section
        # outboard of |Y| = 18 (where the gussets carry it, and where it is 39 mm below the
        # module's insertion corridor), ramps up between |Y| 18 and 13, and crosses the
        # connector band at Z 57.5..62.5.  That leaves a 26 (Y) x 18 (X) window 18.1 mm above
        # the socket face - a 2.54 mm plug plus its bend - and the whole of CONN open to the
        # rear, which is the way to the arm.
        s = add(self._crossbar())
        # rev 1's two Z 40..44.5 gussets are gone: they braced a 0.6 mm web between X -51 and
        # -33 only, and the leg is a real plate now.  Leg plates + crossbar = a portal frame.
        # cable furniture: a zip-tie lug on the front face of the crown, right where the
        # servo harness leaves the sockets.  (The DF200 pigtail is tied to the leg itself -
        # each leg is a free web, so a tie wraps it; no geometry needed, and nothing is added
        # near the M2.5 seat screws' driver axes.)
        s = add(self._tie_lug())
        # cheeks
        for sgn in (-1.0, 1.0):
            o = self.HINGE + sgn * self.CHEEK_IN * self.xd
            s = add(cq.Solid.makeCylinder(CHEEK_R, CHEEK_T, cq.Vector(*o),
                                          cq.Vector(*(sgn * self.xd))))
        # the index fan, on the +Y cheek
        o = self.HINGE + self.CHEEK_IN * self.xd
        fan = cq.Workplane(cq.Plane(origin=tuple(o), xDir=tuple(self.up), normal=tuple(self.xd)))
        pts = [(0.0, 0.0)]
        for k in range(25):
            a = math.radians(-FAN_HALF + 2 * FAN_HALF * k / 24.0)
            pts.append((FAN_R * math.cos(a), -FAN_R * math.sin(a)))
        s = add(fan.polyline(pts).close().extrude(CHEEK_T).val())
        # hinge bolt
        ob = self.HINGE - (self.CHEEK_OUT + 2.0) * self.xd
        s = s.cut(cq.Solid.makeCylinder(HINGE_BOLT / 2, 2 * self.CHEEK_OUT + 4.0,
                                        cq.Vector(*ob), cq.Vector(*self.xd)))
        # detent holes
        for k, t in enumerate(self.detents):
            r = IDX_R_OUT if k % 2 == 0 else IDX_R_IN
            a = math.radians(t - self.tilt)
            d = math.cos(a) * self.up + math.sin(a) * self.n
            p0 = self.HINGE + r * d + (self.CHEEK_IN - 1.0) * self.xd
            s = s.cut(cq.Solid.makeCylinder(IDX_D / 2, CHEEK_T + 2.0, cq.Vector(*p0),
                                            cq.Vector(*self.xd)))
        # the 4x M2.5 seat pattern.  Each hole gets a DRIVER RELIEF above its counterbore:
        # the legs' inboard face is at |Y| 19.5, only 0.59 mm outboard of the seat axis, so
        # the leg webs roofed all four O5.4 counterbores - the screw head could not be put in
        # and no key could reach it (measured: 0.37 mm of O3.6 clear).
        # DRV_D x DRV_H of clear bore above each pad takes the head down to its seat and a
        # 2 mm key after it, and clips 2.6 mm off the 5.1 mm leg web at its root only.
        for x in HOLE_X:
            for sgn in (-1.0, 1.0):
                z0 = SEAT_Z - 1 if x < -35 else FLANGE_FOOT['z'] - 1
                s = s.cut(cyl(M25_CLR, 12.0, (x, sgn * HOLE_Y, z0), (0, 0, 1)))
                s = s.cut(cyl(CB_D / 2, CB_H, (x, sgn * HOLE_Y, z0 + RAIL_T + 1.0 - CB_H),
                              (0, 0, 1)))
                s = s.cut(cyl(DRV_D / 2, DRV_H, (x, sgn * HOLE_Y, z0 + RAIL_T + 1.0),
                              (0, 0, 1)))
        # the zip-tie slot through the crown lug
        zc = (HUMP_Z0 + HUMP_Z1) / 2.0
        s = s.cut(box(TIE['x0'] - 1.0, TIE['x1'] + 1.0, -TIE['slot_w'] / 2, TIE['slot_w'] / 2,
                      zc - TIE['slot_h'] / 2, zc + TIE['slot_h'] / 2))
        # relief over the Motor_Flange feet, and over the servo
        f = FLANGE_FOOT
        for sgn in (-1.0, 1.0):
            s = s.cut(box(f['x0'], f['x1'], sgn * f['y0'], sgn * f['y1'], SEAT_Z - 1, f['z']))
        s = s.cut(box(f['x0'], f['x1'], -FLANGE_BODY['y'], FLANGE_BODY['y'], SEAT_Z - 1,
                      FLANGE_BODY['z']))
        s = s.cut(box(SERVO['x0'] - 1, SERVO['x1'] + 1, -SERVO['y'] - 0.6, SERVO['y'] + 0.6,
                      SEAT_Z - 1, SERVO['z1'] + 0.6))
        # ... and the CONNECTOR corridor, cut last so nothing above can re-close it: 26 mm
        # wide, from the seat to Z 57.4, over the servo's whole length.  This is what the
        # plug, its strain relief and the cable run in.
        s = s.cut(box(CONN['x0'], CONN['x1'], -CONN['y'], CONN['y'], SEAT_Z - 1, CONN['z']))
        # and nothing at all below the seat plane (the leg plates are built long so they bury
        # themselves in the rails)
        s = s.cut(box(-90.0, 20.0, -40.0, 40.0, SEAT_Z - 40.0, SEAT_Z))
        return s.clean()

    # crossbar + cable lug
    def _crossbar(self):
        """the humped cross member, drawn in the (Y, Z) plane and extruded along +X.

        Vertical thickness is BR_Z1 - BR_Z0 everywhere; on the ramp that is a perpendicular
        wall thickness of 4.85 mm (the ramp leans 21 deg off vertical)."""
        pl = cq.Plane(origin=(BR_X0, 0, 0), xDir=(0, 1, 0), normal=(1, 0, 0))
        t = BR_Z1 - BR_Z0
        pts = [(-RAIL_Y1, BR_Z0), (-BR_FLAT, BR_Z0), (-BR_HUMP, HUMP_Z0),
               (BR_HUMP, HUMP_Z0), (BR_FLAT, BR_Z0), (RAIL_Y1, BR_Z0),
               (RAIL_Y1, BR_Z0 + t), (BR_FLAT, BR_Z0 + t), (BR_HUMP, HUMP_Z0 + t),
               (-BR_HUMP, HUMP_Z0 + t), (-BR_FLAT, BR_Z0 + t), (-RAIL_Y1, BR_Z0 + t)]
        return cq.Workplane(pl).polyline(pts).close().extrude(BR_X1 - BR_X0).val()

    def _tie_lug(self):
        """a 4 mm tab off the front face of the crown: a 9 x 2.2 mm slot for a 2.5 mm tie."""
        return box(TIE['x0'], TIE['x1'], -TIE['y'], TIE['y'], HUMP_Z0, HUMP_Z1)

    # the shared retainer
    def retainer_flat(self):
        r = (cq.Workplane('XY').rect(RET_L, RET_H).extrude(RET_T).edges('|Z').fillet(4.0)
             .faces('>Z').workplane().rect(*RET_WIN).cutThruAll())
        for du in (-EAR_U, EAR_U):
            r = r.faces('>Z').workplane(origin=(du, 0)).circle(1.75).cutThruAll()
        r = r.faces('<Z').workplane(origin=(0, 0)).rect(self.MOD_W - 2.0, RET_H - 4.0) \
             .extrude(RET_BOSS)
        r = r.faces('<Z').workplane(origin=(0, 0)).rect(*RET_WIN).cutThruAll()
        return r.val()

    def ret_place(self):
        R = np.column_stack([self.up, self.xd, -self.n])
        if np.linalg.det(R) < 0:              # a reflection would not be a placement
            R[:, 1] *= -1.0
        U, _, Vt = np.linalg.svd(R)
        M = np.eye(4)
        M[:3, :3] = U @ Vt
        M[:3, 3] = self.CAM + self.EAR_BACK * self.n
        return M

    def retainer(self):
        M = self.ret_place()
        R = M[:3, :3]
        ang = math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(R) - 1.0) / 2.0))))
        w, v = np.linalg.eig(R)
        ax = np.real(v[:, np.argmin(np.abs(w - 1.0))])
        ax = ax / np.linalg.norm(ax)
        K = np.array([[0, -ax[2], ax[1]], [ax[2], 0, -ax[0]], [-ax[1], ax[0], 0]])
        chk = np.eye(3) + math.sin(math.radians(ang)) * K + \
            (1 - math.cos(math.radians(ang))) * (K @ K)
        if np.linalg.norm(chk - R) > 1e-6:
            ax = -ax
        return self.retainer_flat().moved(
            cq.Location(cq.Vector(*M[:3, 3]), cq.Vector(*ax), ang))

    # framing model
    def framing(self, tilt=None, hfov=None, pupil=None):
        """The framing model, in 3D: v = -(d.up)/(d.n)/tan(half-v), u likewise on xd.

        Measured from the lens's ENTRANCE PUPIL (`PUPIL_FWD` in front of the sensor point),
        not from the sensor: the module's own barrel and hood stand 4 to 16 mm proud of the
        sensor point, and an M12 board lens projects from 6-10 mm in front of it.  Taking the
        margins at the sensor is what made the rev-1 40 deg detent look like +6.48 deg of
        clearance on the servo LED when the real figure is +1.25 (at +6 mm) to -2.53 (+10).
        """
        T = self.tilt if tilt is None else tilt
        hf = self.hfov if hfov is None else hfov
        pf = PUPIL_FWD if pupil is None else pupil
        cam, n = self.cam_at(T)
        eye = cam + pf * n
        xd = self.xd
        up = np.cross(xd, n)
        hv = halfv(hf)

        def uv(P):
            d = np.asarray(P, float) - eye
            f = float(d @ n)
            return (float(d @ xd) / f / math.tan(math.radians(hf / 2.0)),
                    -float(d @ up) / f / math.tan(math.radians(hv)), f)

        def marg(P):
            d = np.asarray(P, float) - eye
            dec = math.degrees(math.atan2(-d[2], math.hypot(d[0], d[1])))
            return dec - T - hv
        e = T - hv
        reach = float('inf') if e <= 0.05 else (eye[2] + 30.0) / math.tan(math.radians(e))
        return dict(tilt_deg=T, hfov_deg=hf, half_vfov_deg=round(hv, 3),
                    sensor=[round(float(x), 4) for x in cam],
                    pupil=[round(float(x), 4) for x in eye], pupil_fwd_mm=pf,
                    uv=uv, margin=marg,
                    reach_mm=round(reach, 1) if reach != float('inf') else None)


