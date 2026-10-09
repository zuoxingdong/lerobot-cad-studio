"""Station nest: the square collar exactly as the collision fixture (inner 54, wall 6, collar_h, a 45°
lead-in to the 66 mouth), on a base plate recessed flush with the plinth top (top at T + LIFT, the
floor the puck stands on), 4 countersunk M3 screws and an engraved ID.  `inc` is the alu heat
block; `reader` adds the black optical-chamber floor under the hood.  Frame: the nest item (centre, T)."""
import math

import _bl as B
import _hw as H
import _kit as K

ROLE = "fixture"

LIFT = 0.1                   # plate over the HPL top: no coplanar faces, inside the ±0.2 tolerance
IDS = {"lh": "N1", "inc": "N2", "reader": "N3"}
KEYS = {"lh": "alu_anod", "inc": "alu", "reader": "alu_anod"}


def collar(ri, t, ch, lead, z0, key):
    """a mitred square frame: flats ri..ri+t, the lead-in from (ri, ch) to (ri+t, ch+lead)"""
    s = math.sqrt(2)
    ro = ri + t
    P = [(ri * s, z0), (ro * s, z0), (ro * s, z0 + ch + lead), (ri * s, z0 + ch), (ri * s, z0)]
    return K.lathe(P, 4, key, 45, 405)


def build(ctx):
    sid = B.sid_of(ctx)
    st = B.station(ctx, sid)
    T, N = st["T"], st["nest"]
    nx, ny = st["at"]
    key = KEYS.get(sid, "alu_anod")
    ri, t, ch, lead = N["inner"] / 2, N["wall"], N["collar_h"], N["lead"]
    m = B.Model(ctx, ctx.name, base=(nx, ny, T))
    m.add(collar(ri, t, ch, lead, T, key).moved(t=(nx, ny, 0)))
    half = ri + t + 11
    zt = T + LIFT
    m.add(K.prism(K.rrect(2 * half, 2 * half, 4.0, 3, nx, ny), T - 3, zt, key, bev=0.25, seg=1))
    c = ri + t + 5.5
    for sx in (-1, 1):
        for sy in (-1, 1):
            m.add(H.screw(3.0, "steel", flat=True).moved(t=(nx + sx * c, ny + sy * c, zt)))
    m.add(K.text(IDS.get(sid, sid[:2].upper()), 6.0, "label_ink").moved(t=(nx, ny - ri - t - 8.5, zt + 0.02)))
    if sid == "reader":
        # chamber floor under the hood footprint (x ±95, y -5..110), around the base plate
        m.add(K.prism(K.rrect(186, 112, 3.0, 3, 0, 52), T - 2, T + LIFT * 0.5, "black_anod", bev=0.2, seg=1))
    return m.finish()
