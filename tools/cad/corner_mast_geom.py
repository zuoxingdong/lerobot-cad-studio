"""class Corner: the camera frame, the base plate, the head, the yoke and the spar.

Every number it uses is in corner_mast_dims.py.
"""
import math

import cadquery as cq
import numpy as np

from common import PLATE_OUTLINE, get
from corner_mast_dims import (BOLTS, CABLE_D, CHEEK_GAP, CHEEK_R, CHEEK_T, DECK_Z,
                              EAR_D, EAR_L, EAR_U, FAN_HALF, FAN_R, FOOT_T,
                              GUS_BOLT_CLR, GUS_END,
                              GUS_H, GUS_MARGIN, GUS_RUN_MAX, GUS_SPAR_MIN, GUS_T,
                              HINGE_BOLT, HINGE_N, HINGE_U, IDX_D, IDX_HI, IDX_LO,
                              IDX_R_IN, IDX_R_OUT, IDX_SEAT_D, IDX_STEP, LENS_SQ,
                              LUG_R, LUG_XD0, PAD_Z1, PARAMS, PWALL, RET_BOSS,
                              RET_H, RET_L, RET_T, RET_WIN, SENSOR_IN, SPG_CLR_X,
                              SPG_CLR_Y, YOKE_RISE, _ret_loc, box, cyl)


