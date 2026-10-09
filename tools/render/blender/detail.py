"""Surface detail for shade.Graph: the FDM print (per-layer roughness bands, top-skin infill, a Z seam,
filament lots, edge wear), knit fabric, clear-panel edges and shadows, smudge zones, fine print on labels and a PCB
(solder mask, traces, silkscreen, pads). Each takes the Graph and returns sockets; the specs are looks.json's.
"""
TAU = 6.283185307


def axis(g):
    """the print axis (object space; +Z when unset) and p . axis, made once per graph"""
    if getattr(g, "_axis", None) is None:
        pz = g.attr("rps_pz").outputs["Vector"]
        unset = g.math("LESS_THAN", g.vmath("LENGTH", pz), 0.5)
        ax = g.mix(unset, pz, (0.0, 0.0, 1.0))
        g._axis = (ax, g.vmath("DOT_PRODUCT", g.tc.outputs["Object"], ax))
    return g._axis


def flat(g, lo=0.93, hi=0.985):
    """1 on faces normal to the print axis (top and bottom skins), 0 on walls"""
    ax, _ = axis(g)
    c = g.math("ABSOLUTE", g.vmath("DOT_PRODUCT", g.tc.outputs["Normal"], ax))
    return g.remap(c, 0.0, 1.0, lo, hi)


def smooth01(g, v, a, b):
    n = g.node("ShaderNodeMapRange", interpolation_type="SMOOTHSTEP")
    g.link(v, n.inputs["Value"])
    n.inputs["From Min"].default_value, n.inputs["From Max"].default_value = a, b
    return n.outputs["Result"]


def white(g, v, w=0.0):
    """a hash in [0, 1] of a scalar socket (one value per integer step)"""
    n = g.node("ShaderNodeTexWhiteNoise", noise_dimensions="2D")
    comb = g.node("ShaderNodeCombineXYZ")
    g.link(v, comb.inputs["X"])
    comb.inputs["Y"].default_value = w
    g.link(comb.outputs[0], n.inputs["Vector"])
    return n.outputs["Value"]


def plane(g):
    """(u, v): an orthonormal pair across the print axis, object space"""
    ax, _ = axis(g)
    sep = g.node("ShaderNodeSeparateXYZ")
    g.link(ax, sep.inputs[0])
    near_x = g.math("GREATER_THAN", g.math("ABSOLUTE", sep.outputs["X"]), 0.9)
    ref = g.mix(near_x, (1.0, 0.0, 0.0), (0.0, 1.0, 0.0))
    u = g.vmath("NORMALIZE", g.vmath("CROSS_PRODUCT", ax, ref))
    return u, g.vmath("CROSS_PRODUCT", ax, u)


def lot(g, spec, col):
    """a filament lot per part (Object Info Random picks one of lot.base) with an albedo jitter"""
    L = spec["lot"]
    rnd = g.obj.outputs["Random"]
    out = col
    bases = L.get("base") or []
    for k, b in enumerate(bases[1:], 1):
        out = g.mix(g.math("GREATER_THAN", rnd, k / len(bases)), out, b)
    j = g.math("MULTIPLY_ADD", g.math("FRACT", g.math("MULTIPLY", rnd, 7.31)), 2 * L.get("albedo", 0.02),
               1 - L.get("albedo", 0.02))
    n = g.node("ShaderNodeMix", data_type="RGBA", blend_type="MULTIPLY")
    n.inputs[0].default_value = 1.0
    g.link(out, n.inputs[6]) if not isinstance(out, tuple) else setattr(n.inputs[6], "default_value", (*out[:3], 1.0))
    comb = g.node("ShaderNodeCombineColor")
    for i in range(3):
        g.link(j, comb.inputs[i])
    g.link(comb.outputs[0], n.inputs[7])
    return n.outputs[2]


def band(g, ly):
    """a slow wobble along the print axis (extrusion and Z-wobble banding), phase per part"""
    if getattr(g, "_band", None) is None:
        _, d = axis(g)
        t = g.node("ShaderNodeTexNoise")
        t.inputs["Scale"].default_value, t.inputs["Detail"].default_value = 1.0, 1.0
        comb = g.node("ShaderNodeCombineXYZ")
        g.link(g.math("DIVIDE", d, ly.get("band_mm", 1.2) * 0.001), comb.inputs["X"])
        g.link(g.math("MULTIPLY", g.obj.outputs["Random"], 50.0), comb.inputs["Y"])
        g.link(comb.outputs[0], t.inputs["Vector"])
        g._band = t.outputs["Fac"]
    return g._band


