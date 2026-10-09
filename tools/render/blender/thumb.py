"""The Home thumbnails, step 2: the parts tools/render/thumbs.mjs wrote, in looks.json's robot looks, under a neutral
studio light, rendered on a transparent ground with a contact shadow.

    blender.py thumb --in DIR [--robots a,b] [--size 320x240] [--samples 128] [--out-dir DIR]

Writes <out-dir>/<robot>/thumb.png (RGBA); the default out-dir is assets/robots.
"""
import argparse
import json
import math
import os
import sys

import bmesh
import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, HERE)
sys.path.append(os.path.join(STUDIO, "tools"))
import looks  # noqa: E402
import paths  # noqa: E402

RENDER = os.path.join(STUDIO, "tools", "render")
AZ, EL, LENS_MM, FILL = 35.0, 22.0, 60.0, 0.94     # view from front-right, above; frame fill


def args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--robots", default="lekiwi,lekiwi-pincopen")
    ap.add_argument("--size", default="320x240")
    ap.add_argument("--samples", type=int, default=128)
    ap.add_argument("--out-dir")
    return ap.parse_args(argv)


def part_mesh(name, tri):
    """one welded, angle-smoothed mesh from world-space triangles [N, 3, 3]"""
    me = bpy.data.meshes.new(name)
    n = len(tri)
    me.vertices.add(n * 3)
    me.vertices.foreach_set("co", tri.reshape(-1))
    me.loops.add(n * 3)
    me.loops.foreach_set("vertex_index", np.arange(n * 3, dtype=np.int32))
    me.polygons.add(n)
    me.polygons.foreach_set("loop_start", np.arange(0, n * 3, 3, dtype=np.int32))
    me.update(calc_edges=True)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bm.to_mesh(me)
    bm.free()
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(35))
    return me


def light(name, kind, loc, power, size=1.0, target=(0, 0, 0), shadow=True):
    ld = bpy.data.lights.new(name, kind)
    ld.energy = power
    ld.use_shadow = shadow
    if kind == "AREA":
        ld.size = size
    ob = bpy.data.objects.new(name, ld)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = loc
    d = np.asarray(target, float) - np.asarray(loc, float)
    ob.rotation_mode = "QUATERNION"
    from mathutils import Vector
    ob.rotation_quaternion = Vector(d).to_track_quat("-Z", "Y")
    return ob


def frame_camera(lo, hi, aspect):
    """a camera on the AZ/EL ray through the box centre, as close as fits the whole box"""
    from mathutils import Vector
    c = (lo + hi) / 2
    a, e = math.radians(AZ), math.radians(EL)
    fwd = -np.array([math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e)])
    right = np.cross(fwd, [0, 0, 1.0])
    right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    tv = 12.0 / LENS_MM                                 # tan(vfov / 2) on the 24 mm frame
    th = tv * aspect
    d = 0.0
    for corner in np.array(np.meshgrid(*zip(lo, hi))).T.reshape(-1, 3):
        o = corner - c
        z = o @ fwd
        d = max(d, abs(o @ right) / (th * FILL) - z, abs(o @ up) / (tv * FILL) - z)
    cam = bpy.data.cameras.new("camera")
    cam.sensor_fit, cam.sensor_height, cam.lens = "VERTICAL", 24.0, LENS_MM
    cam.clip_start, cam.clip_end = 0.01, 20.0
    co = bpy.data.objects.new("camera", cam)
    bpy.context.scene.collection.objects.link(co)
    co.location = c - d * fwd
    co.rotation_mode = "QUATERNION"
    co.rotation_quaternion = Vector(fwd).to_track_quat("-Z", "Y")
    bpy.context.scene.camera = co
    return c, d


def render(robot, a, table):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    looks.configure(table, json.load(open(os.path.join(RENDER, "assets.lock.json"))),
                    os.path.join(paths.CACHE, "render"))
    src = os.path.join(a.src, robot)
    doc = json.load(open(os.path.join(src, "parts.json")))
    col = bpy.context.scene.collection
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
    for p in doc["parts"]:
        tri = np.fromfile(os.path.join(src, p["file"]), dtype=np.float32).reshape(-1, 3, 3)
        lo, hi = np.minimum(lo, tri.reshape(-1, 3).min(0)), np.maximum(hi, tri.reshape(-1, 3).max(0))
        ob = bpy.data.objects.new(p["name"], part_mesh(p["name"], tri))
        col.objects.link(ob)
        key, spec = looks.resolve({"name": p["name"]}, {}, table)
        ob.data.materials.append(looks.build(bpy, key, spec, False))
    w, h = (int(v) for v in a.size.split("x"))
    c, d = frame_camera(lo, hi, w / h)
    # contact shadow on a transparent ground
    bpy.ops.mesh.primitive_plane_add(size=60.0, location=(c[0], c[1], lo[2]))
    bpy.context.active_object.is_shadow_catcher = True
    # neutral studio: soft key front-left (the one shadow), fill front-right, rim behind, a dim grey world
    r = max(hi - lo)
    light("key", "AREA", c + np.array([-1.0, 1.2, 2.2]) * r * 2, 300 * r * r, size=2.5 * r, target=c)
    light("fill", "AREA", c + np.array([1.6, 0.8, 1.6]) * r * 2, 90 * r * r, size=3.0 * r, target=c, shadow=False)
    light("rim", "AREA", c + np.array([0.3, -1.8, 1.6]) * r * 2, 160 * r * r, size=2.0 * r, target=c, shadow=False)
    world = bpy.data.worlds.new("studio")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.5, 0.5, 0.5, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.2
    sc = bpy.context.scene
    sc.world = world
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = a.samples
    sc.cycles.use_denoising = True
    sc.cycles.seed = 0
    sc.render.film_transparent = True
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = w, h, 100
    sc.view_settings.view_transform = (table.get("film") or {}).get("view", "Khronos PBR Neutral")
    sc.view_settings.look = "None"
    sc.view_settings.exposure = 0.0
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.render.image_settings.color_depth = "8"
    sc.render.image_settings.compression = 100
    out = os.path.join(a.out_dir or os.path.join(STUDIO, "assets", "robots"), robot, "thumb.png")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    sc.render.filepath = out
    bpy.ops.render.render(write_still=True)
    print("thumb: %s, %d parts, camera %.2f m from the centre -> %s" % (robot, len(doc["parts"]), d, out))


def main():
    a = args()
    table = json.load(open(os.path.join(RENDER, "looks.json")))
    for robot in a.robots.split(","):
        render(robot, a, table)


main()
