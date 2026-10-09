"""The lighting rig (looks.json rig block): a closed room, ceiling panels as emitter meshes, the corridor
daylight, a desaturated HDRI seen only by glossy rays, the film (Khronos PBR Neutral, exposure, white
balance) and the sampling.

When a hi-fi room model supplies its own `panel_light` emitters, they are the key; otherwise the room is
closed here: a front wall and ceiling, 6 + 1 emitter panels and a corridor.
calibration.key_scale in looks.json is measured for the model room.
"""
import os

import bpy
import numpy as np

import looks
import prims

MM = 0.001


def _obj(name, data, col, mat):
    ob = bpy.data.objects.new(name, data)
    col.objects.link(ob)
    ob.data.materials.append(mat)
    return ob


def slab(name, x, y, z, col, mat):
    """an axis-aligned box from mm ranges"""
    c = [(a + b) / 2 * MM for a, b in (x, y, z)]
    h = [abs(b - a) / 2 * MM for a, b in (x, y, z)]
    ob = _obj(name, prims.box(name, h), col, mat)
    ob.location = c
    return ob


def panel(name, cx, cy, w, d, z, col, mat):
    """a downward-facing diffuser quad (mm), the emitter of one luminaire"""
    hw, hd = w / 2 * MM, d / 2 * MM
    V = np.array([(-hw, -hd, 0), (hw, -hd, 0), (hw, hd, 0), (-hw, hd, 0)])
    me = prims.mesh_from(name, V, np.array([(0, 2, 1), (0, 3, 2)]))
    ob = _obj(name, me, col, mat)
    ob.location = (cx * MM, cy * MM, z * MM)
    return ob


def room(B, mat):
    """close the capture's room: front wall, ceiling with a T24 grid, panels, the corridor and its window"""
    R = B.table.get("room") or {}
    col = bpy.data.collections.new("room")
    bpy.context.scene.collection.children.link(col)
    (x0, x1), (y0, y1), zc = R.get("x", (-2100, 2300)), R.get("y", (-1500, 1950)), R.get("ceiling_mm", 2700)
    slab("front_wall", (x0 - 100, x1), (y0 - 100, y0), (0, zc), col, mat("wall"))
    slab("ceiling", (x0 - 100, x1 + 20), (y0 - 100, y1 + 100), (zc, zc + 20), col, mat("ceiling_tile"))
    for k, x in enumerate(np.arange(x0 + 600, x1, 600)):
        slab("tee_x%d" % k, (x - 7.5, x + 7.5), (y0, y1), (zc - 8, zc), col, mat("ceiling_grid"))
    for k, y in enumerate(np.arange(y0 + 600, y1, 600)):
        slab("tee_y%d" % k, (x0, x1), (y - 7.5, y + 7.5), (zc - 8, zc), col, mat("ceiling_grid"))
    for k, (cx, cy, w, d) in enumerate(R.get("panels", ())):
        slab("panel_frame_%d" % k, (cx - w / 2 - 10, cx + w / 2 + 10), (cy - d / 2 - 10, cy + d / 2 + 10),
             (zc - 10, zc - 8.5), col, mat("ceiling_grid"))
        panel("panel_%d" % k, cx, cy, w, d, zc - 10.5, col, mat("panel_light"))
    C = R.get("corridor")
    if C:
        cx0, cx1 = C["x"]
        slab("corridor_wall", (cx1, cx1 + 100), (y0 - 100, y1 + 100), (0, zc), col, mat("wall"))
        for nm, y in (("corridor_end_a", (y0 - 100, y0)), ("corridor_end_b", (y1, y1 + 100))):
            slab(nm, (cx0, cx1), y, (0, zc), col, mat("wall"))
        slab("corridor_ceiling", (cx0, cx1 + 100), (y0 - 100, y1 + 100), (zc, zc + 20), col, mat("ceiling_tile"))
        for k, (px, py, w, d) in enumerate(C.get("panels", ())):
            panel("corridor_panel_%d" % k, px, py, w, d, zc - 1, col, mat("panel_light"))
        wn = C["window"]
        V = np.array([(0, wn["y"][0], wn["z"][0]), (0, wn["y"][1], wn["z"][0]), (0, wn["y"][1], wn["z"][1]),
                      (0, wn["y"][0], wn["z"][1])]) * MM
        ob = _obj("daylight", prims.mesh_from("daylight", V, np.array([(0, 2, 1), (0, 3, 2)])), col, mat("daylight"))
        ob.location = (wn["x"] * MM, 0, 0)
    return col