def band_colour(g, spec, col):
    """the banding in the albedo: +-band_albedo along the print axis, plus +-layer_albedo per layer"""
    ly = spec["layer"]
    _, d = axis(g)
    k = g.math("MULTIPLY_ADD", g.math("SUBTRACT", band(g, ly), 0.5), 4 * ly.get("band_albedo", 0.0), 1.0)
    if ly.get("layer_albedo"):
        h = white(g, g.math("FLOOR", g.math("DIVIDE", d, ly.get("pitch_mm", 0.2) * 0.001)), 3.1)
        k = g.math("MULTIPLY_ADD", g.math("SUBTRACT", h, 0.5), 2 * ly["layer_albedo"], k)
    n = g.node("ShaderNodeMix", data_type="RGBA", blend_type="MULTIPLY")
    n.inputs[0].default_value = 1.0
    g.link(col, n.inputs[6]) if not isinstance(col, tuple) else setattr(n.inputs[6], "default_value", (*col[:3], 1.0))
    comb = g.node("ShaderNodeCombineColor")
    for i in range(3):
        g.link(k, comb.inputs[i])
    g.link(comb.outputs[0], n.inputs[7])
    return n.outputs[2]


def print_rough(g, spec, v):
    """roughness bands that read when the layer geometry is sub-pixel: each layer its own offset, a
    slower wobble band, the top skins glossier, a per-part lot offset"""
    ly = spec.get("layer") or {}
    _, d = axis(g)
    pitch = ly.get("pitch_mm", 0.2) * 0.001
    if ly.get("rough_amp"):
        h = white(g, g.math("FLOOR", g.math("DIVIDE", d, pitch)), 1.7)
        v = g.math("MULTIPLY_ADD", g.math("SUBTRACT", h, 0.5), 2 * ly["rough_amp"], v)
    if ly.get("band_rough"):
        v = g.math("MULTIPLY_ADD", g.math("SUBTRACT", band(g, ly), 0.5), 4 * ly["band_rough"], v)
    inf = spec.get("infill")
    if inf:
        f = flat(g)
        top = g.math("MULTIPLY_ADD", infill_wave(g, inf), inf.get("rough_amp", 0.05), inf.get("rough", 0.5))
        v = g.mix(f, v, top, "FLOAT")
    if spec.get("lot"):
        v = g.math("MULTIPLY_ADD", g.math("SUBTRACT", g.obj.outputs["Random"], 0.5), 2 * spec["lot"].get("rough", 0.02), v)
    sm = spec.get("seam")
    if sm:
        v = g.math("MULTIPLY_ADD", seam_mask(g, sm), sm.get("rough", 0.08), v)
    return v


def infill_wave(g, inf):
    """the top-skin lines: sin across a +-45 degree raster (the direction flips with the face side)"""
    if getattr(g, "_infill", None) is None:
        ax, _ = axis(g)
        u, w = plane(g)
        side = g.math("GREATER_THAN", g.vmath("DOT_PRODUCT", g.tc.outputs["Normal"], ax), 0.0)
        a, b = g.vmath("ADD", u, w), g.vmath("SUBTRACT", u, w)
        dirn = g.vmath("SCALE", g.mix(side, b, a))
        dirn.node.inputs["Scale"].default_value = 0.7071068
        s = g.vmath("DOT_PRODUCT", g.tc.outputs["Object"], dirn)
        g._infill = g.math("SINE", g.math("MULTIPLY", s, TAU / (inf.get("pitch_mm", 0.45) * 0.001)))
    return g._infill


def seam_mask(g, sm):
    """the Z seam: a thin stripe along the print axis at a per-part azimuth, walls only"""
    if getattr(g, "_seam", None) is None:
        u, w = plane(g)
        p = g.vmath("SUBTRACT", g.tc.outputs["Object"], g.attr("rps_c").outputs["Vector"])
        a, b = g.vmath("DOT_PRODUCT", p, u), g.vmath("DOT_PRODUCT", p, w)
        r = g.math("SQRT", g.math("ADD", g.math("MULTIPLY", a, a), g.math("MULTIPLY", b, b)))
        th = g.math("SUBTRACT", g.math("ARCTAN2", b, a), g.math("MULTIPLY", g.obj.outputs["Random"], TAU))
        wrap = g.math("PINGPONG", g.math("ADD", th, 3 * TAU), TAU / 2)      # |th|, wrapped to [0, pi]
        dist = g.math("MULTIPLY", r, wrap)
        on = g.math("LESS_THAN", dist, sm.get("w_mm", 0.5) * 0.0005)
        g._seam = g.math("MULTIPLY", on, g.math("SUBTRACT", 1.0, flat(g)))
    return g._seam


