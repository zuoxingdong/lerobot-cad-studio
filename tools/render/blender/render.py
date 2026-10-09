"""Render a built .blend: Cycles on OptiX, OIDN on the GPU, Khronos PBR Neutral, 8-bit PNG frames.
Complete frames are skipped, so a range can stop and resume; each frame is written to a .tmp.png and
renamed, and a truncated PNG is rendered again. Writes <out>/<tag>.json with per-frame seconds.

    blender -b lab.blend -P render.py -- --out DIR [--frames a:b | --frame f | --list f1,f2] [--size 1920x1080]
        [--samples 128] [--denoise gpu|cpu|off] [--blur] [--dof fstop] [--threshold 0.01] [--tag render]
        [--camera cam_wrist]

--dof: 0 off, an f-stop, or (default) the .blend's own keys.
"""
import argparse
import json
import os
import sys
import time

import bpy

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from jobs import png_ok  # noqa: E402

VIEW = "Khronos PBR Neutral"          # the film view (looks.json film.view); no look


def args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--frames", help="a:b inclusive (default: the scene's range)")
    ap.add_argument("--frame", type=float, help="one frame (fractional frames round to the nearest)")
    ap.add_argument("--list", help="frames f1,f2,... (in place of a range)")
    ap.add_argument("--size", default="1920x1080")
    ap.add_argument("--samples", type=int, default=128)
    ap.add_argument("--threshold", type=float, default=0.01)
    ap.add_argument("--denoise", default="gpu", choices=("gpu", "cpu", "off"))
    ap.add_argument("--blur", action="store_true", help="180 degree shutter")
    ap.add_argument("--dof", type=float, help="f-stop; 0 = off; default: as built")
    ap.add_argument("--camera", help="a camera object in place of the scene camera, e.g. cam_wrist")
    ap.add_argument("--device", default="OPTIX", help="OPTIX, CUDA or CPU")
    ap.add_argument("--tag", default="render")
    return ap.parse_args(argv)


def device(kind):
    c = bpy.context.scene.cycles
    if kind == "CPU":
        c.device = "CPU"
        return "CPU"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = kind
    prefs.refresh_devices()
    gpus = [d for d in prefs.devices if d.type == kind]
    for d in prefs.devices:
        d.use = d.type == kind
    if not gpus:
        raise SystemExit("render: no %s device (driver?)" % kind)
    c.device = "GPU"
    return gpus[0].name


def setup(a):
    sc = bpy.context.scene
    r, c = sc.render, sc.cycles
    r.engine = "CYCLES"
    dev = device(a.device)
    W, H = (int(v) for v in a.size.lower().split("x"))
    r.resolution_x, r.resolution_y, r.resolution_percentage = W, H, 100
    c.samples, c.use_adaptive_sampling, c.adaptive_threshold = a.samples, True, a.threshold
    c.use_denoising = a.denoise != "off"
    if c.use_denoising:
        c.denoiser = "OPENIMAGEDENOISE"
        c.denoising_use_gpu = a.denoise == "gpu"
        c.denoising_input_passes, c.denoising_prefilter, c.denoising_quality = "RGB_ALBEDO_NORMAL", "ACCURATE", "HIGH"
    c.use_light_tree = True
    c.max_bounces, c.diffuse_bounces, c.glossy_bounces = 12, 4, 4
    c.transmission_bounces, c.transparent_max_bounces = 12, 16
    c.caustics_reflective = c.caustics_refractive = False
    c.blur_glossy = 1.0
    for k, v in (sc.get("rps_sampling") or {}).items():     # looks.json sampling, stored by the build
        if k in ("diffuse_bounces", "glossy_bounces", "transmission_bounces"):
            setattr(c, k, int(v))
        elif k == "clamp_indirect":
            c.sample_clamp_indirect = float(v)
        elif k == "filter_glossy":
            c.blur_glossy = float(v)
    c.seed, c.use_animated_seed = 0, False
    r.use_persistent_data = True
    r.use_motion_blur, r.motion_blur_shutter = a.blur, 0.5
    if a.camera:
        sc.camera = bpy.data.objects[a.camera]
        own_housing(sc)
    cam = sc.camera.data
    if a.dof is not None:
        cam.dof.use_dof = a.dof > 0
        if a.dof > 0:
            cam.dof.aperture_fstop = a.dof
    vs = sc.view_settings
    vs.view_transform = VIEW
    vs.look = "None"
    im = r.image_settings
    im.file_format, im.color_mode, im.color_depth, im.compression = "PNG", "RGB", "8", 15
    return dev, (W, H)


def own_housing(sc):
    """a robot camera sits inside its own module; hide that mesh from camera rays only (GL culls those back faces)"""
    from mathutils import Vector
    sc.frame_set(sc.frame_start)
    p = sc.camera.matrix_world.translation
    for ob in sc.objects:
        if ob.type != "MESH" or max(ob.dimensions) > 0.12:
            continue
        q = ob.matrix_world.inverted() @ p
        lo, hi = Vector(map(min, *ob.bound_box)), Vector(map(max, *ob.bound_box))
        if all(lo[k] <= q[k] <= hi[k] for k in range(3)):
            ob.visible_camera = False
            print("render: %s hidden from %s rays" % (ob.name, sc.camera.name))


def frames(a, sc):
    if a.list:
        return sorted({int(v) for v in a.list.split(",")})
    if a.frame is not None:
        f = int(round(a.frame))
        return f, f
    if a.frames:
        lo, _, hi = a.frames.partition(":")
        return int(lo), int(hi or lo)
    return sc.frame_start, sc.frame_end


def main():
    a = args()
    sc = bpy.context.scene
    dev, size = setup(a)
    want = frames(a, sc)
    want = want if isinstance(want, list) else list(range(want[0], want[1] + 1))
    lo, hi = want[0], want[-1]
    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    path = lambda f: os.path.join(out, "f%05d.png" % f)  # noqa: E731
    for n in os.listdir(out):
        if n.endswith(".tmp.png"):
            os.remove(os.path.join(out, n))     # a frame cut off mid-write
    todo = []
    for f in want:
        p = path(f)
        if os.path.exists(p) and not png_ok(p):
            print("render: %s is truncated, rendering it again" % os.path.basename(p))
            os.remove(p)
        if not os.path.exists(p):
            todo.append(f)
    log, t0 = [], time.time()
    for f in todo:
        t = time.time()
        sc.frame_set(f)
        tmp = path(f)[:-4] + ".tmp.png"
        sc.render.filepath = tmp
        bpy.ops.render.render(write_still=True)
        os.replace(tmp, path(f))
        log.append([f, round(time.time() - t, 3)])
        print("frame %d: %.2f s" % tuple(log[-1]), flush=True)
    info = dict(frames=[lo, hi], rendered=len(todo), skipped=len(want) - len(todo), size=list(size),
                samples=a.samples, denoise=a.denoise, blur=a.blur, dof=sc.camera.data.dof.use_dof, device=dev, look=sc.view_settings.view_transform,
                wall_s=round(time.time() - t0, 2), per_frame_s=log, blender=bpy.app.version_string)
    with open(os.path.join(out, a.tag + ".json"), "w") as fh:
        json.dump(info, fh, indent=1)
    print("render:", json.dumps({k: v for k, v in info.items() if k != "per_frame_s"}))


main()
