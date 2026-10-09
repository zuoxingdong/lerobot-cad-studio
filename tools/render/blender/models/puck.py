"""The sample puck (part `puck`, following puck_1_liquid_1): every silhouette is the collision geometry
(foot Ø46x2, body Ø50x22, post Ø17x76, knob Ø19x6, tubes Ø10.8, caps Ø12.5x6) within 0.2 mm; 0.18 mm
edge chamfers, open wells, clear tubes with a real wall (bore just inside the liquid radius), knurled
caps over an O-ring, wrapped white paper cryo labels "ART-k" (a real 200° band, not a chord), and a
concave meniscus collar (1 mm capillary rise at the wall) over the capture's liquid.  Built in the puck body
frame (bottom centre)."""
import math

import numpy as np

import _bl as B
import _hw as H
import _kit as K

ROLE = "fixture"

CH = 0.18                    # edge chamfer: every edge stays within the 0.2 mm fit
CAPS = ["cap_blue", "cap_amber", "cap_green", "cap_pink"]
TUBE_FLOOR = 8.0             # sim-liquid LIQUID floor 1.5 + cone 6.5: the tube bottom under z_low


def params(ctx):
    """sizes from the lab block (post, body, liquid) and the puck's decor cylinders (as scene.json)"""
    lp = ctx.lab["props"][0]
    cy = [i for i in ctx.decor["items"] if i.get("at") == lp["id"] and "cyl" in i]
    axial = sorted((i for i in cy if i["xy"] == [0, 0]), key=lambda i: i["z"][0])
    foot, body, post, knob = axial[:4]
    tube = next(i for i in cy if i["xy"] != [0, 0] and i["mat"] == "tube_clear")
    cap = next(i for i in cy if i["xy"] != [0, 0] and i["mat"].startswith("cap_"))
    rim = next(i for i in cy if i["xy"] != [0, 0] and i["mat"] == foot["mat"])
    L = lp["liquid"]
    return {"id": lp["id"], "r": lp["d"] / 2, "h": body["z"][1], "foot": (foot["cyl"], foot["z"][1]),
            "post": (lp["post_d"] / 2, post["z"][1]), "knob": (knob["cyl"], lp["knob_top"]),
            "wells": [tuple(w) for w in L["wells"]], "well_r": rim["cyl"], "z0": L["z_low_mm"] - TUBE_FLOOR,
            "tube_r": tube["cyl"], "z1": tube["z"][1], "cap": (cap["cyl"], cap["z"][1]), "liquid": L}


def body(P):
    fr, fh = P["foot"]
    r, h, wr, z0 = P["r"], P["h"], P["well_r"], P["z0"]
    parts = [K.lathe([(0, 0), (fr - CH, 0), (fr, CH), (fr, fh), (0, fh)], K.nseg(96), "puck_dark"),
             K.lathe([(fr, fh), (r - CH, fh), (r, fh + CH), (r, h - CH), (r - CH, h)], K.nseg(96), "pla_white")]
    holes = [list(reversed(K.circle(wr, K.nseg(40), x, y))) for x, y in P["wells"]]
    parts.append(K.face_holes(K.circle(r - CH, K.nseg(96)), holes, h, "pla_white"))
    for x, y in P["wells"]:
        parts.append(K.lathe([(wr, h), (wr, z0), (0, z0)], K.nseg(40), "pla_white").moved(t=(x, y, 0)))
    pr, pz = P["post"]
    kr, kz = P["knob"]
    f = 0.5                                              # base fillet: <= 0.15 mm off the corner
    fil = [(pr + f - f * math.sin(a), h + f - f * math.cos(a)) for a in np.linspace(0, math.pi / 2, 5)]
    parts.append(K.lathe(fil + [(pr, pz)], K.nseg(64), "pla_white"))
    parts.append(K.lathe([(0, pz), (kr - CH, pz), (kr, pz + CH), (kr, kz - CH), (kr - CH, kz), (0, kz)], K.nseg(64), "puck_dark"))
    return parts


