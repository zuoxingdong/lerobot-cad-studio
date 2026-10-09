"""Authored shots (rps/campath@1): shots.json -> the camera per frame: pose, lens, focus distance, f-stop.

A shot runs from its `from` to the next shot's. Times are seconds, a phase name (its start, `.end` for
its end) or "<station>:<state>" (that instrument event), each with an optional "+s" / "-s". The eye and
the target are an anchor plus an offset in the anchor's frame, eased from `p` to `to`; `orbit_deg`
turns the eye about the target. Mounted anchors (base, body:, site:) are low-passed, reset on each cut.
When a prop hides a subject the eye rises on a spring until the rays clear. State advances only on
frame calls; a subframe call (commit=False) reads it and never changes the next frame.
"""

from __future__ import annotations

import json
import math
import re

import numpy as np

SENSOR_H_MM = 24.0              # the frame height lenses are quoted for (full frame, 36 x 24 mm)
TAU = 0.5                       # s, the low-pass of mounted anchors
LIFTS = (0.0, 0.05, 0.1, 0.16, 0.24, 0.34, 0.46)
LIFT_TAU = 0.4                  # s, the dodge spring
NO_CUT = ("descend_", "grasp_", "insert_", "release_")
LENS = (28.0, 100.0)
MAX_SLIDE = 0.25                # m/s
REF = re.compile(r"\s*([A-Za-z_]\w*(?::\w+)?)(\.end)?\s*(?:([+-])\s*([\d.]+))?\s*")


def ease(u, e):
    """a trapezoid velocity profile: accelerate over e, cruise, decelerate over the last e"""
    u, e = min(1.0, max(0.0, u)), min(0.5, max(0.0, e))
    if e == 0:
        return u
    v = 1.0 / (1.0 - e)
    if u < e:
        return 0.5 * v * u * u / e
    if u > 1 - e:
        return 1.0 - 0.5 * v * (1 - u) ** 2 / e
    return 0.5 * v * e + v * (u - e)


