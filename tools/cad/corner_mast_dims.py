"""Every measured number of the corner mast, and the three solid helpers that use them.

Camera frame at the design tilt: `n` forward along the optical axis, `up` image-up,
`xd` image-right.  Robot millimetres everywhere else.
"""
import math

import cadquery as cq
import numpy as np

# param key -> (default, min, max)
PARAMS = {
    'tilt_deg':   (55.0, 35.0, 75.0),
    'pan_deg':    (10.0, -30.0, 30.0),
    'cam_z':      (500.0, 400.0, 620.0),
    'head_fwd':   (30.0, 10.0, 90.0),
    'post_x':     (-80.0, -95.0, -55.0),
    'post_y':     (-45.0, -75.0, -10.0),
    'wall':       (3.5, 2.4, 5.0),
    # the spar is split so BOTH halves clear a 256 mm Z bed: the lower half runs from the
    # deck plate (Z 57) to split_z + 20 (the spigot), the upper from split_z to the top of the
    # index fan.  285 gives 248.0 and 229.6 mm.
    'split_z':    (285.0, 200.0, 380.0),
    'mod_w':      (36.0, 20.0, 50.0),
    'mod_h':      (36.0, 20.0, 50.0),
    'mod_d':      (11.0, 6.0, 25.0),
    'fit':        (0.4, 0.0, 1.5),
    'lip':        (3.0, 1.0, 6.0),
}

DECK_Z = 57.0            # deck top, robot mm
PAD_Z1 = 63.0            # base plate top
# M3 on the measured 20 mm deck grid, clear of the Pi case (|X| <= 50, Y -95..-48) and with a
# driver axis that reaches them: each of the four measures 60 mm of clear O7 driver, cast down
# the fastener axis against the assembled robot.  (-80, -40) and (-80, -60) sit under the
# spar's foot.  The deck rim is r 107.5, so (-100, -40), (-100, -60) and (-80, -80) are off
# the plate.
BOLTS = [(-60., -60.), (-60., -40.), (-60., -20.), (-80., -20.)]
# --- camera module: the JR DF200 clamp pocket the shared camera_retainer_PRINT.stl and
#     camera_shims_PRINT.stl fit ---
SENSOR_IN = 4.0          # sensor behind the module's FRONT face
LENS_SQ = 30.0
PWALL = 3.5
# The shared retainer plate, turned 90 deg, ears along image-UP: flat it
# would make the head 58 mm wide in X and cross the arm's raised envelope (|X| < 45); on end it
# is 43 mm and clears by 5.5 mm.  The pocket is square, so the clamp works either way round.
EAR_U, EAR_D, EAR_L = 24.0, 10.0, 9.0
RET_L, RET_H, RET_T = 58.0, 26.0, 4.0     # the shared retainer plate
RET_WIN = (24.0, 14.0)                    # its cable window
RET_BOSS = 3.5                            # the boss that presses the module (2.7 gap + 0.8)
# The YOKE.  The head is a clamp block, hung between two cheeks on the
# image-right axis.  Every offset below is in the camera frame at the DESIGN tilt.  The
# pocket's open rear needs a clear 36.4 x 36.4 corridor from the seating plane back to
# n = -47.3 - nothing may live there, which is what fixes the rest:
HINGE_N = -4.0           # hinge axis, along n from the sensor (inside the block's depth)
HINGE_U = -33.0          # ... and along image-up: BELOW the pocket (18.2), below the
                         # retainer plate's end (29.0) and below the lower driver axis
                         # (24 +- 3), so the bolt crosses none of them
HINGE_BOLT = 3.4         # M3 clearance, hinge and index pin
LUG_XD0 = 13.5           # the head's hinge lugs: side plates, xd 13.5 .. OUT_W/2, so the
                         # retainer (xd +-13) and both drivers (xd +-3) pass between them