def print_bumps(g, spec):
    """extra height fields for the normal chain: the infill raster on skins, the seam blobs"""
    out = []
    inf = spec.get("infill")
    if inf:
        out.append((g.math("MULTIPLY", infill_wave(g, inf), flat(g)), inf.get("amp_mm", 0.02) * 0.001))
    kn = spec.get("knit")
    if kn:
        out.append((knit(g, kn), kn.get("amp_mm", 0.2) * 0.001))
    sm = spec.get("seam")
    if sm:
        _, d = axis(g)
        blob = g.math("MULTIPLY", g.math("SINE", g.math("MULTIPLY", d, TAU / 0.0002)), 0.5)
        out.append((g.math("MULTIPLY", seam_mask(g, sm), g.math("ADD", blob, 0.5)), sm.get("amp_mm", 0.06) * 0.001))
    return out


def knit(g, kn):
    """a knit or hook-and-loop face: stitch wales (a distorted wave at the stitch pitch) and a fine fuzz"""
    w = g.node("ShaderNodeTexWave", wave_type="BANDS", wave_profile="SIN")
    w.inputs["Scale"].default_value, w.inputs["Distortion"].default_value = 1.0, 2.0
    w.inputs["Detail"].default_value, w.inputs["Detail Scale"].default_value = 1.0, 1.5
    g.link(g.coords(kn.get("mm", 1.0) * 0.001 * 6.3), w.inputs["Vector"])
    fuzz = g.noise(kn.get("mm", 1.0) * 0.001 * 0.35, 4.0)
    return g.math("MULTIPLY_ADD", fuzz, 0.6, g.math("MULTIPLY", w.outputs["Fac"], 0.7))


def edge_mask(g, radius_mm=0.6):
    """1 near an edge: where a bevel-rounded normal leaves the true normal"""
    if getattr(g, "_edge", None) is None:
        bv = g.node("ShaderNodeBevel", samples=4)
        bv.inputs["Radius"].default_value = radius_mm * 0.001
        geo = g.node("ShaderNodeNewGeometry")
        c = g.vmath("DOT_PRODUCT", bv.outputs["Normal"], geo.outputs["Normal"])
        g._edge = g.remap(c, 1.0, 0.0, 0.9, 1.0)
    return g._edge


def wear_colour(g, spec, col):
    wr = spec["wear"]
    lift = g.math("MULTIPLY", edge_mask(g, wr.get("mm", 0.6)), wr.get("lift", 0.04))
    n = g.node("ShaderNodeMix", data_type="RGBA", blend_type="SCREEN")
    g.link(lift, n.inputs[0])
    g.link(col, n.inputs[6]) if not isinstance(col, tuple) else setattr(n.inputs[6], "default_value", (*col[:3], 1.0))
    n.inputs[7].default_value = (1.0, 1.0, 1.0, 1.0)
    return n.outputs[2]


def wear_rough(g, spec, v):
    wr = spec["wear"]
    return g.math("MULTIPLY_ADD", edge_mask(g, wr.get("mm", 0.6)), wr.get("rough", -0.1), v)


def panel_edge(g, e, v):
    """cut edges of a clear panel (faces along its thin axis): frosted, so they catch and pipe light"""
    ax, _ = axis(g)
    c = g.math("ABSOLUTE", g.vmath("DOT_PRODUCT", g.tc.outputs["Normal"], ax))
    return g.mix(g.remap(c, 1.0, 0.0, 0.3, 0.6), v, e.get("rough", 0.25), "FLOAT")


def zone(g, z):
    """a smudge zone in the object's bounds (Generated): the lower part, densest at the centre"""
    sep = g.node("ShaderNodeSeparateXYZ")
    g.link(g.tc.outputs["Generated"], sep.inputs[0])
    low = smooth01(g, sep.outputs["Z"], z.get("z_below", 0.4), z.get("z_below", 0.4) - z.get("soft", 0.12))
    mid = g.math("ABSOLUTE", g.math("SUBTRACT", sep.outputs["X"], 0.5))
    centre = g.math("MULTIPLY_ADD", smooth01(g, mid, 0.45, 0.15), 1 - z.get("sides", 0.4), z.get("sides", 0.4))
    return g.math("MULTIPLY", low, centre)


