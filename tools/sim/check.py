#!/usr/bin/env python3
"""Check a JS-exported MuJoCo scene in native MuJoCo; writes report.md, non-zero on any failure.

    check.py <out dir | MJCF zip> [--no-lab]

The report goes to <out dir>/report.md, or <zip name>-report.md beside a zip; its path is printed. The
report of out/work/sim/lab (npm run sim:check) is also copied to out/sim-report.md.

1. compile scene.xml (mujoco==3.14.0, the WASM build's version)
2. verify.py: FK vs armfk.py, joint limits, jaw gap, fingertip covers, camera mounts, mass band, self-collision
   sweep over jaw travel and presets, the pinned loop closures re-proved live
3. replay ctrl.f32 (the WASM lab run) open-loop (labreplay.py): same grasp/carry/insertion
   outcome, the instrument events re-derived natively, lid interlock, nav clearance, scenery
   contacts, the puck's final pose within 1 mm of the WASM run
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import time
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import labreplay  # noqa: E402
import paths  # noqa: E402
import verify as V  # noqa: E402


class Report:
    def __init__(self):
        self.rows, self.bad = [], 0

    def add(self, check, detail, ok, value=""):
        self.rows.append((check, detail, bool(ok), value))
        self.bad += 0 if ok else 1
        return ok

    def show(self):
        w = max(len(r[0]) for r in self.rows)
        for c, det, ok, val in self.rows:
            print("  %-4s %-*s  %-66s %s" % ("ok" if ok else "FAIL", w, c, det, val))
        print("\n%d checks, %d failed" % (len(self.rows), self.bad))

    def markdown(self, head):
        out = head + ["", "| | check | detail | value |", "|---|---|---|---|"]
        out += ["| %s | %s | %s | %s |" % ("ok" if ok else "**FAIL**", c, det.strip(), val) for c, det, ok, val in self.rows]
        return "\n".join(out + ["", "%d checks, %d failed" % (len(self.rows), self.bad), ""])


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("out", help="an export dir (tools/sim/export.mjs) or the MJCF zip the studio exports")
    ap.add_argument("--no-lab", action="store_true", help="skip the lab replay (no report.json / ctrl.f32)")
    a = ap.parse_args(argv)
    src = os.path.abspath(a.out)
    tmp = None
    try:
        if zipfile.is_zipfile(src):
            tmp = tempfile.mkdtemp(prefix="rps-check-")
            zipfile.ZipFile(src).extractall(tmp)
            xmls = sorted(os.path.join(r, "scene.xml") for r, _, fs in os.walk(tmp) if "scene.xml" in fs)
            if not xmls:
                print("check: %s has no scene.xml: pass the studio's MJCF zip (Export > MJCF) or an export dir" % a.out,
                      file=sys.stderr)
                return 2
            out, report = os.path.dirname(xmls[0]), os.path.splitext(src)[0] + "-report.md"
        else:
            out, report = src, os.path.join(src, "report.md")
            if not os.path.isfile(os.path.join(out, "scene.xml")):
                print("check: no scene.xml in %s: pass an export dir or the studio's MJCF zip" % a.out, file=sys.stderr)
                return 2
        return run(out, report, a.out, a.no_lab)
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


def run(out, report, name, no_lab):
    import mujoco

    with open(os.path.join(out, "scene.json"), encoding="utf-8") as fh:
        meta = json.load(fh)
    xml = os.path.join(out, "scene.xml")
    rep = Report()
    t0 = time.time()
    try:
        m = mujoco.MjModel.from_xml_path(xml)
    except Exception as e:                                   # noqa: BLE001
        rep.add("compile", "native mujoco %s loads scene.xml" % mujoco.__version__, False, str(e)[:120])
        rep.show()
        return 1
    ms = (time.time() - t0) * 1000.0
    rep.add("compile", "native mujoco %s loads scene.xml (WASM build 3.14.0)" % mujoco.__version__,
            mujoco.__version__ == "3.14.0", "%.0f ms, nbody %d nq %d nu %d" % (ms, m.nbody, m.nq, m.nu))
    rep.add("compile", "counts match the WASM compile (scene.json model)",
            all(getattr(m, k) == meta["model"][k] for k in ("nbody", "nq", "nv", "nu", "ngeom", "nmesh")),
            "ngeom %d nmesh %d" % (m.ngeom, m.nmesh))
    d = mujoco.MjData(m)
    top, base = V.package(meta)
    V.check_fk(rep, mujoco, m, d, meta, base)
    V.check_limits(rep, m, meta, top, base)
    V.check_jaw(rep, mujoco, m, d, meta)
    V.check_pads(rep, mujoco, m, d, meta)
    V.check_cameras(rep, mujoco, m, d, meta, top, base)
    V.check_mass(rep, mujoco, m, meta, xml)
    V.check_contacts(rep, mujoco, m, d, meta, xml)
    lab = None
    if not no_lab:
        if os.path.exists(os.path.join(out, "ctrl.f32")):
            lab = labreplay.replay(rep, mujoco, m, meta, out)
        else:
            rep.add("lab", "ctrl.f32 from tools/sim/run-lab.mjs", False, "missing (run it, or pass --no-lab)")
    rep.show()
    head = ["# check: %s" % os.path.basename(os.path.normpath(name)), "",
            "robot `%s`, design hash `%s`, native mujoco %s" % (meta["robot"], meta.get("design_hash"), mujoco.__version__),
            "slots: " + ", ".join("%s=%s" % kv for kv in sorted(meta["slots"].items())),
            "model: nbody %d, nq %d, nv %d, nu %d, ngeom %d, nmesh %d, nexclude %d, robot %.3f kg" % (
                m.nbody, m.nq, m.nv, m.nu, m.ngeom, m.nmesh, m.nexclude, meta["robot_mass_kg"])]
    if meta.get("timing_ms"):
        head.append("export timing (node, WASM): " + ", ".join("%s %s ms" % kv for kv in meta["timing_ms"].items()))
    if lab:
        o = lab["outcome"]
        head.append("lab (WASM): %d/%d transfers, puck path %s, %d steps, %.1f s sim, %s ms wall; native replay %.2f s" % (
            o["transfers"], o["transfers_planned"], "->".join(o["puck_path"]), o["steps"], o["sim_seconds"],
            lab["wasm"].get("task_wall_ms"), lab["wall_s"]))
    with open(report, "w", encoding="utf-8") as fh:
        fh.write(rep.markdown(head))
    print("report: %s" % report)
    if os.path.realpath(out) == os.path.realpath(os.path.join(paths.SIM, "lab")):
        print("report: %s" % paths.publish(report, "sim-report.md", keep=True))
    return 1 if rep.bad else 0


if __name__ == "__main__":
    sys.exit(main())
