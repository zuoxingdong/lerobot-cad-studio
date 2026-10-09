#!/usr/bin/env python3
"""Rendered frames -> the hero MP4, through the same edit as the GL draft (film/videoedit.py): grain,
vignette and lateral CA on the frame, the robot-camera inset with its webcam look, lower-third captions,
the title and end cards. Writes <mp4 stem>_web.mp4 (HEVC CRF 22, hvc1); --full also writes the H.264 CRF 16
master at --mp4. BT.709 matrix and tags. Each MP4 is written to <name>.part and renamed when ffmpeg succeeds.

    encode.py --lab DIR --frames DIR [--pip DIR] --mp4 out.mp4 [--shots shots.json] [--t0 s] [--seconds s]
              [--no-cards] [--full] [--workers 8]

--lab is the export dir of the run (report.json, scene.json). Frame i is f%05d.png (run frame i, time
round(i / (fps dt)) dt); the inset for camera c is <pip>/<c>/f%05d.png and must exist wherever the
edit shows it. Cards are added only when the frames cover the whole run.
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

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "film"))
import video as VID  # noqa: E402
import videoedit as VE  # noqa: E402

CRF, WEB_CRF = 16, 22


BT709 = ["-vf", "scale=out_color_matrix=bt709:out_range=tv", "-colorspace", "bt709", "-color_primaries", "bt709",
         "-color_trc", "bt709"]


def rawin(W, H, fps):
    return [VID.ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (W, H),
            "-r", str(fps), "-i", "-"]


def x264(W, H, fps, mp4):
    return rawin(W, H, fps) + ["-c:v", "libx264", "-preset", "slow", "-crf", str(CRF), "-tune", "film"] + BT709 + [
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", mp4]


def x265(W, H, fps, mp4):
    return rawin(W, H, fps) + ["-c:v", "libx265", "-preset", "medium", "-crf", str(WEB_CRF), "-tag:v", "hvc1"] + BT709 + [
        "-x265-params", "log-level=error:colorprim=bt709:transfer=bt709:colormatrix=bt709", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", "-f", "mp4", mp4]


def png(path):
    from PIL import Image
    if not os.path.exists(path):
        raise SystemExit("encode: missing %s" % path)
    return np.asarray(Image.open(path).convert("RGB"))


def encode(lab, frames, pip, mp4, shots, t0=None, seconds=None, cards=True, full=False, workers=8):
    """returns info; info["mp4"] is the web copy, info["master"] the --full one"""
    run = json.load(open(os.path.join(lab, "report.json"), encoding="utf-8"))
    meta = json.load(open(os.path.join(lab, "scene.json"), encoding="utf-8"))
    doc = json.load(open(shots, encoding="utf-8"))
    fps, dt = 30, float(run.get("timestep") or 0.002)
    steps = max((p["step_end"] for p in run.get("phases") or []), default=None)
    total = int(math.floor(steps * dt * fps + 1e-9)) if steps else None
    have = sorted(int(f[1:6]) for f in os.listdir(frames) if f.startswith("f") and f.endswith(".png"))
    if not have:
        raise SystemExit("encode: no frames in %s" % frames)
    lo = int(round(t0 * fps)) if t0 is not None else have[0]
    hi = lo + int(round(seconds * fps)) - 1 if seconds else have[-1]
    H, W = png(os.path.join(frames, "f%05d.png" % lo)).shape[:2]
    whole = lo == 0 and (total is None or hi >= total - 1)
    lab_doc = meta.get("lab") if (meta.get("lab") or {}).get("schema") == "rps/lab@2" else None
    edit = VE.Edit(doc, run, lab_doc, W, H, fps, look=True, cards=cards and whole)
    pool = VE.Pool((doc, run, lab_doc, W, H, fps), dict(look=True, cards=cards and whole), workers)
    web = os.path.splitext(mp4)[0] + "_web.mp4"
    jobs = [(x265, web)] + ([(x264, mp4)] if full else [])
    outs = [o for _, o in jobs]
    tmps = [o + ".part" for o in outs]
    encs = [subprocess.Popen(cmd(W, H, fps, tmp), stdin=subprocess.PIPE, stderr=subprocess.PIPE)
            for (cmd, _), tmp in zip(jobs, tmps)]

    def out(chunks):
        for b in chunks:
            for e in encs:
                e.stdin.write(b)
    t, ok = time.time(), False
    try:
        for j in range(edit.n_title):
            out(pool.put("card", "title", j))
        for i in range(lo, hi + 1):
            ti = round(i / (fps * dt)) * dt
            on = edit.pip_at(ti)
            px = (on[0], png(os.path.join(pip or "", on[0], "f%05d.png" % i))) if on else None
            out(pool.put("frame", png(os.path.join(frames, "f%05d.png" % i)), ti, i, px))
        for j in range(edit.n_end):
            out(pool.put("card", "end", j))
        out(pool.drain())
        ok = True
    except BrokenPipeError:
        pass                                            # ffmpeg died: its stderr is reported below
    finally:
        errs = []
        for e in encs:
            try:
                e.stdin.close()
            except BrokenPipeError:
                pass
            errs.append(e.stderr.read().decode(errors="replace").strip())
            e.wait()
        if not ok or any(e.returncode for e in encs):
            for tmp in tmps:
                if os.path.exists(tmp):
                    os.remove(tmp)
    if any(e.returncode for e in encs) or not ok:
        raise SystemExit("encode: ffmpeg failed: %s" % " | ".join(x for x in errs if x) or "encode: ffmpeg failed")
    for tmp, o in zip(tmps, outs):
        os.replace(tmp, o)
    n = edit.n_title + hi - lo + 1 + edit.n_end
    info = dict(mp4=web, frames=[lo, hi], out_frames=n, seconds=round(n / fps, 2), cards=whole and cards,
                bytes=os.path.getsize(web), wall_s=round(time.time() - t, 1))
    if full:
        info.update(master=mp4, master_bytes=os.path.getsize(mp4))
    for o in outs:
        print("encode: %s, %d frames (%.1f s), %.1f MB, %.1f s" % (o, n, n / fps, os.path.getsize(o) / 1e6, info["wall_s"]))
    return info


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--lab", required=True)
    ap.add_argument("--frames", required=True)
    ap.add_argument("--pip")
    ap.add_argument("--mp4", required=True)
    ap.add_argument("--shots", default=os.path.join(HERE, "shots.json"))
    ap.add_argument("--t0", type=float)
    ap.add_argument("--seconds", type=float)
    ap.add_argument("--no-cards", action="store_true")
    ap.add_argument("--full", action="store_true", help="also the H.264 master at --mp4")
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args(argv)
    info = encode(a.lab, a.frames, a.pip, os.path.abspath(a.mp4), a.shots, a.t0, a.seconds, not a.no_cards, a.full, a.workers)
    with open(os.path.splitext(a.mp4)[0] + ".json", "w") as fh:
        json.dump(info, fh, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