class Corner:
    """every derived number of the design, in robot mm."""

    def __init__(self, p=None):
        p = p or {}
        self.tilt = get(p, 'tilt_deg', *PARAMS['tilt_deg'])
        self.pan = get(p, 'pan_deg', *PARAMS['pan_deg'])
        self.cam_z = get(p, 'cam_z', *PARAMS['cam_z'])
        self.fwd = get(p, 'head_fwd', *PARAMS['head_fwd'])
        self.px = get(p, 'post_x', *PARAMS['post_x'])
        self.py = get(p, 'post_y', *PARAMS['post_y'])
        self.WALL = get(p, 'wall', *PARAMS['wall'])
        self.split_z = get(p, 'split_z', *PARAMS['split_z'])
        self.MOD_W = get(p, 'mod_w', *PARAMS['mod_w'])
        self.MOD_H = get(p, 'mod_h', *PARAMS['mod_h'])
        self.MOD_D = get(p, 'mod_d', *PARAMS['mod_d'])
        self.FIT = get(p, 'fit', *PARAMS['fit'])
        self.LIP = get(p, 'lip', *PARAMS['lip'])

        t, q = math.radians(self.tilt), math.radians(self.pan)
        self.n = np.array([math.sin(q) * math.cos(t), math.cos(q) * math.cos(t), -math.sin(t)])
        self.xd = np.array([math.cos(q), -math.sin(q), 0.0])
        self.up = np.cross(self.xd, self.n)
        self.CAM = np.array([self.px + self.fwd * math.sin(q),
                             self.py + self.fwd * math.cos(q), self.cam_z])
        # the camera pocket
        self.POCK_W, self.POCK_H = self.MOD_W + self.FIT, self.MOD_H + self.FIT
        self.OUT_W, self.OUT_H = self.POCK_W + 2 * PWALL, self.POCK_H + 2 * PWALL
        self.POCK_D = self.MOD_D + 0.3
        self.F_OUT = SENSOR_IN + self.LIP
        self.P_BACK = SENSOR_IN - self.POCK_D
        self.EAR_BACK = self.P_BACK - 2.7
        self.LENS_SQ = min(LENS_SQ, self.MOD_W - 4.0, self.MOD_H - 4.0)
        # ---- the hinge, and the seat under it --------------------------------------
        self.HINGE = self.CAM + HINGE_N * self.n + HINGE_U * self.up
        self.seat_z = float(self.HINGE[2]) - YOKE_RISE      # yoke seat plane
        self.spar_top = self.seat_z - FOOT_T                # where the spar taper ends
        self.HALF_W = self.OUT_W / 2.0
        self.CHEEK_IN = self.HALF_W + CHEEK_GAP
        self.CHEEK_OUT = self.CHEEK_IN + CHEEK_T
        self.LUG_BOT = HINGE_U - LUG_R                      # head lug, below the bolt
        self.detents = [IDX_LO + IDX_STEP * k
                        for k in range(int(round((IDX_HI - IDX_LO) / IDX_STEP)) + 1)]

    # ---- rotation of the HEAD about the hinge, design tilt -> detent tilt ----
    def rot(self, tilt):
        """4x4 that carries the head from the design tilt to `tilt`, about the hinge axis.

        `n` and `up` are both perpendicular to `xd`, so a change of tilt IS a rotation about
        `xd`; the sign is fixed by requiring R . n(design) == n(tilt)."""
        a = math.radians(tilt - self.tilt)
        k = self.xd / np.linalg.norm(self.xd)
        K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
        R3 = np.eye(3) + math.sin(a) * K + (1 - math.cos(a)) * (K @ K)
        t2 = math.radians(tilt)
        want = np.array([math.sin(math.radians(self.pan)) * math.cos(t2),
                         math.cos(math.radians(self.pan)) * math.cos(t2), -math.sin(t2)])
        if np.linalg.norm(R3 @ self.n - want) > 1e-9:       # the other way round the axis
            R3 = np.eye(3) - math.sin(a) * K + (1 - math.cos(a)) * (K @ K)
        M = np.eye(4)
        M[:3, :3] = R3
        M[:3, 3] = self.HINGE - R3 @ self.HINGE
        return M

    def cam_at(self, tilt):
        """sensor point and optical axis at a detent (the head swings about the hinge)."""
        M = self.rot(tilt)
        return M[:3, :3] @ self.CAM + M[:3, 3], M[:3, :3] @ self.n

    # ---- the camera plane, as a CadQuery Plane and as a 4x4 ----
    def plane(self, origin=None):
        o = self.CAM if origin is None else origin
        return cq.Plane(origin=tuple(o), xDir=tuple(self.xd), normal=tuple(self.n))

    def matrix16(self):
        """column-major robot->camera, three.js convention: col0 right, col1 up, col2 -axis."""
        M = np.eye(4)
        M[:3, 0], M[:3, 1], M[:3, 2], M[:3, 3] = self.xd, self.up, -self.n, self.CAM
        return [float(v) for v in M.T.reshape(-1)]

    # ---- the deck base plate ----
    def plate_profile(self):
        """the deck plate's outline, in robot mm - shared by base_plate() and the gusset."""
        from shapely.geometry import box as sbox, Point, Polygon
        from shapely.ops import unary_union
        prof = sbox(self.px - 18, self.py - 26, self.px + 18, self.py + 26)
        for bx, by in BOLTS:
            prof = unary_union([prof, Point(bx, by).buffer(7.5, 48)])
        prof = prof.buffer(5.0, join_style=1).buffer(-5.0, join_style=1)
        ao, ro = np.load(PLATE_OUTLINE).T                 # MEASURED deck rim
        deck = Polygon([((r - 1.5) * math.cos(a), (r - 1.5) * math.sin(a))
                        for a, r in zip(ao, ro)])
        prof = prof.intersection(deck)
        if prof.geom_type == 'MultiPolygon':
            prof = max(prof.geoms, key=lambda g: g.area)
        return prof

    def base_plate(self):
        pts = list(self.plate_profile().exterior.coords)[:-1]
        s = (cq.Workplane('XY', origin=(0, 0, DECK_Z)).polyline(pts).close()
             .extrude(PAD_Z1 - DECK_Z).val())
        for bx, by in BOLTS:
            s = s.cut(cyl(1.7, 20, (bx, by, DECK_Z - 5), (0, 0, 1)))
            s = s.cut(cyl(3.3, 3.2, (bx, by, PAD_Z1 - 3.2), (0, 0, 1)))
        return s

    # ---- the head: the clamp block, hung between the yoke cheeks ----
    def head(self):
        """Pocket + 3 mm lip + open REAR + the two retainer ears, plus the hinge lugs.

        The block ENDS at the module's back face (P_BACK), so the pocket's rear is open, and
        the two side lugs that carry the hinge bolt live outside the 36.4 x 36.4 insertion
        corridor.
        """
        n, xd, up = self.n, self.xd, self.up
        wp = cq.Workplane(self.plane())
        hw, hh = self.HALF_W, self.OUT_H / 2.0
        # the block: from the module's back face to the front of the lip. 14.3 mm deep.
        body = (wp.workplane(offset=self.P_BACK).rect(self.OUT_W, self.OUT_H)
                .extrude(self.F_OUT - self.P_BACK)
                .edges(cq.selectors.ParallelDirSelector(cq.Vector(*n))).fillet(3.0)).val()
        # retainer ears, on the image-UP axis
        for du in (-EAR_U, EAR_U):
            o = self.CAM + du * up + self.EAR_BACK * n
            body = body.fuse(cq.Solid.makeCylinder(EAR_D / 2, EAR_L, cq.Vector(*o),
                                                   cq.Vector(*n)))
        # hinge lugs: two side plates, xd LUG_XD0..HALF_W, hanging from the block's bottom
        # face down past the hinge.  Between them (|xd| < 13.5) the retainer plate and both
        # driver axes pass, so nothing here blocks the screws.
        for sgn in (-1.0, 1.0):
            # a plane whose local X is `n` and local Y is sgn * `up`, normal sgn * `xd`, so the
            # profile below really is drawn in the (n, up) plane it is quoted in
            pl = cq.Plane(origin=tuple(self.CAM + sgn * LUG_XD0 * xd),
                          xDir=tuple(n), normal=tuple(sgn * xd))
            pts = [(HINGE_N - LUG_R, sgn * self.LUG_BOT), (HINGE_N + LUG_R, sgn * self.LUG_BOT),
                   (HINGE_N + LUG_R, sgn * (-hh + 1.0)), (HINGE_N - LUG_R, sgn * (-hh + 1.0))]
            body = body.fuse(cq.Workplane(pl).polyline(pts).close()
                             .extrude(self.HALF_W - LUG_XD0).val())
            # round the lug's free end about the hinge
            o = self.HINGE + sgn * LUG_XD0 * xd
            body = body.fuse(cq.Solid.makeCylinder(LUG_R, self.HALF_W - LUG_XD0,
                                                   cq.Vector(*o), cq.Vector(*(sgn * xd))))
        # pocket, open at the REAR: the module slides straight in and seats on the lip
        body = body.cut(wp.workplane(offset=self.P_BACK - 1.0)
                        .rect(self.POCK_W, self.POCK_H)
                        .extrude(SENSOR_IN - self.P_BACK + 1.0).val())
        # front aperture
        body = body.cut(wp.workplane(offset=SENSOR_IN).rect(self.LENS_SQ, self.LENS_SQ)
                        .extrude(40.0).val())
        # M3 pilots into the ears, from the retainer side
        for du in (-EAR_U, EAR_U):
            o = self.CAM + du * up + (self.EAR_BACK - 1.0) * n
            body = body.cut(cq.Solid.makeCylinder(1.3, EAR_L + 1.5, cq.Vector(*o),
                                                  cq.Vector(*n)))
        # hinge bolt: M3 clearance straight through both lugs
        o = self.HINGE - (self.HALF_W + 2.0) * xd
        body = body.cut(cq.Solid.makeCylinder(HINGE_BOLT / 2, 2 * self.HALF_W + 4.0,
                                              cq.Vector(*o), cq.Vector(*xd)))
        # the two index-pin seats, on the +up ray from the hinge - BLIND, IDX_SEAT_D deep, and
        # in BOTH side walls.  Both walls, because that is what makes this head the same solid
        # as the wrist arch's: one plate, printed once, serves the mast and the arch.
        for r in (IDX_R_IN, IDX_R_OUT):
            for sgn in (-1.0, 1.0):
                o = self.HINGE + r * up + sgn * self.HALF_W * xd
                body = body.cut(cq.Solid.makeCylinder(IDX_D / 2, IDX_SEAT_D, cq.Vector(*o),
                                                      cq.Vector(*(-sgn * xd))))
        # cable duct: straight DOWN out of the pocket floor, on the block's mid-depth plane.
        # Rev 1 leaned it back (d = -(up + 0.55 n)) from a start 2 mm inside the rear face, so
        # it broke through that face and left a 0.05 mm feather edge over a 10 x 9 mm patch
        # while four documents said "the pocket floor is solid".  Vertical and centred on
        # n = 0 it keeps 3.55 mm of wall behind it and 3.25 mm in front.
        a = self.CAM - (self.POCK_H / 2 - 1.0) * up
        body = body.cut(cq.Solid.makeCylinder(CABLE_D / 2, 9.0, cq.Vector(*a),
                                              cq.Vector(*(-up))))
        return body.clean()

    # ---- the shared retainer plate, at its seated pose ----
    def retainer(self):
        r = (cq.Workplane('XY').rect(RET_L, RET_H).extrude(RET_T).edges('|Z').fillet(4.0)
             .faces('>Z').workplane().rect(*RET_WIN).cutThruAll())
        for du in (-EAR_U, EAR_U):
            r = r.faces('>Z').workplane(origin=(du, 0)).circle(1.75).cutThruAll()
        r = r.faces('<Z').workplane(origin=(0, 0)).rect(self.MOD_W - 2.0, RET_H - 4.0) \
             .extrude(RET_BOSS)
        r = r.faces('<Z').workplane(origin=(0, 0)).rect(*RET_WIN).cutThruAll()
        # bed frame -> camera frame: +X -> up (the ears run along image-up), -Z -> n
        ax, ang, t = _ret_loc(self)
        return r.val().moved(cq.Location(cq.Vector(*t), cq.Vector(*ax), ang))

    def retainer_flat(self):
        """the same plate on the bed (this is the thing that is printed)."""
        r = (cq.Workplane('XY').rect(RET_L, RET_H).extrude(RET_T).edges('|Z').fillet(4.0)
             .faces('>Z').workplane().rect(*RET_WIN).cutThruAll())
        for du in (-EAR_U, EAR_U):
            r = r.faces('>Z').workplane(origin=(du, 0)).circle(1.75).cutThruAll()
        r = r.faces('<Z').workplane(origin=(0, 0)).rect(self.MOD_W - 2.0, RET_H - 4.0) \
             .extrude(RET_BOSS)
        r = r.faces('<Z').workplane(origin=(0, 0)).rect(*RET_WIN).cutThruAll()
        return r.val()

    # ---- the yoke superstructure: trunk + cheeks + index fan + hinge ----
    def _yoke_top(self, s):
        """fuse the trunk, the two cheeks and the index fan onto `s`, and cut the hinge, the
        detent holes and the cable way: `spar_upper` grows the cheeks straight off the spar."""
        n, xd, up = self.n, self.xd, self.up
        px, py, sz = self.px, self.py, self.seat_z
        hz = float(self.HINGE[2])

        def wp_xd(z):
            return cq.Workplane(cq.Plane(origin=(px, py, z), xDir=tuple(xd), normal=(0, 0, 1)))
        s = s.fuse(wp_xd(sz).rect(2 * self.CHEEK_OUT, 17.0).extrude(8.0).val())
        for sgn in (-1.0, 1.0):
            s = s.fuse(wp_xd(sz).center(sgn * (self.CHEEK_IN + CHEEK_T / 2), 0.0)
                       .rect(CHEEK_T, 17.0).extrude(hz - sz).val())
        for sgn in (-1.0, 1.0):
            o = self.HINGE + sgn * self.CHEEK_IN * xd
            s = s.fuse(cq.Solid.makeCylinder(CHEEK_R, CHEEK_T, cq.Vector(*o),
                                             cq.Vector(*(sgn * xd))))
        # the index fan, OUTBOARD cheek only (an inboard fan reaches X -46.9, inside the
        # arm's raised envelope |X| < 45)
        o = self.HINGE - self.CHEEK_IN * xd
        fan = cq.Workplane(cq.Plane(origin=tuple(o), xDir=tuple(up), normal=tuple(-xd)))
        pts = [(0.0, 0.0)]
        for k in range(25):
            a = math.radians(-FAN_HALF + 2 * FAN_HALF * k / 24.0)
            pts.append((FAN_R * math.cos(a), FAN_R * math.sin(a)))
        s = s.fuse(fan.polyline(pts).close().extrude(CHEEK_T).val())
        ob = self.HINGE - (self.CHEEK_OUT + 2.0) * xd
        s = s.cut(cq.Solid.makeCylinder(HINGE_BOLT / 2, 2 * self.CHEEK_OUT + 4.0,
                                        cq.Vector(*ob), cq.Vector(*xd)))
        for k, t in enumerate(self.detents):
            r = IDX_R_OUT if k % 2 == 0 else IDX_R_IN
            a = math.radians(t - self.tilt)
            d = math.cos(a) * up + math.sin(a) * n
            p0 = self.HINGE + r * d - (self.CHEEK_OUT + 1.0) * xd
            s = s.cut(cq.Solid.makeCylinder(IDX_D / 2, CHEEK_T + 2.0, cq.Vector(*p0),
                                            cq.Vector(*xd)))
        s = s.cut(box(px - 5.0, px + 5.0, py - 14.0, py - 6.0, sz + 6.0, hz - 2.0))
        return s

    def _deck_driver_relief(self, s):
        """O7.5 x 26 of clear air straight up out of every deck bolt.

        The spar's corner overhangs (-60, -40) by 0.5 mm; cutting the driver's own envelope
        makes the clearance a feature, and costs a 0.75 mm sliver of the spar's corner."""
        for bx, by in BOLTS:
            s = s.cut(cyl(3.75, 26.0, (bx, by, PAD_Z1), (0, 0, 1)))
        return s

    # the spar
    def _sec(self, z):
        """spar half-width (X) and half-depth (Y) at height z: linear taper."""
        z0, z1 = PAD_Z1, self.spar_top
        u = min(max((z - z0) / (z1 - z0), 0.0), 1.0)
        w = 17.0 + (13.0 - 17.0) * u
        d = 15.0 + (12.0 - 15.0) * u
        return w, d

    def _wire(self, z, shrink=0.0, ch=2.0):
        """`shrink` may be a scalar or (dx, dy): the spigot fit is tighter FORE-AFT than it is
        laterally, because fore-aft is the plane the head's overhang bends the mast in."""
        w, d = self._sec(z)
        sx, sy = shrink if isinstance(shrink, (tuple, list)) else (shrink, shrink)
        w -= sx
        d -= sy
        c = min(ch, w - 0.6, d - 0.6)
        pts = [(-w + c, -d), (w - c, -d), (w, -d + c), (w, d - c),
               (w - c, d), (-w + c, d), (-w, d - c), (-w, -d + c)]
        return (cq.Workplane('XY', origin=(0, 0, z))
                .polyline([(self.px + a, self.py + b) for a, b in pts]).close().val())

    def _spar(self, z0, z1, shrink=0.0, ch=2.0, nst=9):
        zs = list(np.linspace(z0, z1, nst))
        return cq.Solid.makeLoft([self._wire(z, shrink, ch) for z in zs], True)

    def spar_lower(self):
        top = self.split_z
        s = self.base_plate()
        s = s.fuse(self._spar(PAD_Z1 - 0.1, top))
        s = s.cut(self._spar(PAD_Z1 + 8.0, top + 1.0, shrink=self.WALL, ch=1.0))
        # cable entry slot, low on the +X face
        w, d = self._sec(PAD_Z1 + 30)
        s = s.cut(box(self.px + w - 2, self.px + w + 8, self.py - 6, self.py + 6,
                      PAD_Z1 + 22, PAD_Z1 + 38))
        # spigot for the upper half: flush with the socket below the split, undersized by
        # SPG_CLR_X / SPG_CLR_Y per side above it.
        zlo = list(np.linspace(top - 22.0, top - 1.0, 4))
        zhi = list(np.linspace(top + 1.0, top + 20.0, 4))
        spg = cq.Solid.makeLoft([self._wire(z, self.WALL, 1.0) for z in zlo] +
                                [self._wire(z, (self.WALL + SPG_CLR_X, self.WALL + SPG_CLR_Y),
                                            1.0) for z in zhi], True)
        s = s.fuse(spg)
        s = s.cut(self._spar(top - 28.0, top + 24.0, shrink=self.WALL + 6.5, ch=0.8))
        for zj in (top + 7.0, top + 16.0):
            w, d = self._sec(zj)
            s = s.cut(cyl(1.25, 16.0, (self.px + w + 6, self.py, zj), (-1, 0, 0)))
        zj = top + 11.5
        w, d = self._sec(zj)
        s = s.cut(cyl(1.25, 16.0, (self.px, self.py - d - 6, zj), (0, 1, 0)))
        # the joint WITNESS: a chevron on the +X face just under the split.  The section is
        # symmetric, so the upper half would go on 180 deg out and put the camera behind the
        # robot; the two chevrons have to point at each other.
        s = s.fuse(self._chevron(top - 8.0, up=True))
        s = self._gusset_spar(s)
        s = self._deck_driver_relief(s)
        return s.clean()

    def spar_upper(self):
        """Z `split_z` to the top of the index fan — the spar AND the yoke in one part.

        Three plates make the mast: this, the lower spar (which carries the deck base) and the
        head.  No collar, seat disc, spigot or clamp under the cheeks: the tapered spar grows
        the two hinge cheeks and the index fan directly.
        """
        bot = self.split_z
        sz = self.seat_z
        s = self._spar(bot, sz)
        s = s.cut(self._spar(bot - 1.0, sz - 4.0, shrink=self.WALL, ch=1.0))
        # socket for the lower half's spigot
        s = s.cut(self._spar(bot - 1.0, bot + 20.5, shrink=self.WALL, ch=1.0))
        for zj in (bot + 7.0, bot + 16.0):
            w, d = self._sec(zj)
            s = s.cut(cyl(1.75, 16.0, (self.px + w + 6, self.py, zj), (-1, 0, 0)))
        zj = bot + 11.5
        w, d = self._sec(zj)
        s = s.cut(cyl(1.75, 18.0, (self.px, self.py - d - 6, zj), (0, 1, 0)))
        s = s.fuse(self._chevron(bot + 8.0, up=False))
        # the yoke, straight off the top of the spar
        s = self._yoke_top(s)
        # cable way: out of the hollow spar, up the axis, into the fork
        s = s.cut(cyl(4.0, (float(self.HINGE[2]) - 2.0) - (sz - 12.0),
                      (self.px, self.py, sz - 12.0), (0, 0, 1)))
        return s.clean()

    def _chevron(self, z, up=True):
        """an 8 x 5 mm triangular witness mark on the spar's -X face, apex toward the joint.

        -X, not +X: two of the three spigot screws come in on +X, and a witness standing on
        their axis is a blocked screw (measured: 0.00 mm of clear driver).  -X is the outboard
        face, away from the robot, and carries nothing else.
        """
        w, d = self._sec(z)
        x0 = self.px - w + 0.6
        pl = cq.Plane(origin=(x0, self.py, z), xDir=(0, -1.0, 0), normal=(-1.0, 0, 0))
        h = 5.0 if up else -5.0
        return cq.Workplane(pl).polyline([(-4.0, 0.0), (4.0, 0.0), (0.0, h)]).close() \
                 .extrude(1.6).val()

    def _gusset_spar(self, s):
        """the same integrated-gusset idea on the printed base — where there is room for it.

        There usually is not: the spar's own foot is a 34 x 30 mm hollow box rooted in the
        6 mm plate, which already reaches most of the plate's outline, and the deck bolts'
        O7.5 driver reliefs take the rest.  A ray is only given a fin if it can run at least
        GUS_SPAR_MIN mm outboard of the spar, and the runs that survive are recorded in
        `gusset_runs`.
        """
        from shapely.geometry import Point
        prof = self.plate_profile()
        self.gusset_runs = {}
        for az in (0.0, 90.0, 180.0, 270.0):
            ux, uy = math.cos(math.radians(az)), math.sin(math.radians(az))
            vx, vy = -uy, ux
            w, d = self._sec(PAD_Z1)
            r0 = abs(w * ux) + abs(d * uy)
            run = r0
            r = r0
            while r <= GUS_RUN_MAX:
                xe, ye = self.px + (r + GUS_MARGIN) * ux, self.py + (r + GUS_MARGIN) * uy
                if not prof.contains(Point(xe, ye)):
                    break
                ok = True
                for bx, by in BOLTS:
                    a = (bx - self.px) * ux + (by - self.py) * uy
                    b = (bx - self.px) * vx + (by - self.py) * vy
                    da = a - min(max(a, r0), r)
                    db = b - min(max(b, -GUS_T / 2), GUS_T / 2)
                    if math.hypot(da, db) < 3.75 + GUS_BOLT_CLR:
                        ok = False
                        break
                if not ok:
                    break
                run = r
                r += 0.25
            self.gusset_runs['%g' % az] = round(run - r0, 2)
            if run - r0 < GUS_SPAR_MIN:
                continue
            pl = cq.Plane(origin=(self.px, self.py, 0.0), xDir=(ux, uy, 0.0),
                          normal=(uy, -ux, 0.0))
            f = (cq.Workplane(pl)
                 .polyline([(r0 - 1.0, PAD_Z1 - 0.1), (run, PAD_Z1 - 0.1),
                            (run, PAD_Z1 + GUS_END), (r0 - 1.0, PAD_Z1 + GUS_H)])
                 .close().extrude(GUS_T / 2.0, both=True).val())
            s = s.fuse(f)
        return s
