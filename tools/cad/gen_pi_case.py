"""The vertical Raspberry Pi 5 case (rev I), parametric.

A faithful copy of the ground-truth pipeline generator - same cradle and drop-in panel, same
measured port positions, vent fields and snap-in cable channel.  What differs: `front_clear`,
`height`, `wall`, `vent_angle` and `latch` come from a params dict, everything once written
relative to the literal wall top is re-derived from `height`, and output goes into a caller-given
directory.  vendor/vent.py is imported read-only as the single source of the slot pattern.
"""
import os
import warnings

import cadquery as cq

from shapely.geometry import box as sbox, Point
from shapely.ops import unary_union

from common import add_scripts_to_path, get

add_scripts_to_path()
import vent  # noqa: E402  (vendor/vent.py, read-only)

warnings.filterwarnings('ignore')

PARAMS = {
    'front_clear': (29.5, 10.0, 50.0),    # PCB component face -> panel landing (cooler height)
    'height':      (97.0, 80.0, 135.0),   # FLOOR_Z0 (57) -> wall top
    'wall':        (3.0, 2.0, 5.0),       # X wall thickness
    'vent_angle':  (45.0, 0.0, 90.0),
    'latch':       (1.0, 0.0, 1.0),       # 1 = top cantilever latch, 0 = omit
}

TAB_BOLTS = [(-40., -80.), (40., -80.), (-40., -60.), (40., -60.)]   # MEASURED 20 mm deck grid
TAB_ANCH = [(-30.5, -76.0), (30.5, -76.0), (-30.5, -64.0), (30.5, -64.0)]
FLOOR_Z0, FLOOR_Z1 = 57.0, 61.0
SD_GAP = 3.0
BOARD_Z0 = FLOOR_Z1 + SD_GAP            # 64.0
BOARD_Z1 = BOARD_Z0 + 85.0              # 149.0  (85 mm board length)
WALL_IN_X = 31.5
FRONT_Y_OUT, FRONT_Y_IN = -51.5, -54.5
STANDOFF = 5.0
PCB_SOLDER = FRONT_Y_IN - STANDOFF      # -59.5
PCB_COMP = PCB_SOLDER - 1.6             # -61.1
HOLE_X = [-24.5, 24.5]
HOLE_Z = [BOARD_Z0 + 3.5, BOARD_Z0 + 3.5 + 58.0]
BOSS_D, PILOT_D, PILOT_L = 6.0, 2.2, 5.5
REST_Z, REST_X_IN, REST_Y = BOARD_Z0, 27.5, (-62.5, -59.0)
PORT_WIN = dict(z=(BOARD_Z0 + 3.4, BOARD_Z0 + 46.0), y=(-75.5, -59.0), r=2.0)
ARCH = dict(x=(-24., 24.), z=(FLOOR_Z1 + 1.0, BOARD_Z0), r=1.2)
RAIL_T, RAIL_D, RAIL_XO = 2.0, 3.0, 31.3
HK_REACH = 5.0
HK_FOOT_T = 2.5
R_EDGE, R_TOP = 1.5, 1.2
LT_SX = -1
LT_SLOT = 0.8
LT_DEEP = 1.2
CH_Y0, CH_Y1 = -58.5, -51.5
CH_CUT_Y = (-57.5, -52.5)


def box(x0, x1, y0, y1, z0, z1):
    x0, x1 = sorted((x0, x1))
    y0, y1 = sorted((y0, y1))
    z0, z1 = sorted((z0, z1))
    return cq.Solid.makeBox(x1 - x0, y1 - y0, z1 - z0, cq.Vector(x0, y0, z0))


def rrect(x0, x1, y0, y1, z0, z1, r):
    return (cq.Workplane("XY", origin=(0, 0, z0)).moveTo((x0 + x1) / 2, (y0 + y1) / 2)
            .rect(x1 - x0, y1 - y0).extrude(z1 - z0).edges("|Z").fillet(r))


def plate(x0, x1, z0, z1, y0, y1, r):
    """panel lying in the XZ plane, extruded along Y; silhouette corners rounded"""
    return (cq.Workplane("XZ", origin=(0, y1, 0)).moveTo((x0 + x1) / 2, (z0 + z1) / 2)
            .rect(x1 - x0, z1 - z0).extrude(y1 - y0).edges("|Y").fillet(r))


def cyl(r, h, o, d):
    return cq.Solid.makeCylinder(r, h, cq.Vector(*o), cq.Vector(*d))