def smooth(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def rotz(deg):
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def fovy_deg(lens_mm, sensor_h=SENSOR_H_MM):
    return math.degrees(2 * math.atan(0.5 * sensor_h / lens_mm))


class Times:
    """time refs -> seconds, from a run report (phases, instrument events)"""

    def __init__(self, run):
        dt = float(run.get("timestep") or 0.002)
        self.phase, self.event = {}, {}
        for p in run.get("phases", []):
            self.phase.setdefault(p["phase"], (p["step_start"] * dt, p["step_end"] * dt))
        for e in (run.get("outcome") or {}).get("instrument_events") or []:
            self.event.setdefault("%s:%s" % (e["station"], e["state"]), float(e["t"]))
        self.end = max((b for _, b in self.phase.values()), default=0.0)

    def __call__(self, ref):
        if isinstance(ref, (int, float)):
            return float(ref)
        mt = REF.fullmatch(ref)
        if not mt:
            raise ValueError("shots: bad time %r" % ref)
        name, end, sign, off = mt.groups()
        if name == "end":
            t = self.end
        elif name in self.event:
            t = self.event[name]
        elif name in self.phase:
            t = self.phase[name][1 if end else 0]
        else:
            raise ValueError("shots: unknown time %r" % ref)
        return t + (float(off) * (1 if sign == "+" else -1) if off else 0.0)

    def phase_at(self, t):
        return next((n for n, (a, b) in self.phase.items() if a <= t < b), None)


class Anchors:
    """anchor name -> (world position, frame R, mounted): world, base, body:<n>, site:<n>,
    station:<id> (the plinth's front-edge centre on the floor), nest:<id> (the nest floor), park:<id>"""

    def __init__(self, m, meta):
        self.m = m
        lab = meta.get("lab") or {}
        self.T = (lab.get("T_mm") or 277.33) / 1000.0
        self.fixed = {"world": (np.zeros(3), np.eye(3))}
        for s in lab.get("stations", []):
            R = rotz(s.get("yaw") or 0)
            x, y = (np.array(s["plinth_rect"][k], float) / 1000 for k in ("x", "y"))
            c = np.array([x.mean(), y.mean(), 0.0])
            half = np.abs(R[:2, :2].T) @ np.array([np.ptp(x), np.ptp(y)]) / 2
            self.fixed["station:" + s["id"]] = (c + R @ [0.0, -half[1], 0.0], R)
            self.fixed["nest:" + s["id"]] = (np.array([*np.array(s["nest"]["xy"]) / 1000, self.T]), R)
            p = s["park"]
            self.fixed["park:" + s["id"]] = (np.array([p[0] / 1000, p[1] / 1000, 0.0]), rotz(p[2]))

    def raw(self, name, d):
        if name in self.fixed:
            p, R = self.fixed[name]
            return p, R, False
        kind, _, n = name.partition(":")
        if kind == "base":
            return d.xpos[self.m.body("base").id].copy(), np.eye(3), True
        if kind == "body":
            return d.xpos[self.m.body(n).id].copy(), np.eye(3), True
        if kind == "site":
            return d.site_xpos[self.m.site(n).id].copy(), np.eye(3), True
        raise ValueError("shots: unknown anchor %r" % name)

    def bodies(self, name):
        """the station body an anchor names (it may sit in front of its own subject)"""
        kind, _, n = name.partition(":")
        if kind in ("station", "nest", "park"):
            b = "st_" + n
            return {self.m.body(b).id} if b in [self.m.body(i).name for i in range(self.m.nbody)] else set()
        if kind == "body":
            return {self.m.body(n).id}
        return set()


class Shot:
    def __init__(self, s, t0, t1):
        self.id, self.t0, self.t1 = s["id"], t0, t1
        self.lens, self.fstop = float(s["lens_mm"]), float(s.get("fstop", 8.0))
        self.eye, self.target = s["eye"], s["target"]
        self.focus, self.rack = s.get("focus") or s["target"], s.get("rack")
        self.ease, self.orbit = float(s.get("ease", 0.35)), float(s.get("orbit_deg", 0.0))
        self.subjects = s.get("subjects") or [s["target"], {"at": "base", "p": [0, 0, 0.2]}, {"at": "site:grasp"}]
        self.ok = s.get("ok") or []


class Shots:
    """Shots(meta, path, run, m).camera(d, t) -> MjvCamera; .fovy, .optics (focus m, f-stop, lens mm), .shot"""

    def __init__(self, meta, path, run=None, m=None, aspect=16 / 9, mujoco=None):
        if mujoco is None:
            import mujoco
        self.mj, self.m, self.aspect = mujoco, m, aspect
        with open(path, encoding="utf-8") as fh:
            self.doc = json.load(fh)
        if self.doc.get("schema") != "rps/campath@1":
            raise ValueError("shots: %s is not rps/campath@1" % path)
        self.sensor, self.tau = float(self.doc.get("sensor_h_mm", SENSOR_H_MM)), float(self.doc.get("tau_s", TAU))
        self.times = Times(run or {})
        starts = [self.times(s["from"]) for s in self.doc["shots"]]
        if any(b <= a for a, b in zip(starts, starts[1:])):
            raise ValueError("shots: shot starts must increase")
        ends = starts[1:] + [max(self.times.end, starts[-1] + 1.0)]
        self.shots = [Shot(s, a, b) for s, a, b in zip(self.doc["shots"], starts, ends)]
        self.A = Anchors(m, meta)
        root = m.body_rootid[m.body("base").id]
        names = [m.body(b).name for b in range(m.nbody)]
        self.ok = {b for b in range(m.nbody) if m.body_rootid[b] == root}
        self.ok |= {names.index(p["body"]) for p in (meta.get("lab") or {}).get("props") or [] if p.get("body") in names}
        self.groups = np.array([1, 1, 1, 0, 0, 0], np.uint8)
        self.gid = np.zeros(1, np.int32)
        self.cam = mujoco.MjvCamera()
        self.cam.type = mujoco.mjtCamera.mjCAMERA_FREE
        self.cur, self.lp, self.lift, self.lift_v, self.t_last = None, {}, 0.0, 0.0, None
        for sh in self.shots:
            at = [a.get("at", "") if isinstance(a, dict) else a for a in [sh.eye, sh.target, *sh.subjects]]
            sh.okset = self.ok | set().union(*(self.A.bodies(a) for a in at)) | self._named(sh.ok)
        self.fovy, self.optics, self.shot = 45.0, (1.0, 8.0, 50.0), None
        self.blocked, self.lifted = {}, {}              # shot id -> frames with a subject hidden / the top dodge

    def index(self, t):
        return max(0, sum(1 for s in self.shots if s.t0 <= t + 1e-9) - 1)

    def lint(self):
        """authoring rules: lenses 28-100 mm, no cut inside a grasp/insert, slides <= 0.25 m/s"""
        out = []
        for s in self.shots:
            if not LENS[0] <= s.lens <= LENS[1]:
                out.append("%s: lens %g mm outside 28-100" % (s.id, s.lens))
            ph = self.times.phase_at(s.t0 + 1e-6) or ""
            if s is not self.shots[0] and ph.startswith(NO_CUT) and abs(self.times.phase[ph][0] - s.t0) > 1e-6:
                out.append("%s: cuts inside %s" % (s.id, ph))
            for part in (s.eye, s.target):
                if "to" in part:
                    v = np.linalg.norm(np.subtract(part["to"], part["p"])) / (s.t1 - s.t0) / (1 - min(0.5, s.ease))
                    if v > MAX_SLIDE + 1e-9:
                        out.append("%s: slides at %.2f m/s" % (s.id, v))
        return out

    def _anchor(self, name, d, t, commit):
        p, R, mounted = self.A.raw(name, d)
        if not mounted:
            return p, R
        prev = self.lp.get(name)
        if prev is not None:
            t0, y0 = prev
            p = y0 + (1 - math.exp(-max(0.0, t - t0) / self.tau)) * (p - y0)
        if commit:
            self.lp[name] = (t, p)
        return p, R

    def point(self, spec, d, t, u=0.0, commit=False):
        if isinstance(spec, str):
            spec = {"at": spec}
        p, R = self._anchor(spec.get("at", "world"), d, t, commit)
        a = np.asarray(spec.get("p", (0, 0, 0)), float)
        off = a + u * (np.asarray(spec["to"], float) - a) if "to" in spec else a
        return p + R @ off

    def _hidden(self, d, eye, pts, ok):
        n = 0
        for q in pts:
            v = q - eye
            L = float(np.linalg.norm(v))
            x = self.mj.mj_ray(self.m, d, eye, v / L, self.groups, 1, -1, self.gid)
            n += 0 <= x < L - 0.03 and self.m.geom_bodyid[self.gid[0]] not in ok
        return n

    def camera(self, d, t, shot_t=None, commit=True):
        """the camera at sim time t; shot_t (default t) picks the shot, so subframes hold across a cut"""
        k = self.index(t if shot_t is None else shot_t)
        sh, cut = self.shots[k], k != self.cur
        saved = self.lp
        if cut:
            self.lp = {}
            if commit:
                self.cur = k
        u = ease((t - sh.t0) / max(1e-6, sh.t1 - sh.t0), sh.ease)
        eye = self.point(sh.eye, d, t, u, commit)
        tgt = self.point(sh.target, d, t, u, commit)
        if sh.orbit:
            eye = tgt + rotz(sh.orbit * u) @ (eye - tgt)
        pts = [self.point(s, d, t, u, commit) for s in sh.subjects]
        foc = self.point(sh.focus, d, t, u, commit)
        if sh.rack:
            w = smooth((t - self.times(sh.rack["t"])) / float(sh.rack.get("s", 1.0)))
            foc = foc + w * (self.point(sh.rack["to"], d, t, u, commit) - foc)
        if cut and not commit:
            self.lp = saved
        lift = self.lift
        if commit or cut:
            need = next((h for h in LIFTS if not self._hidden(d, eye + [0, 0, h], pts, sh.okset)), None)
            if need is None and commit:
                self.blocked[sh.id] = self.blocked.get(sh.id, 0) + 1
            need = (self.lift if not cut else 0.0) if need is None else need
            lift = need if cut else self.lift
        if commit:
            if cut or self.t_last is None:
                self.lift, self.lift_v = need, 0.0
            else:                                        # critically damped toward the needed lift
                h, w = max(1e-6, t - self.t_last), 1.0 / LIFT_TAU
                self.lift_v += h * (w * w * (need - self.lift) - 2 * w * self.lift_v)
                self.lift += h * self.lift_v
            self.t_last, lift = t, self.lift
            if lift > 0.01:
                self.lifted[sh.id] = round(max(lift, self.lifted.get(sh.id, 0.0)), 3)
        eye = eye + [0.0, 0.0, lift]
        v = tgt - eye
        dist = float(np.linalg.norm(v))
        f = v / dist
        c = self.cam
        c.lookat[:] = tgt
        c.distance = dist
        c.azimuth = math.degrees(math.atan2(f[1], f[0]))
        c.elevation = math.degrees(math.asin(max(-1.0, min(1.0, f[2]))))
        self.fovy = fovy_deg(sh.lens, self.sensor)
        self.optics = (max(0.05, float((foc - eye) @ f)), sh.fstop, sh.lens)
        self.shot = sh
        return c

    def _named(self, names):
        have = [self.m.body(i).name for i in range(self.m.nbody)]
        return {have.index(n) for n in names if n in have}

    def row(self):
        """the rps/campath@1 track row of the last camera: lookat3 azimuth elevation distance fovy"""
        c = self.cam
        return [*c.lookat, c.azimuth, c.elevation, c.distance, self.fovy]