def shadow_clear(g, tint):
    """shadow rays pass a thin clear panel (tinted), so what lies behind it is lit as through real glass"""
    lp = g.node("ShaderNodeLightPath")
    tr = g.node("ShaderNodeBsdfTransparent")
    tr.inputs["Color"].default_value = (*tint[:3], 1.0)
    mx = g.node("ShaderNodeMixShader")
    g.link(lp.outputs["Is Shadow Ray"], mx.inputs[0])
    g.link(g.bsdf.outputs[0], mx.inputs[1])
    g.link(tr.outputs[0], mx.inputs[2])
    g.link(mx.outputs[0], g.out.inputs["Surface"])


def fine_print(g, pr, col):
    """rows of small grey text on vertical faces (rows along object Z), in patches, as on real labels"""
    sep = g.node("ShaderNodeSeparateXYZ")
    g.link(g.tc.outputs["Object"], sep.inputs[0])
    nz = g.node("ShaderNodeSeparateXYZ")
    g.link(g.tc.outputs["Normal"], nz.inputs[0])
    wall = g.math("LESS_THAN", g.math("ABSOLUTE", nz.outputs["Z"]), 0.6)
    line = g.math("DIVIDE", sep.outputs["Z"], pr.get("line_mm", 0.8) * 0.001)
    rows = g.math("LESS_THAN", g.math("FRACT", line), pr.get("fill", 0.45))
    along = g.math("ADD", sep.outputs["X"], sep.outputs["Y"])
    comb = g.node("ShaderNodeCombineXYZ")
    g.link(g.math("DIVIDE", along, 0.0009), comb.inputs["X"])
    g.link(g.math("MULTIPLY", g.math("FLOOR", line), 7.3), comb.inputs["Y"])
    t = g.node("ShaderNodeTexNoise")
    t.inputs["Scale"].default_value, t.inputs["Detail"].default_value = 1.0, 0.0
    g.link(comb.outputs[0], t.inputs["Vector"])
    words = g.math("GREATER_THAN", t.outputs["Fac"], 0.46)
    cid = g.math("ADD", g.math("FLOOR", g.math("DIVIDE", along, 0.006)),
                 g.math("MULTIPLY", g.math("FLOOR", g.math("DIVIDE", sep.outputs["Z"], 0.004)), 31.0))
    patch = g.math("GREATER_THAN", white(g, cid), 1.0 - pr.get("density", 0.5))
    ink = g.math("MULTIPLY", g.math("MULTIPLY", rows, words), g.math("MULTIPLY", patch, wall))
    return g.mix(ink, col, pr.get("ink", (0.14, 0.14, 0.15)))


def pcb(g, p, col):
    """solder mask with copper traces under it, silkscreen outlines and ENIG pads, in the plane of the
    object-space face (its dominant normal axis); sets the pad metal and returns the colour"""
    ab = g.node("ShaderNodeSeparateXYZ")
    g.link(g.vmath("ABSOLUTE", g.tc.outputs["Normal"]), ab.inputs[0])
    o = g.node("ShaderNodeSeparateXYZ")
    g.link(g.tc.outputs["Object"], o.inputs[0])
    zmax = g.math("MULTIPLY", g.math("GREATER_THAN", ab.outputs["Z"], ab.outputs["X"]),
                  g.math("GREATER_THAN", ab.outputs["Z"], ab.outputs["Y"]))
    ymax = g.math("MULTIPLY", g.math("SUBTRACT", 1.0, zmax), g.math("GREATER_THAN", ab.outputs["Y"], ab.outputs["X"]))
    a = g.mix(ymax, g.mix(zmax, o.outputs["Y"], o.outputs["X"], "FLOAT"), o.outputs["X"], "FLOAT")
    b = g.mix(ymax, g.mix(zmax, o.outputs["Z"], o.outputs["Y"], "FLOAT"), o.outputs["Z"], "FLOAT")
    pitch, seg = p.get("trace_mm", 0.64) * 0.001, 0.004

    def traces(s, t, salt):
        k = g.math("FLOOR", g.math("DIVIDE", s, pitch))
        on = g.math("LESS_THAN", g.math("FRACT", g.math("DIVIDE", s, pitch)), 0.3)
        run = white(g, g.math("ADD", g.math("FLOOR", g.math("DIVIDE", t, seg)), g.math("MULTIPLY", k, 17.0)), salt)
        return g.math("MULTIPLY", on, g.math("GREATER_THAN", run, 0.62))
    tr = g.math("MAXIMUM", traces(a, b, 0.3), traces(b, a, 0.7))
    cell = p.get("silk_mm", 4.0) * 0.001
    fa, fb = g.math("FRACT", g.math("DIVIDE", a, cell)), g.math("FRACT", g.math("DIVIDE", b, cell))
    edge = g.math("MAXIMUM", g.math("ABSOLUTE", g.math("SUBTRACT", fa, 0.5)), g.math("ABSOLUTE", g.math("SUBTRACT", fb, 0.5)))
    ring = g.math("MULTIPLY", g.math("GREATER_THAN", edge, 0.41), g.math("LESS_THAN", edge, 0.45))
    cid = g.math("ADD", g.math("FLOOR", g.math("DIVIDE", a, cell)), g.math("MULTIPLY", g.math("FLOOR", g.math("DIVIDE", b, cell)), 57.0))
    silk = g.math("MULTIPLY", ring, g.math("GREATER_THAN", white(g, cid, 2.1), 0.6))
    pp = p.get("pad_mm", 1.27) * 0.001
    pa, pb = g.math("FRACT", g.math("DIVIDE", a, pp)), g.math("FRACT", g.math("DIVIDE", b, pp))
    sq = g.math("MAXIMUM", g.math("ABSOLUTE", g.math("SUBTRACT", pa, 0.5)), g.math("ABSOLUTE", g.math("SUBTRACT", pb, 0.5)))
    pid = g.math("ADD", g.math("FLOOR", g.math("DIVIDE", a, pp)), g.math("MULTIPLY", g.math("FLOOR", g.math("DIVIDE", b, pp)), 131.0))
    pad = g.math("MULTIPLY", g.math("LESS_THAN", sq, 0.3), g.math("GREATER_THAN", white(g, pid, 4.3), 0.94))
    col = g.mix(tr, col, p.get("trace", (0.04, 0.12, 0.06)))
    col = g.mix(silk, col, p.get("silk", (0.75, 0.76, 0.74)))
    col = g.mix(pad, col, p.get("pad", (0.9, 0.62, 0.32)))
    g.mix_scalar_on(pad, "Metallic", 1.0)
    g.mix_scalar_on(g.math("MAXIMUM", silk, pad), "Coat Weight", 0.0)
    g.pcb_relief = g.math("MAXIMUM", g.math("MULTIPLY", tr, 0.5), silk)
    return col


