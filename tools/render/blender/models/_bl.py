"""The Blender side of the lab models: station frames from ctx.lab / ctx.decor, looks materials (with
a decor alias while a key is unknown to looks.json), and Model, which turns parts into unlinked bpy
objects in metres with weighted normals and a box UV, one object per part."""
import math
import re

import bpy
import numpy as np

from _kit import KEYS, Q, cat


def sid_of(ctx):
    """the station id an anchor names (decor_lh_white, decor_tag_inc, nest_reader, ...)"""
    for k in (ctx.anchor.get("name") or "", (ctx.anchor.get("mesh") or "").replace("decor_", "")):
        m = re.search(r"(?:^|_)(lh|inc|reader)(?:_|$)", k)
        if m:
            return m.group(1)
    return None


def station(ctx, sid):
    """a station of the lab block in its own frame: yaw, origin (front edge centre), w, d, T, nest at"""
    st = next(s for s in ctx.lab["stations"] if s["id"] == sid)
    R, yaw = st["plinth_rect"], st["yaw"]
    sw = abs(round(math.sin(math.radians(yaw))))
    w, d = (R["y"][1] - R["y"][0], R["x"][1] - R["x"][0]) if sw else (R["x"][1] - R["x"][0], R["y"][1] - R["y"][0])
    ux, uy = -math.sin(math.radians(yaw)), math.cos(math.radians(yaw))
    ox = (R["x"][0] + R["x"][1]) / 2 - ux * d / 2
    oy = (R["y"][0] + R["y"][1]) / 2 - uy * d / 2
    c, s_ = math.cos(math.radians(-yaw)), math.sin(math.radians(-yaw))
    nx, ny = st["nest"]["xy"][0] - ox, st["nest"]["xy"][1] - oy
    return dict(st, w=w, d=d, T=ctx.lab["T_mm"], origin=(ox, oy), at=(round(c * nx - s_ * ny, 6), round(s_ * nx + c * ny, 6)))


def item_at(ctx, name, T):
    """a named decor item's frame origin in its own (station or world) frame, mm"""
    it = next(i for i in ctx.decor["items"] if i.get("name") == name)
    zf = lambda v: v if isinstance(v, (int, float)) else T + (float(v[1:]) if len(v) > 1 else 0.0)
    if "xyz" in it:
        return (it["xyz"][0], it["xyz"][1], zf(it["xyz"][2]))
    return (it["xy"][0], it["xy"][1], (zf(it["z"][0]) + zf(it["z"][1])) / 2)


# ---- to Blender -----------------------------------------------------------------------------

ALIAS = {"black_anod": "black", "alu_brushed": "alu", "plinth_top": "slab_white", "rubber": "black",
         "foil": "alu", "touchscreen": "glass", "screen_ui": "screen", "screen_ui_hi": "ui_text",
         "label_ink": "tag_black", "pla_white": "puck_white", "tiprack": "black", "tiprack_blue": "polymer_blue",
         "polymer_black": "black", "chamber_black": "tag_black", "oled_amber": "amber_digits",
         "led_off": "led_white", "steel_polished": "steel", "glass_float": "glass", "glass_frosted": "frosted",
         "glass_boro": "glass", "ceiling_tile": "wall", "ceiling_grid": "paint_white", "floor_vinyl": "paint_white",
         "floor_seam": "skirting", "tape_white": "paint_white", "panel_light": "light", "daylight": "light",
         "fabric_white": "lab_white", "led_red": "red_digits", "polymer_red": "red", "wood": "cardboard", "door_hpl": "cardboard",
         "reaction": "reaction", "label": "label", "pcb": "black", "ic": "black", "connector_w": "paint_white",
         "connector_k": "black", "cable_jacket": "black", "screw_zinc": "steel", "acrylic_clear": "glass", "rubber_roller": "black",
         "pla_cyan": "puck_white", "pla_aqua": "puck_white", "brass": "steel", "roller_ring": "accent", "abs_black": "black",
         "velcro_grey": "black", "velcro_white": "paint_white", "fabric_knit": "black", "fabric_knit_blue": "black",
         "nitrile_coat": "black"}