def build(params, outdir, log=print):
    p = params or {}
    FRONT_CLEAR = get(p, 'front_clear', *PARAMS['front_clear'])
    HEIGHT = get(p, 'height', *PARAMS['height'])
    WALLX = get(p, 'wall', *PARAMS['wall'])
    VANG = get(p, 'vent_angle', *PARAMS['vent_angle'])
    LATCH = get(p, 'latch', *PARAMS['latch']) >= 0.5

    OUT_X = WALL_IN_X + WALLX
    ROOF_Z0 = ROOF_Z1 = FLOOR_Z0 + HEIGHT          # OPEN TOP: this is just the wall top
    LAND_Y = PCB_COMP - FRONT_CLEAR
    COVER_Y_OUT = LAND_Y - 3.0
    RAIL_Z = (FLOOR_Z1 + 0.2, ROOF_Z0 - 0.2)
    HK_ARM_Z = (RAIL_Z[0], RAIL_Z[0] + 2.5)
    HK_FOOT_Z = (FLOOR_Z0 + 1.2, RAIL_Z[0] + 0.2)
    HK_SLOT_Y = (LAND_Y + HK_REACH - HK_FOOT_T - 0.3, LAND_Y + HK_REACH + 0.3)
    HK_SLOT_Z = (FLOOR_Z0 + 1.0, FLOOR_Z1 + 0.5)
    HK_SLOT_X = (RAIL_XO - RAIL_T - 0.3, RAIL_XO + 0.1)
    LT_ROOT = ROOF_Z1 - 28.0
    LT_HOOK_Z = (ROOF_Z1 - 5.0, ROOF_Z1 - 1.5)
    LT_STEP_Z = LT_HOOK_Z[0] - 0.4
    ISLAND = dict(x=(-29.5, -3.5), z=(ROOF_Z0 - 20, ROOF_Z0 - 6), recess=0.6)
    CH_X0, CH_X1 = OUT_X - 0.5, OUT_X + 6.0
    CH_CUT_X = OUT_X + 1.5
    CH_LIP_Z = [z for z in (BOARD_Z0 + 14, BOARD_Z0 + 44, BOARD_Z0 + 74) if z + 10 <= ROOF_Z1]
    log("pi case: front_clear=%.1f height=%.1f (wall top Z=%.1f) wall=%.1f vent=%.0f deg latch=%s"
        % (FRONT_CLEAR, HEIGHT, ROOF_Z1, WALLX, VANG, LATCH))
    if ROOF_Z1 < BOARD_Z1:
        log("WARNING: wall top Z=%.1f is below the board top Z=%.1f - the board stands proud"
            % (ROOF_Z1, BOARD_Z1))

    vent_ang_prev = vent.ANG
    vent.ANG = VANG
    try:
        # =============== CRADLE ===============
        cr = rrect(-OUT_X, OUT_X, LAND_Y, FRONT_Y_OUT, FLOOR_Z0, ROOF_Z1, R_EDGE)
        cr = cr.edges(cq.selectors.BoxSelector((-99, -99, ROOF_Z1 - .1),
                                               (99, 99, ROOF_Z1 + .1))).fillet(R_TOP)
        cr = cr.val()
        cav = rrect(-WALL_IN_X, WALL_IN_X, LAND_Y - 1, FRONT_Y_IN, FLOOR_Z1, ROOF_Z0, R_EDGE).val()
        cr = cr.cut(cav)
        # board standoffs on the front wall + blind pilots
        for hx in HOLE_X:
            for hz in HOLE_Z:
                cr = cr.fuse(cyl(BOSS_D / 2, STANDOFF, (hx, FRONT_Y_IN, hz), (0, -1, 0)))
                cr = cr.cut(cyl(PILOT_D / 2, PILOT_L, (hx, PCB_SOLDER, hz), (0, 1, 0)))
        for sx in (1, -1):
            cr = cr.fuse(box(sx * WALL_IN_X, sx * REST_X_IN, REST_Y[0], REST_Y[1],
                             REST_Z - 3.0, REST_Z))
        # ---- mounting tabs: 2D closing gives the R3 concave roots ----
        prof = sbox(-OUT_X, LAND_Y, OUT_X, FRONT_Y_OUT).buffer(0)
        for (bx, by), (ax, ay) in zip(TAB_BOLTS, TAB_ANCH):
            prof = unary_union([prof,
                                sbox(min(bx, ax), min(by, ay), max(bx, ax), max(by, ay)).buffer(0),
                                Point(bx, by).buffer(3.75, 64), Point(ax, ay).buffer(3.75, 64)])
        prof = prof.buffer(3.0, join_style=1).buffer(-3.0, join_style=1)
        pts = list(prof.exterior.coords)[:-1]
        tab = (cq.Workplane("XY", origin=(0, 0, FLOOR_Z0)).polyline(pts).close()
               .extrude(FLOOR_Z1 - FLOOR_Z0).val())
        cr = cr.fuse(tab)
        for bx, by in TAB_BOLTS:
            cr = cr.cut(cyl(1.7, 10, (bx, by, FLOOR_Z0 - 2), (0, 0, 1)))
        cr = cr.cut(box(-35.0, 35.0, min(COVER_Y_OUT - 1.4, -95.0), LAND_Y,
                        FLOOR_Z0 - 1, FLOOR_Z1 + 1))   # clear the cover's path
        # ---- drop-in hook slots.  CUT AFTER the tab fuse, or the slab refills them (rev H bug)
        for sx in (1, -1):
            cr = cr.cut(box(sx * HK_SLOT_X[0], sx * HK_SLOT_X[1], HK_SLOT_Y[0], HK_SLOT_Y[1],
                            HK_SLOT_Z[0], HK_SLOT_Z[1]))
        # ---- latch hook on the -X wall's landing strip (ramped on top, flat underneath)
        if LATCH:
            _hz0, _hz1 = LT_HOOK_Z
            cr = cr.fuse((cq.Workplane("YZ", origin=(LT_SX * (OUT_X - 1.5), 0, 0))
                          .polyline([(LAND_Y, _hz0), (LAND_Y - LT_DEEP, _hz0), (LAND_Y, _hz1)])
                          .close().extrude(1.0, both=True)).val())
        # ---- port window on the +X wall (USB-C + HDMI0 + HDMI1) ----
        pw = PORT_WIN
        win = (cq.Workplane("YZ", origin=(0, (pw['y'][0] + pw['y'][1]) / 2,
                                          (pw['z'][0] + pw['z'][1]) / 2))
               .rect(pw['y'][1] - pw['y'][0], pw['z'][1] - pw['z'][0])
               .extrude(OUT_X + 5, both=True).edges("|X").fillet(pw['r'])).val()
        cr = cr.cut(win)
        for ty in (-62., -72.):
            cr = cr.cut(box(OUT_X + 1, OUT_X - 5, ty - 3.0, ty + 3.0, 73.75, 76.25))
        # ---- vent fields ----
        EXC_SIDE = [(pw['y'][0] - 1, pw['y'][1] + 1, pw['z'][0] - 1, pw['z'][1] + 1)]
        for face, off, args in (
            ('XZ', (FRONT_Y_OUT + FRONT_Y_IN) / 2,
             dict(u0=-29.5, u1=29.5, v0=BOARD_Z0 + 3, v1=ROOF_Z0 - 8, exclude=())),
            ('YZ', OUT_X - 1.5,
             dict(u0=LAND_Y + 4, u1=-59.5, v0=FLOOR_Z1 + 4, v1=ROOF_Z0 - 6, exclude=EXC_SIDE)),
            ('YZ', -(OUT_X - 1.5),
             dict(u0=LAND_Y + 4, u1=-56.5, v0=FLOOR_Z1 + 4, v1=ROOF_Z0 - 6, exclude=())),
            ('XY', (ROOF_Z0 + ROOF_Z1) / 2,
             dict(u0=-29.5, u1=29.5, v0=-58.5, v1=-52.5, exclude=())),
        ):
            s = vent.place(vent.field_solid(args['u0'], args['u1'], args['v0'], args['v1'],
                                            14.0, args['exclude']), face, off)
            if s is not None:
                cr = cr.cut(s)
        # ---- snap-in cable channel up the +X wall ----
        cr = cr.fuse(box(CH_X0, CH_X1, CH_Y0, CH_Y1, FLOOR_Z1, ROOF_Z1))
        cr = cr.cut(box(CH_CUT_X, CH_X1 + 1, CH_CUT_Y[0], CH_CUT_Y[1], FLOOR_Z1 + 2, ROOF_Z1 + 1))
        for lz in CH_LIP_Z:
            cr = cr.fuse(box(CH_X1 - 2.0, CH_X1, CH_CUT_Y[0], CH_CUT_Y[0] + 0.75, lz, lz + 10))
            cr = cr.fuse(box(CH_X1 - 2.0, CH_X1, CH_CUT_Y[1] - 0.75, CH_CUT_Y[1], lz, lz + 10))
        cr = cr.cut(box(-120, 120, -120, 120, FLOOR_Z0 - 40, FLOOR_Z0))
        cr = cr.clean()

        # =============== COVER ===============
        cv = plate(-OUT_X, OUT_X, FLOOR_Z0, ROOF_Z1, COVER_Y_OUT, LAND_Y, R_EDGE).val()
        for sx in (1, -1):
            cv = cv.fuse(box(sx * (RAIL_XO - RAIL_T), sx * RAIL_XO, LAND_Y, LAND_Y + RAIL_D,
                             RAIL_Z[0], RAIL_Z[1]))
        for sx in (1, -1):
            x0, x1 = sx * (RAIL_XO - RAIL_T), sx * RAIL_XO
            cv = cv.fuse(box(x0, x1, LAND_Y, LAND_Y + HK_REACH, HK_ARM_Z[0], HK_ARM_Z[1]))
            cv = cv.fuse(box(x0, x1, LAND_Y + HK_REACH - HK_FOOT_T, LAND_Y + HK_REACH,
                             HK_FOOT_Z[0], HK_FOOT_Z[1]))
        if LATCH:
            sx = LT_SX
            cv = cv.cut(box(sx * WALL_IN_X, sx * (WALL_IN_X - LT_SLOT), COVER_Y_OUT - 1,
                            LAND_Y + RAIL_D + 1, LT_ROOT, ROOF_Z1 + 1))
            cv = cv.cut(box(sx * (OUT_X + 0.5), sx * (WALL_IN_X - 0.1), LAND_Y - LT_DEEP,
                            LAND_Y + 0.2, LT_STEP_Z, ROOF_Z1 + 1))
        ar = ARCH
        arch = (cq.Workplane("XZ", origin=((ar['x'][0] + ar['x'][1]) / 2, COVER_Y_OUT,
                                           (ar['z'][0] + ar['z'][1]) / 2))
                .rect(ar['x'][1] - ar['x'][0], ar['z'][1] - ar['z'][0]).extrude(60, both=True)
                .edges("|Y and >Z").fillet(ar['r'])).val()
        cv = cv.cut(arch)
        cv = cv.cut(box(ISLAND['x'][0], ISLAND['x'][1], COVER_Y_OUT,
                        COVER_Y_OUT + ISLAND['recess'], ISLAND['z'][0], ISLAND['z'][1]))
        s = vent.place(vent.field_solid(
            -29.5, 29.5, BOARD_Z0 + 3, ROOF_Z0 - 8, 14.0,
            exclude=[(ISLAND['x'][0], ISLAND['x'][1], ISLAND['z'][0], ISLAND['z'][1])]),
            'XZ', (COVER_Y_OUT + LAND_Y) / 2)
        if s is not None:
            cv = cv.cut(s)
        cv = cv.clean()
    finally:
        vent.ANG = vent_ang_prev

    out = {'files': {}, 'solid_volume_cm3': {}, 'valid': {},
           'geom': dict(out_x=OUT_X, roof_z=ROOF_Z1, land_y=LAND_Y, cover_y_out=COVER_Y_OUT,
                        front_clear=FRONT_CLEAR, height=HEIGHT, latch=bool(LATCH))}
    for nm, sh in (('pi_case_cradle', cr), ('pi_case_panel', cv)):
        b = sh.BoundingBox()
        fp = os.path.join(outdir, nm + '.stl')
        cq.exporters.export(sh, fp, tolerance=0.02, angularTolerance=0.1)
        out['files'][nm] = fp
        out['solid_volume_cm3'][nm] = round(sh.Volume() / 1000, 3)
        out['valid'][nm] = bool(sh.isValid())
        log("  %-14s valid=%s solids=%d vol=%6.2f cm3  X %7.2f..%7.2f Y %7.2f..%7.2f Z %7.2f..%7.2f"
            % (nm, sh.isValid(), len(sh.Solids()), sh.Volume() / 1000,
               b.xmin, b.xmax, b.ymin, b.ymax, b.zmin, b.zmax))
    return out


if __name__ == '__main__':
    import sys
    import time
    import trimesh
    d = sys.argv[1] if len(sys.argv) > 1 else '/tmp/pi_test'
    os.makedirs(d, exist_ok=True)
    t0 = time.time()
    r = build({}, d)
    print("pi case build %.1f s" % (time.time() - t0))
    for f in r['files'].values():
        m = trimesh.load(f)
        print("  %-22s wt=%s bodies=%d vol=%8.2f cm3" %
              (os.path.basename(f), m.is_watertight, m.body_count, m.volume / 1e3))