def traffic(g, tr):
    """(polish, scuff) masks on the floor in object xy (m): polish in a band along each lane and around each
    turn point, broken up by a 0.4 m noise; scuffs are faint rubber streaks inside the turn circles"""
    if getattr(g, "_traffic", None) is not None:
        return g._traffic
    p = g.vmath("MULTIPLY", g.tc.outputs["Object"], (1.0, 1.0, 0.0))
    half = tr.get("band_mm", 600) * 0.0005
    near = None
    for x0, y0, x1, y1 in tr.get("lanes_mm", []):
        a, ab = (x0 * 0.001, y0 * 0.001, 0.0), ((x1 - x0) * 0.001, (y1 - y0) * 0.001, 0.0)
        ap = g.vmath("SUBTRACT", p, a)
        t = g.math("MINIMUM", g.math("MAXIMUM", g.math("DIVIDE", g.vmath("DOT_PRODUCT", ap, ab), ab[0] ** 2 + ab[1] ** 2), 0.0), 1.0)
        d = g.vmath("LENGTH", g.vmath("SUBTRACT", ap, g.vmath("MULTIPLY", ab, _vec(g, t))))
        near = d if near is None else g.math("MINIMUM", near, d)
    scuff = None
    for x, y, r in tr.get("turns_mm", []):
        d = g.vmath("DISTANCE", p, (x * 0.001, y * 0.001, 0.0))
        ring = g.math("SUBTRACT", d, r * 0.001)
        near = ring if near is None else g.math("MINIMUM", near, g.math("MAXIMUM", ring, 0.0))
        s = g.math("LESS_THAN", d, r * 0.001)
        scuff = s if scuff is None else g.math("MAXIMUM", scuff, s)
    polish = g.math("MULTIPLY", smooth01(g, near, half, half * 0.45), g.remap(g.noise(0.4, 2.0), 0.45, 1.0, 0.35, 0.65))
    if scuff is not None:
        streak = smooth01(g, g.noise(0.012, 1.0), 0.62, 0.75)
        scuff = g.math("MULTIPLY", g.math("MULTIPLY", scuff, streak), g.remap(g.noise(0.15, 1.0), 0.0, 1.0, 0.45, 0.6))
    g._traffic = (polish, scuff)
    return g._traffic


def _vec(g, s):
    c = g.node("ShaderNodeCombineXYZ")
    for k in ("X", "Y", "Z"):
        g.link(s, c.inputs[k])
    return c.outputs[0]
