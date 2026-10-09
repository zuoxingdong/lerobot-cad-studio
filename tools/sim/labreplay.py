"""Native replay of a WASM lab run (ctrl.f32 + report.json) for check.py.

The instrument machine of src/features/sim-instruments.js and the watches of sim-lab-watch.js are
mirrored here with the same float formulas, so every row is re-derived natively, not copied.
"""

from __future__ import annotations

import json
import math
import os
import time

import numpy as np

TOL_PROP_MM = 1.0
TOL_EVENT_S = 0.01
TOL_OFFSET_MM = 1.0
INTERLOCK_MM = 150.0
USABLE_NM = 2.0
SIM_S = (45.0, 75.0)
RADIAL_TOL, FLOOR_TOL, TILT_OK, LEAVE_MM, HELD_REL, ARM_DWELL = 0.5, 2.5, 5.0, 10.0, 12.0, 0.1
DOCK_TOWER = {"x": [-60, 60], "y": [-310, -250]}
LID_MOVING = ("closing", "running", "opening")


def nest_offset(st, bottom):
    """The offset along the square collar's sides (station frame), mm."""
    dx, dy, a = bottom[0] - st["nest"]["xy"][0], bottom[1] - st["nest"]["xy"][1], st["yaw"] * math.pi / 180
    return max(abs(dx * math.cos(a) + dy * math.sin(a)), abs(-dx * math.sin(a) + dy * math.cos(a)))


def seated_in(st, bottom, tilt, d):
    n = st["nest"]
    return nest_offset(st, bottom) <= (n["inner"] - d) / 2 + RADIAL_TOL and bottom[2] <= n["floor_z"] + FLOOR_TOL and tilt < TILT_OK


def left(st, bottom):
    n = st["nest"]
    return bottom[2] > n["floor_z"] + LEAVE_MM or math.hypot(bottom[0] - n["xy"][0], bottom[1] - n["xy"][1]) > LEAVE_MM


class Instruments:
    """The section 3.4 machine: one transition per station per step."""

    def __init__(self, lab):
        self.d = lab["props"][0]["d"]
        self.st = [dict(s=s, state=s.get("start") or "idle", t0=0.0, clear=None, arm=None) for s in lab["stations"]]
        self.events = []

    def go(self, x, state, now, k):
        x.update(state=state, t0=now, clear=None, arm=None)
        self.events.append(dict(station=x["s"]["id"], state=state, t=round(now, 3), step=k))

    def step(self, now, k, bottom, tilt, pads, held, grasp):
        for x in self.st:
            S, cy = x["s"], x["s"].get("cycle")
            if not cy:
                if x["state"] == "done" and left(S, bottom):
                    self.go(x, "running", now, k)
                continue
            seated, dt, s = seated_in(S, bottom, tilt, self.d), now - x["t0"], x["state"]
            if s == "idle":
                if seated and not held:
                    if x["arm"] is None:
                        x["arm"] = now
                    if now - x["arm"] >= ARM_DWELL:
                        self.go(x, "armed", now, k)
                else:
                    x["arm"] = None
            elif s == "armed":
                if not seated:
                    self.go(x, "idle", now, k)
                    continue
                far = math.hypot(grasp[0] - S["nest"]["xy"][0], grasp[1] - S["nest"]["xy"][1]) >= cy["clear"]
                if pads == 0 and far:
                    if x["clear"] is None:
                        x["clear"] = now
                    if now - x["clear"] >= cy["dwell"]:
                        self.go(x, "closing", now, k)
                else:
                    x["clear"] = None
            elif s == "closing" and dt >= cy["close"]:
                self.go(x, "running", now, k)
            elif s == "running" and dt >= cy["run"]:
                self.go(x, "opening", now, k)
            elif s == "opening" and dt >= cy["open"]:
                self.go(x, "done", now, k)
            elif s == "done" and left(S, bottom):
                self.go(x, "idle", now, k)

    def states(self):
        return {x["s"]["id"]: x["state"] for x in self.st}


def rect_dist(x, y, R):
    return math.hypot(max(R["x"][0] - x, 0, x - R["x"][1]), max(R["y"][0] - y, 0, y - R["y"][1]))


def nav_clearance(lab, x, y):
    rects = [(s["id"], s["plinth_rect"]) for s in lab["stations"]] + [("dock_tower", lab.get("dock_tower") or DOCK_TOWER)]
    return min((rect_dist(x, y, R) - lab["clearance"]["r_low"], i) for i, R in rects)


