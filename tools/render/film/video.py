#!/usr/bin/env python3
"""Replay a ctrl log natively and render it to an H.264 MP4: a tracking view plus the robot's cameras.

    video.py <out> [--ctrl ctrl.f32] [--fps 30] [--size 1920x1080] [--mp4 path] [--seconds s]
             [--campath shots.json [--look]]

<out> is an export dir (export.mjs, --visual for display meshes). Without --mp4 the clip is rendered
into <out>, then moved to out/lab-task.mp4, out/teleop.mp4 (a teleop run) or out/draft.mp4 (--campath).
The report.json beside the ctrl log names the phases (run-lab.mjs) or the keys held (run-teleop.mjs) for
the caption, and logs the instrument events: lids, LEDs and bars are posed from them in the rendered scene only
(videopose.py). Frame i is the state at sim time i / fps. Groups 0-2 are drawn, 3 and up
(collision) are not. MUJOCO_GL defaults to egl, then osmesa. --campath draws the hero edit instead: the
authored shots full frame (videoshots.py), the robot-camera inset, captions and cards (videoedit.py).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
import paths  # noqa: E402
import videocam as VC  # noqa: E402
import videofx as FX  # noqa: E402
import videopose as VP  # noqa: E402

SHOW_GROUPS = (1, 1, 1, 0, 0, 0)
SS = 2                      # supersampling: GL multisampling is not bit-reproducible, a box filter is
SIZE = "1920x1080"          # main view 1440x1080, the cameras 3 x 480x360
CRF = 16
CAMS = ("front", "wrist", "top")
FONTS = ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans.ttf")
BT709 = ["-vf", "scale=out_color_matrix=bt709:out_range=tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]
KEY_GLYPH = {"ArrowUp": "↑", "ArrowDown": "↓", "ArrowLeft": "←", "ArrowRight": "→",
             "ShiftLeft": "Shift", "ShiftRight": "Shift", "Space": "Space", "Escape": "Esc"}


def gl_backend():
    """egl, else osmesa: probed in a child so a failed context cannot poison this process."""
    if os.environ.get("MUJOCO_GL"):
        return os.environ["MUJOCO_GL"]
    probe = "import mujoco; m = mujoco.MjModel.from_xml_string('<mujoco/>'); mujoco.Renderer(m, 8, 8).render()"
    for gl in ("egl", "osmesa"):
        env = dict(os.environ, MUJOCO_GL=gl, PYOPENGL_PLATFORM=gl)
        if subprocess.run([sys.executable, "-c", probe], env=env, capture_output=True, timeout=60).returncode == 0:
            return gl
    raise SystemExit("video: no offscreen GL: install EGL (GPU driver) or OSMesa, or set MUJOCO_GL")


def gl_model(m, w, h):
    m.vis.global_.offwidth, m.vis.global_.offheight = w, h
    m.vis.quality.offsamples = 0
    if m.vis.quality.shadowsize == 4096 and abs(m.vis.map.shadowclip - 1.0) < 1e-6:
        # the defaults leave shadow acne on the far floor in the robot cameras
        m.vis.quality.shadowsize, m.vis.map.shadowclip = 8192, 10.0 / m.stat.extent


def ffmpeg_exe():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        import shutil
        return shutil.which("ffmpeg") or sys.exit("video: no ffmpeg: `uv sync --extra sim` (imageio-ffmpeg) or install ffmpeg")


def h264(W, H, fps, mp4, preset, crf, *extra):
    """rgb24 frames on stdin -> H.264 with the BT.709 matrix, tagged (swscale's default is BT.601); makes mp4's dir"""
    os.makedirs(os.path.dirname(os.path.abspath(mp4)), exist_ok=True)
    return [ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (W, H),
            "-r", str(fps), "-i", "-", "-c:v", "libx264", "-preset", preset, "-crf", str(crf), *BT709, "-pix_fmt", "yuv420p",
            *extra, "-movflags", "+faststart", mp4]


def font(size):
    from PIL import ImageFont
    for p in FONTS:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def key_name(code):
    if code in KEY_GLYPH:
        return KEY_GLYPH[code]
    return code[3:] if code.startswith("Key") else code.replace("Digit", "")


INTRO = "4 AI-designed candidates, assembled by the liquid handler"


class Captions:
    """What the caption says at step k: the lab phase, or the teleop label and keys held, and the
    instruments' half (Incubating 37 °C · 3.2 s)."""

    def __init__(self, run):
        self.kind = run.get("kind", "lab")
        self.phases = [(p["step_start"], p["step_end"], p.get("label") or p["phase"]) for p in run.get("phases", [])]
        self.keys = [(k["step_start"], max(k["step_end"], k["step_start"] + 200), k["codes"], k.get("joint"))
                     for k in run.get("keys", [])]

    def at(self, k, st=None):
        label = next((n for a, b, n in self.phases if a <= k < b), self.phases[-1][2] if self.phases else "")
        label = label[:1].upper() + label[1:].replace("_", " ")
        extra = VP.caption(st or {})
        if k * 0.002 < 2.5 and not extra:
            extra = INTRO
        if extra:
            label = extra if extra.startswith(label) else "%s · %s" % (label, extra)
        if self.kind != "teleop":
            return label, ""
        held = []
        for a, b, codes, joint in self.keys:
            if a <= k < b:
                held += [key_name(c) for c in codes if key_name(c) not in held]
                if joint:
                    held.append(joint.replace("arm_", "").replace("_", " "))
        return label, "  ".join(held)


class Layout:
    """Main view on the left, the robot's cameras stacked on the right at 4:3."""

    def __init__(self, W, H):
        self.W, self.H = W, H
        self.th = (H // 3) // 2 * 2
        self.tw = (self.th * 4 // 3) // 2 * 2
        self.mw = W - self.tw
        self.u = H / 720.0                  # layout units: sizes are tuned at 720 lines and scale with the height
        self.f_cap, self.f_tag = font(max(14, round(21 * self.u))), font(max(11, round(14 * self.u)))

    def px(self, v):
        return int(round(v * self.u))

    def hud(self, dr, st, loop):
        """Top-left: a chip per station with its state, the reader's bars once it reads, the loop."""
        if not st:
            return
        P, f = self.px, self.f_tag
        x, y, pad = P(12), P(10), P(5)
        names = {"lh": "LH", "inc": "INC", "reader": "READER"}
        for sid in ("lh", "inc", "reader"):
            o = st.get(sid)
            if not o:
                continue
            c, lvl = VP.led_colour(sid, o, o["since"])
            text = "%s %s" % (names[sid], o["state"] + (" %.1f s" % o["remaining"] if "remaining" in o else ""))
            w = dr.textlength(text, font=f) + P(30)
            dr.rounded_rectangle([x, y, x + w, y + f.size + 2 * pad], P(6), fill=(18, 19, 21, 190))
            cy, r = y + pad + f.size / 2, P(4)
            dr.ellipse([x + P(8), cy - r, x + P(8) + 2 * r, cy + r], fill=tuple(int(255 * v * max(0.35, lvl)) for v in c))
            dr.text((x + P(22), y + pad - P(1)), text, fill=(236, 238, 242, 255), font=f)
            x += w + P(8)
        rd = st.get("reader")
        if rd and rd.get("bars") and any(rd["bars"]):
            y0, bw, gap, mh = y + f.size + P(22), P(26), P(10), P(60)
            dr.rounded_rectangle([P(12), y0, P(12) + 4 * (bw + gap) + gap, y0 + mh + f.size + P(18)], P(6), fill=(18, 19, 21, 190))
            for i, v in enumerate(rd["bars"]):
                bx, h = P(22) + i * (bw + gap), int(mh * v)
                dr.rectangle([bx, y0 + P(6) + mh - h, bx + bw, y0 + P(6) + mh], fill=tuple(int(255 * c) for c in VP.CAPS[i]) + (255,))
                lw = dr.textlength("ABCD"[i], font=f)
                dr.text((bx + (bw - lw) / 2, y0 + mh + P(8)), "ABCD"[i], fill=(236, 238, 242, 255), font=f)
        on = [k for k in VP.LOOP if loop.get(k)]
        if on:
            sep = dr.textlength("  ", font=f)
            w = sum(dr.textlength(k.capitalize(), font=f) for k in VP.LOOP) + 3 * sep + P(16)
            dr.rounded_rectangle([self.mw - w - P(12), y, self.mw - P(12), y + f.size + 2 * pad], P(6), fill=(18, 19, 21, 190))
            xx = self.mw - w - P(4)
            for k in VP.LOOP:
                word = k.capitalize()
                dr.text((xx, y + pad - P(1)), word, fill=(90, 230, 140, 255) if k in on else (130, 134, 140, 255), font=f)
                xx += dr.textlength(word, font=f) + sep

    def compose(self, main, tiles, left, right, t, st=None, loop=None):
        from PIL import Image, ImageDraw
        P = self.px
        im = Image.new("RGB", (self.W, self.H), (18, 19, 21))
        im.paste(Image.fromarray(main).reduce(SS), (0, 0))
        dr = ImageDraw.Draw(im, "RGBA")
        self.hud(dr, st, loop or {})
        for i, (name, px) in enumerate(tiles):
            y = i * self.th
            im.paste(Image.fromarray(px).reduce(SS), (self.mw, y))
            tw = dr.textlength(name.upper(), font=self.f_tag)
            dr.rectangle([self.mw, y, self.mw + tw + P(12), y + self.f_tag.size + P(8)], fill=(18, 19, 21, 190))
            dr.text((self.mw + P(6), y + P(3)), name.upper(), fill=(236, 238, 242, 255), font=self.f_tag)
        if self.H > 3 * self.th:
            dr.rectangle([self.mw, 3 * self.th, self.W, self.H], fill=(18, 19, 21, 255))
        h = self.f_cap.size + P(16)
        dr.rectangle([0, self.H - h, self.mw, self.H], fill=(18, 19, 21, 200))
        dr.text((P(12), self.H - h + P(7)), left, fill=(240, 241, 244, 255), font=self.f_cap)
        stamp = "t %6.2f s" % t
        sw = dr.textlength(stamp, font=self.f_cap)
        dr.text((self.mw - sw - P(12), self.H - h + P(7)), stamp, fill=(240, 241, 244, 255), font=self.f_cap)
        if right:
            kw = dr.textlength(right, font=self.f_cap)
            dr.rectangle([self.mw - sw - kw - P(44), self.H - h + P(4), self.mw - sw - P(28), self.H - P(4)], fill=(47, 91, 211, 230))
            dr.text((self.mw - sw - kw - P(36), self.H - h + P(7)), right, fill=(255, 255, 255, 255), font=self.f_cap)
        return np.asarray(im)


def render(out, ctrl_path, fps, size, mp4, seconds):
    os.environ["MUJOCO_GL"] = gl_backend()
    os.environ.setdefault("PYOPENGL_PLATFORM", os.environ["MUJOCO_GL"])
    import mujoco

    W, H = size
    with open(os.path.join(os.path.dirname(ctrl_path), "report.json"), encoding="utf-8") as fh:
        run = json.load(fh)
    with open(os.path.join(out, "scene.json"), encoding="utf-8") as fh:
        meta = json.load(fh)
    m = mujoco.MjModel.from_xml_path(os.path.join(out, "scene.xml"))
    if run.get("design_hash") != meta.get("design_hash"):
        raise SystemExit("video: %s is a run of another model (hash %s, scene %s)" % (
            ctrl_path, run.get("design_hash"), meta.get("design_hash")))
    ctrl = np.fromfile(ctrl_path, dtype="<f4").reshape(-1, m.nu)
    L = Layout(W, H)
    gl_model(m, SS * max(L.mw, L.tw), SS * H)
    d = mujoco.MjData(m)
    mujoco.mj_resetData(m, d)
    mujoco.mj_forward(m, d)
    opt = mujoco.MjvOption()
    opt.geomgroup[:] = SHOW_GROUPS
    main = mujoco.Renderer(m, SS * H, SS * L.mw, max_geom=20000)
    tile = mujoco.Renderer(m, SS * L.th, SS * L.tw, max_geom=20000)
    for r in (main, tile):
        r.scene.flags[mujoco.mjtRndFlag.mjRND_SHADOW] = 1
        r.update_scene(d, scene_option=opt)
        r.render()                          # a context's first frame differs from every later one
    cams = [c for c in CAMS if c in [m.camera(i).name for i in range(m.ncam)]]
    znear0, extent = float(m.vis.map.znear), float(m.stat.extent)
    near = {c: (meta["cameras"].get(c) or {}).get("near_mm") for c in cams}
    track, cap = VC.Director(mujoco, m, meta, fps), Captions(run)
    lab = VP.lab_doc(meta)
    tl = VP.Timeline(lab, (run.get("outcome") or {}).get("instrument_events"))
    poser, fx = VP.Poser(mujoco, m, lab), FX.Effects(mujoco, m, meta)
    phase_at = [(p["step_start"], p["step_end"], p["phase"]) for p in run.get("phases", [])]
    dt = float(m.opt.timestep)
    steps = len(ctrl) if seconds is None else min(len(ctrl), int(round(seconds / dt)))
    n = int(math.floor(steps * dt * fps + 1e-9)) if seconds is None else int(round(seconds * fps))
    cmd = h264(W, H, fps, mp4, "slow", CRF, "-threads", "4", "-fflags", "+bitexact", "-flags:v", "+bitexact",
                "-map_metadata", "-1")
    enc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    t0, k = time.time(), 0
    try:
        for i in range(n):
            want = min(steps, int(round(i / (fps * dt))))
            while k < want:
                d.ctrl[:] = ctrl[k]
                mujoco.mj_step(m, d)
                fx.step(d)
                k += 1
            st, loop = tl.at(k * dt)
            phase = next((n for a, b, n in phase_at if a <= k < b), None)
            main.update_scene(d, camera=track.update(d, phase, st, L.mw / H), scene_option=opt)
            poser.apply(main.scene, st, loop, k * dt)
            fx.apply(main.scene, d, st)
            px = main.render()
            tiles = []
            for c in cams:
                if near[c]:
                    m.vis.map.znear = near[c] / 1000.0 / extent
                tile.update_scene(d, camera=c, scene_option=opt)
                poser.apply(tile.scene, st, loop, k * dt)
                fx.apply(tile.scene, d, st)
                tiles.append((c, tile.render()))
                m.vis.map.znear = znear0
            left, right = cap.at(k, st)
            enc.stdin.write(L.compose(px, tiles, left, right, k * dt, st if lab else None, loop).tobytes())
    finally:
        enc.stdin.close()
        enc.wait()
        main.close()
        tile.close()
    if enc.returncode:
        raise SystemExit("video: ffmpeg exited %d" % enc.returncode)
    wall = time.time() - t0
    info = dict(mp4=mp4, frames=n, fps=fps, size=[W, H], seconds=round(n / fps, 3), steps=k,
                bytes=os.path.getsize(mp4), wall_s=round(wall, 1), gl=os.environ["MUJOCO_GL"])
    print("wrote %s: %d frames, %.1f s at %d fps, %dx%d, %.1f MB; %.1f s wall (%s)" % (
        os.path.relpath(mp4), n, n / fps, fps, W, H, info["bytes"] / 1e6, wall, info["gl"]))
    return info


def render_edit(out, ctrl_path, fps, size, mp4, seconds, campath, look=False):
    """the GL draft of the hero: the same shots, inset, captions and cards as tools/render/encode.py"""
    os.environ["MUJOCO_GL"] = gl_backend()
    os.environ.setdefault("PYOPENGL_PLATFORM", os.environ["MUJOCO_GL"])
    import mujoco
    import videoedit as VE
    import videoshots as VS
    from PIL import Image

    W, H = size
    run = json.load(open(os.path.join(os.path.dirname(ctrl_path), "report.json"), encoding="utf-8"))
    meta = json.load(open(os.path.join(out, "scene.json"), encoding="utf-8"))
    m = mujoco.MjModel.from_xml_path(os.path.join(out, "scene.xml"))
    if run.get("design_hash") != meta.get("design_hash"):
        raise SystemExit("video: %s is a run of another model" % ctrl_path)
    ctrl = np.fromfile(ctrl_path, dtype="<f4").reshape(-1, m.nu)
    gl_model(m, SS * max(W, VE.WEBCAM[0]), SS * max(H, VE.WEBCAM[1]))
    d = mujoco.MjData(m)
    mujoco.mj_resetData(m, d)
    mujoco.mj_forward(m, d)
    opt = mujoco.MjvOption()
    opt.geomgroup[:] = SHOW_GROUPS
    main, tile = (mujoco.Renderer(m, SS * h, SS * w, max_geom=20000) for w, h in ((W, H), VE.WEBCAM))
    for r in (main, tile):
        r.scene.flags[mujoco.mjtRndFlag.mjRND_SHADOW] = 1
        r.update_scene(d, scene_option=opt)
        r.render()
    znear0, extent = float(m.vis.map.znear), float(m.stat.extent)
    lab = VP.lab_doc(meta)
    shots = VS.Shots(meta, campath, run, m, aspect=W / H, mujoco=mujoco)
    edit = VE.Edit(doc := json.load(open(campath, encoding="utf-8")), run, lab, W, H, fps, look=look, draft=True)
    pool = VE.Pool((doc, run, lab, W, H, fps), dict(look=look, draft=True))
    tl = VP.Timeline(lab, (run.get("outcome") or {}).get("instrument_events"))
    poser, fx = VP.Poser(mujoco, m, lab), FX.Effects(mujoco, m, meta)
    dt = float(m.opt.timestep)
    steps = len(ctrl) if seconds is None else min(len(ctrl), int(round(seconds / dt)))
    n = int(math.floor(steps * dt * fps + 1e-9))
    cmd = h264(W, H, fps, mp4, "medium", 20)
    enc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    t0, k, track, cards = time.time(), 0, [], seconds is None
    try:
        for j in range(edit.n_title * cards):
            enc.stdin.writelines(pool.put("card", "title", j))
        for i in range(n):
            want = min(steps, int(round(i / (fps * dt))))
            while k < want:
                d.ctrl[:] = ctrl[k]
                mujoco.mj_step(m, d)
                fx.step(d)
                k += 1
            st, loop = tl.at(t := k * dt)
            cam = shots.camera(d, t)
            track.append(shots.row() + list(shots.optics))
            m.vis.global_.fovy = shots.fovy            # the free camera's; the robot cameras keep theirs
            main.update_scene(d, camera=cam, scene_option=opt)
            poser.apply(main.scene, st, loop, t)
            fx.apply(main.scene, d, st)
            px = np.asarray(Image.fromarray(main.render()).reduce(SS))
            on, pip = edit.pip_at(t), None
            if on:
                m.vis.map.znear = ((meta["cameras"].get(on[0]) or {}).get("near_mm") or znear0 * extent * 1000) / 1000 / extent
                tile.update_scene(d, camera=on[0], scene_option=opt)
                m.vis.map.znear = znear0
                poser.apply(tile.scene, st, loop, t)
                fx.apply(tile.scene, d, st)
                pip = (on[0], np.asarray(Image.fromarray(tile.render()).reduce(SS)))
            enc.stdin.writelines(pool.put("frame", px, t, i, pip, (shots.shot.id, shots.shot.lens, shots.shot.fstop)))
        for j in range(edit.n_end * cards):
            enc.stdin.writelines(pool.put("card", "end", j))
        enc.stdin.writelines(pool.drain())
    finally:
        pool.close()
        enc.stdin.close()
        enc.wait()
        main.close()
        tile.close()
    if enc.returncode:
        raise SystemExit("video: ffmpeg exited %d" % enc.returncode)
    np.save(os.path.splitext(mp4)[0] + "_track.npy", np.asarray(track))
    print("wrote %s: %d frames, %.1f s; blocked %s lifted %s lint %s" % (mp4, n, time.time() - t0, shots.blocked, shots.lifted, shots.lint()))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("out", help="an export dir: scene.xml, scene.json, meshes/")
    ap.add_argument("--ctrl", help="ctrl log (default <out>/ctrl.f32); its report.json sits beside it")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--size", default=SIZE, help="WxH, even numbers (default %s; 2560x1440 works too)" % SIZE)
    ap.add_argument("--mp4", help="output (default: the product in out/, see above)")
    ap.add_argument("--seconds", type=float, help="only the first s seconds")
    ap.add_argument("--campath", help="rps/campath@1 shots.json: the hero edit, drawn in GL")
    ap.add_argument("--look", action="store_true", help="with --campath: grain and lateral CA too")
    a = ap.parse_args(argv)
    out = os.path.abspath(a.out)
    ctrl = os.path.abspath(a.ctrl or os.path.join(out, "ctrl.f32"))
    W, H = (int(v) for v in a.size.lower().split("x"))
    if W % 2 or H % 2 or W < 320 or H < 240:
        raise SystemExit("video: --size wants even numbers, at least 320x240")
    with open(os.path.join(os.path.dirname(ctrl), "report.json"), encoding="utf-8") as fh:
        kind = json.load(fh).get("kind", "lab")
    name = "draft.mp4" if a.campath else "teleop.mp4" if kind == "teleop" else "lab-task.mp4"
    mp4 = os.path.abspath(a.mp4 or os.path.join(out, name))
    if a.campath:
        render_edit(out, ctrl, a.fps, (W, H), mp4, a.seconds, os.path.abspath(a.campath), a.look)
    else:
        render(out, ctrl, a.fps, (W, H), mp4, a.seconds)
    if not a.mp4:
        print("published %s" % os.path.relpath(paths.publish(mp4, name)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
