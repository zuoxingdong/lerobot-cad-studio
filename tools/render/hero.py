#!/usr/bin/env python3
"""The hero video: a shots capture -> .blend -> Cycles frames (resumable, in chunks under the Blender lock)
-> the robot-camera inset passes -> encode.py: out/hero_web.mp4, plus the out/hero.mp4 master with --full.

    hero.py [--lab DIR] [--dst DIR] [--t0 s] [--seconds s] [--size 1920x1080] [--samples 128]
            [--pip-samples 32] [--chunk 60] [--full] [--plan] [--fresh | --pip-only]

--lab is an export dir with its lab run (npm run render makes out/work/render/hero/lab). The
capture and the .blend rerun when the digest of their inputs changes, but never under rendered frames:
those keep the old .blend (with a warning) until --fresh rebuilds and re-renders them. Truncated
frames are re-rendered. --pip-only rebuilds a stale .blend from the same capture and re-renders only the
inset passes, keeping the main frames (a change that only the robot cameras must show). --plan prints the
frame counts and the time estimate from the last frames' log without rendering.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, "film")]
sys.path.append(os.path.dirname(HERE))              # tools/: paths.py
import capture as CAP  # noqa: E402
import encode as ENC  # noqa: E402
import jobs as JOBS  # noqa: E402
import paths  # noqa: E402
import videoedit as VE  # noqa: E402
import videopose as VP  # noqa: E402

SHOTS = os.path.join(HERE, "shots.json")
FILM = os.path.join(HERE, "film")


Stamps = JOBS.Stamps
_HELD = []


def blender(script, args, blend, log, timeout=None):
    JOBS.blender(script, args, blend, log, timeout, who="hero")


def spans(frames):
    """sorted ints -> [(a, b)] inclusive runs"""
    out = []
    for f in frames:
        if out and f == out[-1][1] + 1:
            out[-1][1] = f
        else:
            out.append([f, f])
    return [tuple(s) for s in out]


def per_frame(logs):
    """mean seconds per frame (first frame of each job left out) from render.py logs"""
    s = [v for p in logs if os.path.exists(p) for _, v in json.load(open(p))["per_frame_s"][1:]]
    return sum(s) / len(s) if s else None


def pngs(d):
    return glob.glob(os.path.join(d, "f*.png")) + glob.glob(os.path.join(d, "*", "f*.png"))


def capture_inputs(lab):
    """the files a shots capture of the run in lab is made from"""
    return [os.path.join(lab, "ctrl.f32"), CAP.__file__] + glob.glob(os.path.join(FILM, "video*.py"))


def capture_key(lab, t0, seconds):
    """the capture's stamp: its inputs, the run and the camera path (the export's wall times left out)"""
    run = json.load(open(os.path.join(lab, "report.json")))
    if run.get("phases"):                             # each phase's IK wall time too
        run["phases"] = [dict(p, ik={k: v for k, v in p["ik"].items() if k != "ms"}) if isinstance(p.get("ik"), dict) else p
                         for p in run["phases"]]
    meta = json.load(open(os.path.join(lab, "scene.json")))
    path = {k: v for k, v in json.load(open(SHOTS)).items() if k not in ("pip", "captions", "cards", "edit")}
    same = json.dumps([{k: v for k, v in run.items() if k != "timing"}, {k: v for k, v in meta.items() if k != "timing_ms"}],
                      sort_keys=True)
    return JOBS.digest(capture_inputs(lab), "%s %s %s" % (t0, seconds, same + json.dumps(path, sort_keys=True)))


def prepare(lab, dst, t0, seconds, log, plan=False, fresh=False, pip_only=False):
    """the shots capture and its .blend under dst, rebuilt when their inputs change. Frames already
    rendered under dst keep the old capture and .blend (with a warning) unless fresh, which rebuilds
    and removes them. Returns run, meta, cap, blend and the frame range."""
    cap, blend = os.path.join(dst, "capture"), os.path.join(dst, "lab.blend")
    frames, pipdir = os.path.join(dst, "frames"), os.path.join(dst, "pip")
    if not plan and not _HELD:
        _HELD.append(JOBS.lock(dst, "hero"))            # one writer per dst, for this process's life
    run = json.load(open(os.path.join(lab, "report.json")))
    meta = json.load(open(os.path.join(lab, "scene.json")))
    cj, st = os.path.join(cap, "capture.json"), JOBS.Stamps(dst)
    ckey = capture_key(lab, t0, seconds)
    main_n, pip_n = len(pngs(frames)), len(pngs(pipdir))
    cstale = st.stale("capture", ckey) or not os.path.exists(cj)
    bstale = cstale or st.stale("build", JOBS.digest(JOBS.build_inputs(cap))) or not os.path.exists(blend)
    if pip_only and cstale:
        raise SystemExit("hero: --pip-only: the capture inputs changed, so new insets would not match the kept frames")
    if pip_only and bstale:
        print("hero: --pip-only: keeping %d frames, rebuilding the .blend and its %d inset frames" % (main_n, pip_n))
        if not plan:
            blender("build", ["--cap", cap, "--out", blend], None, log, timeout=3600)
            shutil.rmtree(pipdir, ignore_errors=True)
            st.done("build", JOBS.digest(JOBS.build_inputs(cap)))
    elif bstale and (main_n or pip_n) and not fresh:
        if not (os.path.exists(blend) and os.path.exists(cj)):
            raise SystemExit("hero: %s has %d frames but no .blend; --fresh rebuilds and re-renders them" % (dst, main_n + pip_n))
        print("hero: WARNING: the %s inputs changed since %d frames and %d inset frames were rendered; keeping them "
              "and the old .blend. --fresh rebuilds and re-renders them." % ("capture" if cstale else "build", main_n, pip_n))
    elif bstale and not plan:
        if cstale:
            t = time.time()
            doc, arrays, meshes = CAP.capture(lab, os.path.join(lab, "ctrl.f32"), 30, 4, t0 or 0.0, seconds, 16 / 9, SHOTS)
            CAP.write(cap, doc, arrays, meshes)
            st.done("capture", ckey)
            log.append(dict(job="capture", wall_s=round(time.time() - t, 1)))
        blender("build", ["--cap", cap, "--out", blend], None, log, timeout=3600)
        if main_n or pip_n:
            print("hero: --fresh: removing %d frames and %d inset frames of the old build" % (main_n, pip_n))
        for d in (frames, pipdir):
            shutil.rmtree(d, ignore_errors=True)
        st.done("build", JOBS.digest(JOBS.build_inputs(cap)))
    if not os.path.exists(cj):
        raise SystemExit("hero: no capture in %s yet" % cap)
    c = json.load(open(cj))
    return dict(run=run, meta=meta, cap=cap, blend=blend, lo=c["frame0"], hi=c["frame0"] + c["frames"] - 1)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--lab", default=os.path.join(JOBS.RENDER, "hero", "lab"))
    ap.add_argument("--dst", default=os.path.join(JOBS.RENDER, "hero"))
    ap.add_argument("--t0", type=float)
    ap.add_argument("--seconds", type=float)
    ap.add_argument("--size", default="1920x1080")
    ap.add_argument("--samples", type=int, default=128)
    ap.add_argument("--pip-samples", type=int, default=32)
    ap.add_argument("--chunk", type=int, default=60, help="frames per Blender job (the lock is released between)")
    ap.add_argument("--full", action="store_true", help="also the H.264 CRF 16 master (hero.mp4)")
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--fresh", action="store_true", help="rebuild a stale .blend and re-render its frames")
    ap.add_argument("--pip-only", action="store_true", help="rebuild a stale .blend, re-render only the insets")
    a = ap.parse_args(argv)
    if a.fresh and a.pip_only:
        ap.error("--fresh and --pip-only exclude each other")
    lab, dst = os.path.abspath(a.lab), os.path.abspath(a.dst)
    frames, pipdir = os.path.join(dst, "frames"), os.path.join(dst, "pip")
    log, t_all = [], time.time()
    P = prepare(lab, dst, a.t0, a.seconds, log, plan=a.plan, fresh=a.fresh, pip_only=a.pip_only)
    run, meta, blend, lo, hi = P["run"], P["meta"], P["blend"], P["lo"], P["hi"]
    edit = VE.Edit(json.load(open(SHOTS)), run, VP.lab_doc(meta), 1920, 1080, 30)
    dt = float(run.get("timestep") or 0.002)
    pip = {}
    for f in range(lo, hi + 1):
        on = edit.pip_at(round(f / (30 * dt)) * dt)
        if on:
            pip.setdefault(on[0], []).append(f)
    todo = [f for f in range(lo, hi + 1) if not JOBS.png_ok(os.path.join(frames, "f%05d.png" % f))]
    if a.pip_only and todo:
        raise SystemExit("hero: --pip-only: %d main frames are missing (first f%05d)" % (len(todo), todo[0]))
    ptodo = {k: [f for f in v if not JOBS.png_ok(os.path.join(pipdir, k, "f%05d.png" % f))] for k, v in pip.items()}
    spf = per_frame(glob.glob(os.path.join(frames, "main*.json")))
    pspf = per_frame(glob.glob(os.path.join(pipdir, "*", "pip*.json")))
    npip = sum(len(v) for v in ptodo.values())
    est = (len(todo) * (spf or 4.7) + npip * (pspf or 0.4)) / 3600
    print("hero: frames %d..%d, %d to render (%.2f s/frame), %d inset frames (%.2f s/frame): ~%.2f h" % (
        lo, hi, len(todo), spf or 4.7, npip, pspf or 0.4, est))
    if a.plan:
        return 0
    common = ["--blur", "--samples"]
    for x, y in spans(todo):
        for s in range(x, y + 1, a.chunk):
            e = min(y, s + a.chunk - 1)
            blender("render", ["--out", frames, "--frames", "%d:%d" % (s, e), "--size", a.size] + common +
                    [str(a.samples), "--tag", "main%05d" % s], blend, log, timeout=600 + 60 * (e - s + 1))
            time.sleep(2)                               # let a waiting Blender job take the lock
    for cam, fs in ptodo.items():
        for x, y in spans(fs):
            for s in range(x, y + 1, 4 * a.chunk):
                e = min(y, s + 4 * a.chunk - 1)
                blender("render", ["--out", os.path.join(pipdir, cam), "--frames", "%d:%d" % (s, e), "--size", "640x480",
                                   "--camera", "cam_" + cam, "--dof", "0"] + common +
                        [str(a.pip_samples), "--tag", "pip%05d" % s], blend, log, timeout=600 + 20 * (e - s + 1))
                time.sleep(2)
    whole = lo == 0 and a.seconds is None
    mp4 = os.path.join(dst, "hero.mp4" if whole else "section_%05d-%05d.mp4" % (lo, hi))
    info = ENC.encode(lab, frames, pipdir, mp4, SHOTS, lo / 30, (hi - lo + 1) / 30, cards=whole, full=a.full)
    log.append(dict(job="encode", wall_s=info["wall_s"]))
    info.update(jobs=log, wall_s=round(time.time() - t_all, 1), s_per_frame=per_frame(glob.glob(os.path.join(frames, "main*.json"))),
                pip_s_per_frame=per_frame(glob.glob(os.path.join(pipdir, "*", "pip*.json"))))
    stem = os.path.splitext(mp4)[0]
    if whole:                                           # the film: out/hero_web.mp4 (+ hero.mp4)
        info["mp4"] = paths.publish(info["mp4"], "hero_web.mp4")
        if a.full:
            info["master"] = paths.publish(mp4, "hero.mp4")
    with open(stem + ".json", "w") as fh:
        json.dump(info, fh, indent=1)
    print("hero: %s in %.1f min" % (info["mp4"], info["wall_s"] / 60))
    return 0


if __name__ == "__main__":
    sys.exit(main())
