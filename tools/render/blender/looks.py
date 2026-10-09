"""The photoreal material library: resolve a capture geom to (key, spec), and build a spec as a Cycles node tree.

resolve(), lookup(), emission() and kelvin_rgb() are pure Python (tests import them without bpy); build()
takes the bpy module and draws its graphs from shade.py. The table is tools/render/looks.json.
"""
import math
import os
import re

EMIT = 6.0
TINT_GAIN = 1.5
LM_PER_W = 683.0
FALLBACK = ("pla", {"base": "object", "rough": 0.6, "layer": {"pitch_mm": 0.2, "amp_mm": 0.02}})
CONF = {"lm_per_w": LM_PER_W, "tint_nits": None, "key_scale": 1.0, "relief_gain": 1.0, "assets": {}}


def srgb_to_lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lin3(rgb):
    return tuple(srgb_to_lin(float(c)) for c in rgb[:3])


def kelvin_rgb(k):
    """a Planckian white (Kim et al. locus fit) in linear Rec.709, scaled to luminance Y = 1"""
    t = float(k)
    if t <= 4000:
        x = -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.179910
    else:
        x = -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.240390
    if t <= 2222:
        y = -1.1063814 * x ** 3 - 1.34811020 * x ** 2 + 2.18555832 * x - 0.20219683
    elif t <= 4000:
        y = -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
    else:
        y = 3.0817580 * x ** 3 - 5.87338670 * x ** 2 + 3.75112997 * x - 0.37001483
    X, Z = x / y, (1 - x - y) / y
    r = 3.2404542 * X - 1.5371385 - 0.4985314 * Z
    g = -0.9692660 * X + 1.8760108 + 0.0415560 * Z
    b = 0.0556434 * X - 0.2040259 + 1.0572252 * Z
    return tuple(max(v, 0.0) for v in (r, g, b))


def configure(table, lock=None, cache=None):
    """module settings from looks.json (+ the asset lock and cache dir for texture maps)"""
    CONF["lm_per_w"] = float((table.get("units") or {}).get("lm_per_w", LM_PER_W))
    CONF["tint_nits"] = table.get("tint_nits")
    CONF["key_scale"] = float((table.get("calibration") or {}).get("key_scale", 1.0))
    CONF["relief_gain"] = float(table.get("relief_gain", 1.0))
    CONF["assets"] = {}
    for e in (lock or {}).get("assets", []):
        CONF["assets"][e["id"]] = {r: os.path.join(cache or "", e["id"], f) for r, f in e["maps"].items()}


def asset(name, role):
    """the cached file of a lock asset's map role, or None when it is not fetched"""
    p = CONF["assets"].get(name, {}).get(role)
    return p if p and os.path.exists(p) else None


def _decor_spec(k, decor, table):
    src = (decor.get("materials") or {}).get(k)
    over = (table.get("overlay") or {}).get(k)
    lib = table.get("library") or {}
    ref = (table.get("alias") or {}).get(k, k)
    if ref in lib:
        spec = dict(lib[ref])
        spec.update(over or {})
        return spec
    if src is None and over is None:
        return None
    spec = {}
    if src:
        spec = {"base": lin3(src["rgba"]), "rough": src.get("rough", 0.5), "metal": src.get("metal", 0.0),
                "emit": src.get("emit", 0.0), "alpha": src["rgba"][3]}
    spec.update(over or {})
    if spec.get("alpha", 1) < 1 and "transmission" not in spec:
        spec["transmission"] = 1.0
    return spec


def _rule_spec(r, decor, table):
    if r.get("spec") is not None:
        return dict(r["spec"])
    return _decor_spec(r["key"], decor, table) or dict(FALLBACK[1])


def resolve(g, decor, table):
    """(key, spec) for a capture.json geom: a name/mesh rule, then dm_<k> via the library/decor + overlay,
    then the fallback"""
    name, mesh = g.get("name") or "", g.get("mesh") or ""
    for r in table.get("rules") or []:
        if ("match" in r and re.search(r["match"], name)) or ("mesh" in r and re.search(r["mesh"], mesh)):
            return r["key"], _rule_spec(r, decor, table)
    mat = g.get("mat") or ""
    k = mat[3:] if mat.startswith("dm_") else mat
    if k:
        spec = _decor_spec(k, decor, table)
        if spec is not None:
            return k, spec
    fb = table.get("fallback") or {}
    return fb.get("key", FALLBACK[0]), dict(fb.get("spec") or FALLBACK[1])


def lookup(key, decor, table):
    """the spec a key names (a rule key, a library/decor material or the fallback), for model builders"""
    for r in table.get("rules") or []:
        if r["key"] == key:
            return _rule_spec(r, decor, table)
    spec = _decor_spec(key, decor, table)
    if spec is not None:
        return spec
    return dict((table.get("fallback") or {}).get("spec") or FALLBACK[1])


def is_tinted(g):
    """the tint rule: a geom whose rgba or emission moves reads its colour from the object"""
    return "rgba" in g.get("channels", ()) or "emission" in g.get("channels", ())


def emission(spec, emit=EMIT):
    """(linear rgb or 'object', strength) of a spec's emission; nits are the luminance of white"""
    if spec.get("nits"):
        s = spec["nits"] / CONF["lm_per_w"] * (CONF["key_scale"] if spec.get("key") else 1.0)
        if spec.get("emit_rgb"):
            rgb = tuple(spec["emit_rgb"])
        elif spec.get("kelvin"):
            rgb = kelvin_rgb(spec["kelvin"])
        else:
            rgb = spec.get("base", "object")
        return rgb, s
    if spec.get("emit"):
        return spec.get("base", "object"), emit * spec["emit"]
    return None, 0.0


def tint_strength(emit=EMIT):
    """Object Info Alpha x this = a tinted emitter's strength"""
    if CONF["tint_nits"]:
        return CONF["tint_nits"] / CONF["lm_per_w"]
    return emit * TINT_GAIN


def build(bpy, key, spec, tinted, emit=EMIT):
    """a Material named key (or key~tint), made once; base colours in spec are linear"""
    import shade
    name = key + ("~tint" if tinted else "")
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    mt = bpy.data.materials.new(name)
    if hasattr(mt, "use_nodes") and not mt.node_tree:
        mt.use_nodes = True
    g = shade.Graph(mt)
    bsdf = g.bsdf
    base = spec.get("base", "object")
    g.scalars(spec)
    if base == "object" or tinted:
        g.link(g.obj.outputs["Color"], bsdf.inputs["Base Color"])
    else:
        g.base(base, spec)
    g.roughness(spec)
    if tinted:
        g.tint(spec["tint_nits"] / CONF["lm_per_w"] if spec.get("tint_nits") else tint_strength(emit), spec.get("tint_gate"),
               base if spec.get("tint_gate") and base != "object" else None)
    else:
        rgb, s = emission(spec, emit)
        if s > 0:
            g.emission(rgb, s)
    g.normal(spec)
    if spec.get("volume"):
        g.volume(spec["volume"])
    if spec.get("shadow_clear"):
        shade.detail.shadow_clear(g, base if base != "object" else (1.0, 1.0, 1.0))
    mt.diffuse_color = (*(base if base != "object" else (0.6, 0.6, 0.6)), 1.0)
    return mt


def layer_phase(p, axis, pitch_mm=0.2):
    """the layer-line sine a point gets (the shader's maths, for the tests)"""
    d = sum(a * b for a, b in zip(p, axis))
    return math.sin(2 * math.pi * d / (pitch_mm * 0.001))