class Probe:
    def __init__(self, mujoco, m, meta):
        self.lab = meta["lab"]
        P = self.lab["props"][0]
        self.puck = m.body(P["body"]).id
        self.fL, self.fR = m.body("pincopen_jaw_finger_L").id, m.body("pincopen_jaw_finger_R").id
        self.site = m.site("grasp").id
        self.cam = m.camera("wrist").id if "wrist" in [m.camera(i).name for i in range(m.ncam)] else -1
        names = [m.body(i).name for i in range(m.nbody)]
        env = set(meta["env_bodies"])
        self.env = np.array([n in env for n in names])
        self.scenery = np.array([n in env and n != "world" for n in names])
        self.finger = np.array([n.endswith("finger_L") or n.endswith("finger_R") for n in names])
        self.sideL = np.array(["finger_L" in n for n in names])
        self.sideR = np.array(["finger_R" in n for n in names])
        self.names, self.gb = names, m.geom_bodyid.copy()
        self.base = [m.joint(n).qposadr[0] for n in ("base_x", "base_y")]

    def __call__(self, d):
        n = d.ncon
        b1 = self.gb[d.contact.geom1[:n]] if n else np.zeros(0, int)
        b2 = self.gb[d.contact.geom2[:n]] if n else np.zeros(0, int)
        o = np.concatenate([b2[b1 == self.puck], b1[b2 == self.puck]])
        pads = int(self.sideL[o].any()) + int(self.sideR[o].any())
        rel = float(np.linalg.norm(d.cvel[self.puck][3:] - d.cvel[self.fL][3:])) * 1000.0
        bottom = d.xpos[self.puck] * 1000.0
        up = float(d.xmat[self.puck][8])
        tilt = math.degrees(math.acos(max(-1.0, min(1.0, up))))
        return dict(bottom=bottom, tilt=tilt, pads=pads, held=pads == 2 and rel < HELD_REL,
                    grasp=d.site_xpos[self.site] * 1000.0, b1=b1, b2=b2, dist=d.contact.dist[:n] if n else np.zeros(0))


def replay(rep, mujoco, m, meta, out):
    with open(os.path.join(out, "report.json"), encoding="utf-8") as fh:
        run = json.load(fh)
    nu = run["ctrl_log"]["cols"]
    rep.add("lab", "the WASM run is of this model", run.get("design_hash") == meta.get("design_hash") and nu == m.nu,
            "hash %s, nu %d" % (run.get("design_hash"), nu))
    o, lab = run["outcome"], meta["lab"]
    ctrl = np.fromfile(os.path.join(out, "ctrl.f32"), dtype="<f4").reshape(-1, nu)
    d = mujoco.MjData(m)
    pr, inst = Probe(mujoco, m, meta), Instruments(lab)
    stations = {s["id"]: s for s in lab["stations"]}
    arm_act = [i for i in range(m.nu) if not m.actuator(i).name.startswith("drive_")]
    at = {}
    for p in run["phases"]:
        if p.get("grasp") or p.get("carry_held") is not None or p.get("insertion"):
            at.setdefault(p["step_end"], []).append(p)
    mujoco.mj_resetData(m, d)
    mujoco.mj_forward(m, d)
    peak = np.zeros(m.nu)
    nav, lock, scenery, path, seated_at = (1e9, None), (1e9, None), {}, [], None
    t0 = time.time()
    for k, row in enumerate(ctrl):
        d.ctrl[:] = row
        mujoco.mj_step(m, d)
        np.maximum(peak, np.abs(d.actuator_force), out=peak)
        s = pr(d)
        inst.step(d.time, k + 1, s["bottom"], s["tilt"], s["pads"], s["held"], s["grasp"])
        nav = min(nav, nav_clearance(lab, d.qpos[pr.base[0]] * 1000.0, d.qpos[pr.base[1]] * 1000.0))
        e1, e2 = pr.scenery[s["b1"]], pr.scenery[s["b2"]]
        for i in np.nonzero(e1 ^ e2)[0]:
            rb, eb = (s["b2"][i], s["b1"][i]) if e1[i] else (s["b1"][i], s["b2"][i])
            if pr.env[rb] or (eb == pr.puck and pr.finger[rb]):
                continue
            key = "%s|%s" % (pr.names[rb], pr.names[eb])
            scenery[key] = max(scenery.get(key, 0.0), -float(s["dist"][i]) * 1000.0)
        for sid, state in inst.states().items():
            if state in LID_MOVING and stations[sid].get("cycle"):
                nx, ny = stations[sid]["nest"]["xy"]
                v = math.hypot(s["grasp"][0] - nx, s["grasp"][1] - ny)
                if pr.cam >= 0:
                    v = min(v, math.hypot(d.cam_xpos[pr.cam][0] * 1000.0 - nx, d.cam_xpos[pr.cam][1] * 1000.0 - ny))
                lock = min(lock, (v, sid))
        here = next((i for i, S in stations.items() if seated_in(S, s["bottom"], s["tilt"], lab["props"][0]["d"])), None)
        if here != seated_at:
            seated_at = here
            if here and (not path or path[-1] != here):
                path.append(here)
        for p in at.get(k + 1, ()):
            mujoco.mj_forward(m, d)
            verdict(rep, pr(d), p, stations, lab)
    wall = time.time() - t0
    mujoco.mj_forward(m, d)
    rows(rep, run, lab, inst, d, pr, peak, arm_act, m, nav, lock, scenery, path, seated_at)
    return dict(steps=len(ctrl), wall_s=round(wall, 2), wasm=run["timing"], outcome=o)