def world(B, hdri=None):
    """the HDRI (desaturated) for glossy rays only; every other ray sees the dark rgb"""
    W = B.table.get("world") or {}
    sc = bpy.context.scene
    wd = bpy.data.worlds.new("world")
    sc.world = wd
    if wd.node_tree is None:
        wd.use_nodes = True
    N, L = wd.node_tree.nodes, wd.node_tree.links
    bg = N["Background"]
    bg.inputs["Color"].default_value = (*W.get("rgb", (0, 0, 0)), 1)
    bg.inputs["Strength"].default_value = 1.0
    hdr = hdri or looks.asset(W.get("hdri", ""), "hdr")
    if not hdr:
        return None
    env, sat, lp = N.new("ShaderNodeTexEnvironment"), N.new("ShaderNodeHueSaturation"), N.new("ShaderNodeLightPath")
    env.image = bpy.data.images.load(os.path.abspath(hdr), check_existing=True)
    sat.inputs["Saturation"].default_value = W.get("saturation", 0.0)
    mix, gain = N.new("ShaderNodeMix"), N.new("ShaderNodeMath")
    mix.data_type = "RGBA"
    gain.operation = "MULTIPLY"
    gain.inputs[1].default_value = W.get("strength", 0.3)
    L.new(env.outputs["Color"], sat.inputs["Color"])
    L.new(lp.outputs["Is Glossy Ray"], gain.inputs[0])
    L.new(gain.outputs[0], mix.inputs[0])
    mix.inputs[6].default_value = (*W.get("rgb", (0, 0, 0)), 1)
    L.new(sat.outputs["Color"], mix.inputs[7])
    L.new(mix.outputs[2], bg.inputs["Color"])
    return hdr


def film(B):
    sc = bpy.context.scene
    f = B.table.get("film") or {}
    vs = sc.view_settings
    vs.view_transform = f.get("view", "Khronos PBR Neutral")
    vs.look = f.get("look") or "None"
    vs.exposure = f.get("exposure", 0.0)
    if f.get("white_balance_k") and hasattr(vs, "use_white_balance"):
        vs.use_white_balance = True
        vs.white_balance_temperature = f["white_balance_k"]
        vs.white_balance_tint = f.get("tint", 10.0)


def veil(B):
    """lens veiling glare: film.veil x a wide blur of the image (a quarter of the frame height), added before
    the view transform, so the darkest shadows sit on a little scattered light as in a photo"""
    k = float((B.table.get("film") or {}).get("veil", 0.0))
    sc = bpy.context.scene
    if k <= 0 or not hasattr(sc, "compositing_node_group"):
        return
    t = bpy.data.node_groups.new("veil", "CompositorNodeTree")
    t.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    N, L = t.nodes, t.links
    rl, blur, add, out = (N.new(n) for n in ("CompositorNodeRLayers", "CompositorNodeBlur", "ShaderNodeMix", "NodeGroupOutput"))
    rl.scene = sc
    blur.inputs["Type"].default_value = "Fast Gaussian"
    blur.inputs["Size"].default_value = (270.0, 270.0)            # px at 1080p
    add.data_type, add.blend_type = "RGBA", "ADD"
    add.inputs["Factor"].default_value = k
    L.new(rl.outputs["Image"], blur.inputs["Image"])
    L.new(rl.outputs["Image"], add.inputs[6])
    L.new(blur.outputs["Image"], add.inputs[7])
    L.new(add.outputs[2], out.inputs[0])
    sc.compositing_node_group = t
    sc.render.use_compositing = True


def sampling(B):
    """bounce limits and clamps, stored on the scene for render.py (rps_sampling)"""
    s = dict(B.table.get("sampling") or {})
    c = bpy.context.scene.cycles
    for k in ("diffuse_bounces", "glossy_bounces", "transmission_bounces"):
        if k in s:
            setattr(c, k, int(s[k]))
    if "clamp_indirect" in s:
        c.sample_clamp_indirect = s["clamp_indirect"]
    if "filter_glossy" in s:
        c.blur_glossy = s["filter_glossy"]
    bpy.context.scene["rps_sampling"] = s


def apply(B, hdri=None):
    """after the geoms and models: the room (unless a model supplies panels), world, film and sampling"""
    def mat(key):
        return looks.build(bpy, key, looks.lookup(key, B.decor, B.table), False, B.emit)
    supplied = [ob.name for ob in bpy.data.objects if ob.type == "MESH" and any(
        s.material and s.material.name == "panel_light" for s in ob.material_slots)]
    made = None if supplied else room(B, mat)
    hdr = world(B, hdri)
    film(B)
    veil(B)
    sampling(B)
    n = len(supplied) if supplied else sum(1 for o in made.objects if "panel_" in o.name and "frame" not in o.name)
    print("rig: %s room, %d panel emitters, hdri %s, exposure %+.2f EV" % (
        "model" if supplied else "own", n, os.path.basename(hdr) if hdr else "none",
        bpy.context.scene.view_settings.exposure))