def _fallback(mt):
    """True when a looks material fell back to the object colour (the key is unknown to looks)"""
    nt = mt.node_tree if mt and mt.use_nodes else None
    if nt is None:
        return False
    b = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    return bool(b and b.inputs["Base Color"].is_linked and b.inputs["Base Color"].links[0].from_node.type == "OBJECT_INFO"
                and not mt.name.endswith("~tint"))


def material(ctx, key, tint=False):
    mt = ctx.material(key, tint)
    if not tint and _fallback(mt) and key in ALIAS:
        return ctx.material(ALIAS[key], tint)
    return mt


TINT = ("led_", "glow_off")


class Model:
    """collects parts per sub-object in a model frame (mm); finish() -> {part: obj} in metres,
    each part relative to its own origin (the frame of the geom it follows)"""

    def __init__(self, ctx, name, base=(0, 0, 0)):
        self.ctx, self.name, self.subs, self.origin = ctx, name, {}, {"body": base}
        self.base = base
        Q["lod"] = getattr(ctx, "lod", "render")

    def add(self, *parts, sub="body"):
        self.subs.setdefault(sub, []).extend(p for p in parts if p is not None)
        return self

    def finish(self, smooth_deg=35.0, tint=()):
        out, bpy_ = {}, self.ctx.bpy
        tmp = bpy_.data.collections.new("_kit_tmp")
        bpy_.context.scene.collection.children.link(tmp)
        for sub, parts in self.subs.items():
            p = cat(parts)
            if not len(p.C):
                continue
            p = p.moved(t=-np.asarray(self.origin.get(sub, self.base), float))
            nm = self.name if sub == "body" else "%s.%s" % (self.name, sub)
            me = _mesh(nm, p, smooth_deg, self.ctx, sub in tint)
            ob = bpy_.data.objects.new(nm, me)
            ob["tris"] = p.tris
            tmp.objects.link(ob)
            wn = ob.modifiers.new("wn", "WEIGHTED_NORMAL")
            wn.keep_sharp, wn.weight, wn.mode = True, 100, "FACE_AREA"
            out[sub] = ob
        dg = bpy_.context.evaluated_depsgraph_get()
        for ob in out.values():
            me = bpy_.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
            old = ob.data
            ob.modifiers.clear()
            ob.data = me
            me.name = ob.name
            bpy_.data.meshes.remove(old)
            tmp.objects.unlink(ob)
        bpy_.data.collections.remove(tmp)
        return out


def _mesh(name, part, smooth_deg, ctx, tinted):
    me = bpy.data.meshes.new(name)
    V = part.V * 0.001
    me.vertices.add(len(V))
    me.vertices.foreach_set("co", V.astype(np.float32).ravel())
    me.loops.add(len(part.L))
    me.loops.foreach_set("vertex_index", part.L.astype(np.int32))
    me.polygons.add(len(part.C))
    starts = np.concatenate([[0], np.cumsum(part.C)[:-1]]).astype(np.int32)
    me.polygons.foreach_set("loop_start", starts)
    used = sorted(set(part.K.tolist()))
    remap = {k: i for i, k in enumerate(used)}
    me.polygons.foreach_set("material_index", np.array([remap[k] for k in part.K], np.int32))
    me.update(calc_edges=True)
    me.validate(clean_customdata=False)
    for k in used:
        me.materials.append(material(ctx, KEYS[k], tinted))
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(smooth_deg))
    _box_uv(me, V, part)
    return me


def _box_uv(me, V, part):
    uv = me.uv_layers.new(name="uv")
    P = V[part.L]
    starts = np.concatenate([[0], np.cumsum(part.C)[:-1]])
    fid = np.repeat(np.arange(len(part.C)), part.C)
    a, b, c = V[part.L[starts]], V[part.L[starts + 1]], V[part.L[starts + 2]]
    N = np.abs(np.cross(b - a, c - a))
    ax = np.argmax(N, axis=1)[fid]
    U = np.where(ax == 0, P[:, 1], P[:, 0])
    W = np.where(ax == 2, P[:, 1], P[:, 2])
    uv.data.foreach_set("uv", np.stack([U, W], 1).astype(np.float32).ravel())