def verdict(rep, s, p, stations, lab):
    if p.get("insertion"):
        S, js = stations[p["station"]], p["insertion"]
        n = S["nest"]
        radial = math.hypot(s["bottom"][0] - n["xy"][0], s["bottom"][1] - n["xy"][1])
        ok = seated_in(S, s["bottom"], s["tilt"], lab["props"][0]["d"])
        rep.add("lab", "%-15s success native vs WASM, offset within %.0f mm" % (p["phase"], TOL_OFFSET_MM),
                ok == js["success"] and abs(radial - js["offset_mm"]) <= TOL_OFFSET_MM,
                "%s / %s (%.2f / %.2f mm off, %.2f deg)" % (ok, js["success"], radial, js["offset_mm"], s["tilt"]))
    else:
        js = p["grasp"]["verified"] if p.get("grasp") else p["carry_held"]
        rep.add("lab", "%-15s held native vs WASM" % p["phase"], s["held"] == js, "%s / %s" % (s["held"], js))


def rows(rep, run, lab, inst, d, pr, peak, arm_act, m, nav, lock, scenery, path, seated_at):
    o, nav_min = run["outcome"], lab["clearance"]["min"]
    js = o.get("instrument_events", [])
    same = [(e["station"], e["state"]) for e in inst.events] == [(e["station"], e["state"]) for e in js]
    dt, at = max(((abs(a["t"] - b["t"]), "%s:%s" % (a["station"], a["state"])) for a, b in zip(inst.events, js)),
                 default=(0.0, "-"))
    rep.add("lab", "instrument events: native mirror = WASM log, each within %.2f s" % TOL_EVENT_S,
            same and dt <= TOL_EVENT_S and len(js) > 0, "%d events, worst %.3f s (%s)" % (len(inst.events), dt, at))
    rep.add("lab", "lid interlock: grasp site and wrist camera %.0f mm from a moving lid's nest" % INTERLOCK_MM,
            lock[0] >= INTERLOCK_MM, "%.1f mm (%s)" % lock if lock[1] else "no lid moved")
    rep.add("lab", "nav clearance: r_low circle to plinths and tower >= %.0f mm" % nav_min,
            nav[0] >= nav_min, "%.1f mm (%s)" % nav)
    rep.add("lab", "no robot contact with the scenery (pads on the puck excepted)", not scenery,
            ", ".join("%s %.2f mm" % kv for kv in sorted(scenery.items())) or "none")
    fp = run.get("final_props") or {}
    js_pos = fp.get(pr.names[pr.puck], {}).get("xpos")
    dp = float(np.linalg.norm(d.xpos[pr.puck] - np.array(js_pos))) * 1000.0 if js_pos else float("inf")
    rep.add("lab", "puck final pose within %.0f mm of the WASM run" % TOL_PROP_MM, dp <= TOL_PROP_MM, "%.4f mm" % dp)
    pk = float(max(peak[arm_act]))
    sat = [m.actuator(i).name for i in arm_act if peak[i] >= 0.99 * m.actuator_forcerange[i][1]]
    rep.add("lab", "peak arm torque agrees (WASM %.3f N.m), <= %.1f usable, no saturation" % (o["peak_torque_max_Nm"], USABLE_NM),
            abs(pk - o["peak_torque_max_Nm"]) < 0.1 and pk <= USABLE_NM and not sat and not o.get("saturated"),
            "%.3f N.m%s" % (pk, (" saturated " + ",".join(sat)) if sat else ""))
    rep.add("lab", "sim time in %.0f .. %.0f s" % SIM_S, SIM_S[0] <= d.time <= SIM_S[1], "%.2f s" % d.time)
    done = {e["station"] for e in inst.events if e["state"] == "done"}
    ok = seated_at == "reader" and path == ["lh", "inc", "reader"] and {"inc", "reader"} <= done
    rep.add("lab", "outcome: puck seated lh -> inc -> reader, incubated and read (native)", ok,
            "path %s, ends in %s, done %s" % ("->".join(path), seated_at, ",".join(sorted(done))))

