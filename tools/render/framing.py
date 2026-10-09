#!/usr/bin/env python3
"""Framing checks on a shots capture (capture.py --campath): per shot, the puck's clearance from the frame
edge, the peak pan rate, the robot's height in frame, how much of each shots.json `keep_out` segment
(the e-stop post, as a fraction of the frame area) is seen clearly nearer than the robot, and the eye's
least clearance inside the closed room (looks.json `room`; negative = outside) and the least depth of the
room along the view axis to a wall or the ceiling (a shot staring at a wall close up). Pure numpy.

    framing.py <capture dir> --run report.json [--shots shots.json]      one JSON row per shot
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "blender"))
sys.path.insert(0, os.path.join(HERE, "film"))
import campath  # noqa: E402
import pose  # noqa: E402
from videoshots import Times  # noqa: E402

PAD = 0.02                          # m around geom centres (their extents are not in the rows)
FG = 0.85                           # nearer than this x the robot's depth: foreground
LOOKS = os.path.join(HERE, "looks.json")


def room_box(path=LOOKS):
    """the closed room's inner box (m): (lo xyz, hi xyz)"""
    R = json.load(open(path, encoding="utf-8")).get("room") or {}
    (x0, x1), (y0, y1) = R.get("x", (-2100, 2300)), R.get("y", (-1500, 1950))
    return np.array([x0, y0, 0.0]) / 1e3, np.array([x1, y1, R.get("ceiling_mm", 2700)]) / 1e3


def project(row, P, aspect):
    """[N,3] world -> [N,3] (x, y in -1..1 across the frame, depth m)"""
    eye, r, u, f = campath.basis(row)
    V = np.asarray(P, float) - eye
    z = V @ f
    ty = math.tan(math.radians(row[6]) / 2)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.stack([(V @ r) / (z * ty * aspect), (V @ u) / (z * ty), z], 1)


def box(P, pad=PAD):
    lo, hi = P.min(0) - pad, P.max(0) + pad
    return np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])


def extent(rows, types):
    """points on each geom's bounds: rings on a cylinder's end caps, the corners of anything else"""
    ring = np.array([[math.cos(a), math.sin(a)] for a in np.linspace(0, 2 * math.pi, 8, endpoint=False)])
    out = []
    for r, t in zip(rows, types):
        R, s = pose.quat_mat(r[3:7]), r[9:12]
        if t == "cylinder":
            L = [[s[0] * c, s[0] * d, z] for c, d in ring for z in (-s[1], s[1])]
        else:
            h = s if t in ("box", "ellipsoid") else (np.full(3, s[0]) if t == "sphere" else np.full(3, PAD))
            L = [[x, y, z] for x in (-h[0], h[0]) for y in (-h[1], h[1]) for z in (-h[2], h[2])]
        out.append(np.asarray(L) @ R.T + r[0:3])
    return np.concatenate(out)


def analyse(cap_dir, shots_path, run=None):
    cap = json.load(open(os.path.join(cap_dir, "capture.json")))
    Z = dict(np.load(os.path.join(cap_dir, "capture.npz")))
    doc = json.load(open(shots_path, encoding="utf-8"))
    sub, f0, fps = cap["sub"], cap["frame0"], cap["fps"]
    aspect = float(cap["camera"].get("aspect", 16 / 9))
    mov = {g: k for k, g in enumerate(Z["moving"])}
    robot = [g["i"] for g in cap["geoms"] if g.get("body") not in ("decor", "world", "puck_1", None)]
    puck = [g["i"] for g in cap["geoms"] if g.get("body") == "puck_1"]
    T = Times(run or {})
    starts = [T(s["from"]) for s in doc["shots"]]
    keep = [(k["id"], np.array([k["p"], k["to"]], float), float(k.get("r", 0.05))) for k in doc.get("keep_out", [])]

    types = {g["i"]: g["type"] for g in cap["geoms"]}
    lo, hi = room_box()

    def pos(ids, j):
        return np.array([Z["track"][j, mov[i], 0:3] if i in mov else Z["first"][i][0:3] for i in ids])

    def rows(ids, j):
        return np.array([Z["track"][j, mov[i]] if i in mov else Z["first"][i] for i in ids], float)
    prev = None
    out = {s["id"]: dict(shot=s["id"], frames=0, puck_margin=None, robot_h=[], keep_out={}) for s in doc["shots"]}
    for n in range(cap["frames"]):
        j = n * sub
        t = float(Z["t"][j]) if "t" in Z else (f0 + n) / fps     # the sim-step time capture cut on
        k = max(0, sum(1 for a in starts if a <= t + 1e-9) - 1)
        o = out[doc["shots"][k]["id"]]
        o["frames"] += 1
        row = Z["camera"][j]
        fw = campath.forward(row[3], row[4])
        eye = np.asarray(campath.basis(row)[0], float)
        o["eye_clear_m"] = round(min(o.get("eye_clear_m", 9.0), float(min((eye - lo).min(), (hi - eye).min()))), 3)
        with np.errstate(divide="ignore"):
            exit_t = np.where(fw > 0, (hi - eye) / fw, np.where(fw < 0, (lo - eye) / fw, np.inf))
        exit_t = exit_t[:2].min() if fw[2] < 0 else exit_t.min()           # walls and ceiling, not the floor
        o["view_depth_m"] = round(min(o.get("view_depth_m", 99.0), float(exit_t)), 3)
        if prev is not None and prev[0] == k:
            ang = math.degrees(math.acos(min(1.0, float(fw @ prev[1])))) * fps
            o["pan_deg_s"] = round(max(o.get("pan_deg_s", 0.0), ang), 2)
        prev = (k, fw)
        rb = project(row, box(pos(robot, j)), aspect)
        if (rb[:, 2] > 0).all():
            o["robot_h"].append(float(np.ptp(np.clip(rb[:, 1], -1, 1)) / 2))
        depth = float(np.median(rb[:, 2]))
        pk = project(row, extent(rows(puck, j), [types[i] for i in puck]), aspect)
        if (pk[:, 2] > 0).all() and (np.abs(pk[:, :2]) < 1.5).all():
            m = float(1 - np.abs(pk[:, :2]).max())
            o["puck_margin"] = m if o["puck_margin"] is None else min(o["puck_margin"], m)
        tx = math.tan(math.radians(row[6]) / 2) * aspect
        for name, seg, rad in keep:
            q = project(row, np.linspace(seg[0], seg[1], 49), aspect)
            vis = (q[:, 2] > 0) & (np.abs(q[:, 0]) < 1) & (np.abs(q[:, 1]) < 1) & (q[:, 2] < FG * depth)
            w = 2 * rad / (np.maximum(q[:, 2], 1e-3) * tx)             # NDC width of the post
            dy = np.abs(np.gradient(q[:, 1]))
            fg = float(np.sum((dy * np.minimum(w, 2))[vis]) / 4)       # fraction of the frame area
            o["keep_out"][name] = max(o["keep_out"].get(name, 0.0), round(fg, 4))
    for o in out.values():
        h = o.pop("robot_h")
        o["robot_h"] = round(float(np.mean(h)), 3) if h else None
        o["puck_margin"] = None if o["puck_margin"] is None else round(o["puck_margin"], 3)
    return list(out.values())


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("capture")
    ap.add_argument("--shots", default=os.path.join(HERE, "shots.json"))
    ap.add_argument("--run", required=True, help="the run report.json (time refs)")
    a = ap.parse_args(argv)
    run = json.load(open(a.run)) if a.run else None
    for row in analyse(a.capture, a.shots, run):
        print(json.dumps(row))
    return 0


if __name__ == "__main__":
    sys.exit(main())