def tube(P, k, seed):
    """one capped tube at the origin; its label faces azimuth 0"""
    tr, z0, z1 = P["tube_r"], P["z0"], P["z1"]
    cr, cz = P["cap"]
    bore = P["liquid"]["r_mm"] - 0.02                    # the liquid overlaps the wall by 0.02
    out = [(0.8, z0), (2.5, z0 + 1.2), (tr, z0 + 7.0), (tr, z1)]
    inn = [(bore, z1), (bore, z0 + TUBE_FLOOR), (0.6, z0 + 1.6), (0, z0 + 1.6)]
    parts = [K.lathe([(0, z0)] + out + inn, K.nseg(48), "tube_clear")]
    # the O-ring under the cap, then the knurled cap (36 ribs, 0.12 deep)
    ring = [(tr - 0.3, z1), (cr - 0.17, z1), (cr - 0.17, z1 + 0.35), (tr - 0.3, z1 + 0.35), (tr - 0.3, z1)]
    parts.append(K.lathe(ring, K.nseg(48), "rubber"))
    if K.web():
        parts.append(K.cyl(cr, z1 + 0.35, cz, CAPS[k % 4], 96, 0))      # 32 round at the web LOD
        return parts
    star, pitch = [], 2 * math.pi / 36
    for i in range(36):
        for f, rr in ((0.0, cr), (0.55, cr), (0.65, cr - 0.12), (0.9, cr - 0.12)):
            star.append((rr * math.cos(pitch * (i + f)), rr * math.sin(pitch * (i + f))))
    parts.append(K.prism(star, z1 + 0.35, cz, CAPS[k % 4], bev=0.2, seg=1))
    # the cryo label: an opaque paper wrap of 200°, 0.055 thick, a colour band, "ART-k" and a code on it
    parts.append(band(tr + 0.005, tr + 0.06, 29.0, 40.0, 200, "label"))
    parts.append(band(tr + 0.06, tr + 0.075, 29.6, 30.4, 196, CAPS[k % 4]))
    if z1 - 0.5 > 41.2:                                  # the frosted writing field showing above the label
        parts.append(band(tr + 0.002, tr + 0.012, 40.6, min(44.0, z1 - 0.5), 44, "glass_frosted"))
    parts.append(H.wrap_cyl(H.to_wrap(K.text("ART-%d" % (k + 1), 2.3, "label_ink"), 35.6, 0.07), tr).moved(K.rot("z", 12)))
    parts.append(H.wrap_cyl(H.to_wrap(H.matrix_code(10, 0.42, seed, "label_ink", lift=0.015), 35.0, 0.06), tr).moved(K.rot("z", -52)))
    return parts


def band(r0, r1, z0, z1, deg, key):
    """a closed wrap r0..r1 x z0..z1 over deg of arc centred on azimuth 0 (ends capped)"""
    n = max(4, K.nseg(int(deg / 5)))
    a = np.radians(np.linspace(-deg / 2, deg / 2, n + 1))
    ring = [(r0, z0), (r1, z0), (r1, z1), (r0, z1)]
    V = [(r * math.cos(t), r * math.sin(t), z) for t in a for r, z in ring]
    L, C = [], []
    for i in range(n):
        for j in range(4):
            p, q = i * 4 + j, i * 4 + (j + 1) % 4
            L += [p, q, q + 4, p + 4]
            C.append(4)
    L += [0, 3, 2, 1] + [n * 4 + 0, n * 4 + 1, n * 4 + 2, n * 4 + 3]
    C += [4, 4]
    return K.Part(V, L, C, [K.kid(key)] * len(C))


def meniscus(P):
    """the capillary rise at the wall: a ring of liquid from the capture's rest level to 1 mm up the bore,
    its top concave; the capture's flat meniscus disc covers the middle"""
    L = P["liquid"]
    r, z = L["r_mm"] - 0.02, L["z_rest_mm"]
    w, n = 1.3, K.nseg(8, 3)
    top = [(r - w * (1 - k / n), z + 0.1 + 0.9 * (k / n) ** 2.2) for k in range(n + 1)]
    return K.lathe([(r - w, z - 0.45), (r, z - 0.45)] + top[::-1][:1] + top[::-1][1:] + [(r - w, z - 0.45)], K.nseg(48), "reaction")


def build(ctx):
    P = params(ctx)
    L = P["liquid"]
    x1, y1 = P["wells"][0]
    m = B.Model(ctx, ctx.name, base=(x1, y1, (L["z_low_mm"] + L["z_rest_mm"]) / 2))
    m.origin["puck"] = m.base
    m.add(*body(P), sub="puck")
    for k, (x, y) in enumerate(P["wells"]):
        az = math.degrees(math.atan2(y, x))
        m.add(*[p.moved(K.rot("z", az), (x, y, 0)) for p in tube(P, k, 7 + k)], sub="puck")
        m.add(meniscus(P).moved(t=(x, y, 0)), sub="puck")
    return m.finish()