LUG_R = 6.5              # the lug's rounded end about the hinge (3.4 hole + 1.55 of wall)
CHEEK_GAP = 0.40         # yoke cheek inner face, clear of the head's side
CHEEK_T = 5.0            # cheek thickness
CHEEK_R = 16.0           # plain (inboard) cheek radius about the hinge
# index: 5 deg steps, 40..70 deg, split over TWO radii so the holes are 10 deg apart on each
# ring.  One ring at 5 deg would need r >= 36.7 mm and still leave 0.3 mm of wall between
# holes; two rings give 4.36 / 5.76 mm of pitch and 1.16 / 2.56 mm of wall at r 25 / 33.
IDX_R_IN, IDX_R_OUT = 25.0, 33.0
IDX_STEP = 5.0
IDX_LO, IDX_HI = 40.0, 70.0
IDX_D = 3.2              # index-pin holes
IDX_SEAT_D = 3.0         # ... and how deep the head's own seats are - BLIND, so the pocket is
                         # closed to light and dust and the shipped M3 x 8 pin cannot reach
                         # the camera module (0.00 mm3, measured on the meshes)
FAN_R = 36.5             # index fan outer radius (on the OUTBOARD cheek only: an inboard
                         # fan would reach X -46.9, inside the arm envelope |X| < 45)
FAN_HALF = 21.0          # fan half-angle about +up, deg
YOKE_RISE = 27.0         # hinge height above the yoke seat plane (the head's lowest
                         # point, over its whole 40..70 swing, clears the cross web)
FOOT_T = 6.0             # spar top, this far under the yoke seat plane
CABLE_D = 7.5
# The PRINTED SPAR's spigot joint.  A chamfered rectangle, so the joint carries the torque and
# fixes the pan; a printed witness chevron says which way round.  The fit is tighter FORE-AFT
# than laterally, because Y is the plane the head's overhang bends the mast in.
SPG_CLR_X, SPG_CLR_Y = 0.35, 0.18
# The GUSSET fins on the deck plate, each clipped to the plate's outline and kept clear of
# every deck bolt's driver relief.
GUS_T = 6.5                      # wall thickness (>= 6 mm; 16 lines at a 0.4 nozzle)
GUS_H = 42.0                     # wall height above the plate face (Z 62.9 .. 104.9)
GUS_END = 2.0                    # ... and at the far end of each ray, so it is not a knife edge
GUS_RUN_MAX = 24.0               # how far out a ray may reach at all
GUS_MARGIN = 3.0                 # of plate left outboard of the wall
GUS_BOLT_CLR = 0.5               # of air between the wall RECTANGLE and a O7.5 driver relief
GUS_SPAR_MIN = 4.0               # a fin on the printed base is only worth printing if it can
                                 # run this far outboard of the spar's own foot


def box(x0, x1, y0, y1, z0, z1):
    x0, x1 = sorted((x0, x1))
    y0, y1 = sorted((y0, y1))
    z0, z1 = sorted((z0, z1))
    return cq.Solid.makeBox(x1 - x0, y1 - y0, z1 - z0, cq.Vector(x0, y0, z0))


def cyl(r, h, o, d):
    return cq.Solid.makeCylinder(r, h, cq.Vector(*o), cq.Vector(*d))


def rrect(w, d, r):
    """rounded rectangle wire helper -> a Workplane sketch at the origin."""
    return cq.Workplane('XY').rect(w, d).val()


def _ret_place(C):
    """bed -> camera frame for the retainer plate, orthonormalised.

    `up` is a cross product of two floats, so the raw basis is orthogonal only to ~1e-16 and
    OCC refuses it ("non-orthogonal GTrsf").  One polar decomposition makes it exact."""
    R = np.column_stack([C.up, -C.xd, -C.n])       # right-handed: det +1, or OCC refuses it
    U, _, Vt = np.linalg.svd(R)
    M = np.eye(4)
    M[:3, :3] = U @ Vt
    M[:3, 3] = C.CAM + C.EAR_BACK * C.n
    return M


def _ret_loc(C):
    """the same placement as an axis / angle / translation, which is what OCC wants."""
    R = _ret_place(C)[:3, :3]
    ang = math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(R) - 1.0) / 2.0))))
    if ang < 1e-9:
        ax = np.array([0., 0., 1.])
    else:
        w, v = np.linalg.eig(R)
        ax = np.real(v[:, np.argmin(np.abs(w - 1.0))])
        ax = ax / np.linalg.norm(ax)
        K = np.array([[0, -ax[2], ax[1]], [ax[2], 0, -ax[0]], [-ax[1], ax[0], 0]])
        chk = np.eye(3) + math.sin(math.radians(ang)) * K + \
            (1 - math.cos(math.radians(ang))) * (K @ K)
        if np.linalg.norm(chk - R) > 1e-6:
            ax = -ax
    return ax, ang, _ret_place(C)[:3, 3]


