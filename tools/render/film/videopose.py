"""The instruments in the video: their state at any time from the run's event log, the caption
half they tell, and the lid / LED / bar poses applied to an MjvScene after mjv_updateScene.

Only scene geoms are touched, never the model or the data, so the physics stays bit-identical.
The timing mirrors src/features/sim-instruments.js view().
"""

from __future__ import annotations

import math

import numpy as np

LED = {"white": (0.9, 0.95, 1.0), "amber": (1.0, 0.62, 0.1), "green": (0.2, 1.0, 0.45), "blue": (0.25, 0.55, 1.0),
       "off": (0.25, 0.27, 0.3)}
CAPS = ((0.2, 0.45, 0.95), (1.0, 0.62, 0.1), (0.2, 0.85, 0.45), (0.95, 0.45, 0.7))   # ART-1..4
LOOP = ("design", "build", "test", "learn")


def lab_doc(meta):
    """the export's rps/lab@2 workcell doc (scene.json "lab"), or None"""
    lab = meta.get("lab") or {}
    return lab if lab.get("schema") == "rps/lab@2" else None


def smooth(x):
    t = min(1.0, max(0.0, x))
    return t * t * (3 - 2 * t)


class Timeline:
    """State per station at time t, from `instrument_events` (station, state, t)."""

    def __init__(self, lab, events):
        self.st = {s["id"]: s for s in lab["stations"]} if lab else {}
        self.ev = {i: [(0.0, s.get("start") or "idle")] for i, s in self.st.items()}
        for e in events or []:
            if e["station"] in self.ev:
                self.ev[e["station"]].append((float(e["t"]), e["state"]))
        self.test_on = next((e["t"] for e in events or [] if e["station"] == "inc" and e["state"] == "closing"), None)
        self.read = next((e["t"] for e in events or [] if self.st.get(e["station"], {}).get("kind") == "reader"
                          and e["state"] == "done"), None)
        self.build_off = next((e["t"] for e in events or [] if e["station"] == "lh" and e["state"] == "running"), None)

    def at(self, t):
        out = {}
        for i, S in self.st.items():
            t0, state = max((x for x in self.ev[i] if x[0] <= t + 1e-9), key=lambda x: x[0])
            cy, dt = S.get("cycle"), t - t0
            o = dict(state=state, since=dt, closure=0.0, progress=0.0)
            if cy:
                o["closure"] = {"closing": smooth(dt / cy["close"]), "running": 1.0,
                                "opening": 1 - smooth(dt / cy["open"])}.get(state, 0.0)
                o["progress"] = min(1.0, dt / cy["run"]) if state == "running" else 1.0 if state in ("opening", "done") else 0.0
                if state == "running":
                    o["remaining"] = max(0.0, cy["run"] - dt)
            if S.get("result"):
                k = smooth(o["progress"]) if state == "running" else 1.0 if state in ("opening", "done") else 0.0
                o["bars"] = [v * k for v in S["result"]]
            out[i] = o
        learn = self.read is not None and t >= self.read
        loop = dict(design=learn and t - self.read >= 1.5, build=self.build_off is None or t < self.build_off,
                    test=self.test_on is not None and t >= self.test_on and not learn, learn=learn)
        return out, loop


def caption(st):
    """The instrument half of a caption (src/features/sim-lab-plan.js instrumentCaption)."""
    inc, rd = st.get("inc"), st.get("reader")
    if rd and rd["state"] == "done":
        return "ART-3: hit → next design round"
    if rd and rd["state"] == "running":
        return "Reading fluorescence · %.1f s" % rd["remaining"]
    if rd and rd["state"] in ("closing", "opening"):
        return "Reader hood %s" % rd["state"]
    if inc and inc["state"] == "running":
        return "Incubating 37 °C · %.1f s" % inc["remaining"]
    if inc and inc["state"] in ("closing", "opening"):
        return "Incubator lid %s" % inc["state"]
    if inc and inc["state"] == "done":
        return "Incubation done"
    return ""


def led_colour(station, o, t, a=None):
    """(rgb, level) for a station LED: the decor's colours / blink / pulse when the anim node has them."""
    s = o["state"]
    if a and a.get("colors") and s in a["colors"]:
        c, lvl = tuple(a["colors"][s][:3]), 1.0
        hz = (a.get("blink_hz") or {}).get(s)
        if hz:
            lvl = 1.0 if int(t * 2 * hz) % 2 == 0 else 0.25
        hz = (a.get("pulse_hz") or {}).get(s)
        if hz:
            lvl = 0.55 + 0.45 * math.cos(2 * math.pi * hz * o["since"])
        return c, lvl
    if station == "lh":
        return LED["blue"] if s == "running" else LED["green"], 1.0
    if s == "done":
        return LED["green"], 1.0
    if s == "armed":
        return LED["white"], 1.0 if int(t * 2) % 2 == 0 else 0.25
    if s in ("closing", "running", "opening"):
        if station == "reader":
            return LED["blue"], 1.0
        return LED["amber"], 0.55 + 0.45 * math.cos(2 * math.pi * o["since"])
    return LED["white"], 0.8


def rot(axis, ang):
    a = np.asarray(axis, float)
    a = a / np.linalg.norm(a)
    K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + math.sin(ang) * K + (1 - math.cos(ang)) * K @ K


class Poser:
    """Poses the sidecar `lab.anim` geoms in a rendered scene from a Timeline snapshot."""

    def __init__(self, mujoco, m, lab):
        self.mj, self.items, self.idx = mujoco, [], {}
        names = {m.geom(i).name: i for i in range(m.ngeom)}
        for a in (lab or {}).get("anim") or []:
            ids = [(k, names[g]) for k, g in enumerate(a.get("geoms", [])) if g in names]
            if ids:
                self.items.append((a, ids))
        self.want = {g for _, ids in self.items for _, g in ids}
        self.result = next((s["id"] for s in (lab or {}).get("stations", []) if s.get("result")), None)

    def _index(self, scn):
        key = id(scn)
        cached = self.idx.get(key)
        GEOM = self.mj.mjtObj.mjOBJ_GEOM
        if cached and all(scn.geoms[i].objid == g and scn.geoms[i].objtype == GEOM for g, i in cached.items()):
            return cached
        out = {}
        for i in range(scn.ngeom):
            g = scn.geoms[i]
            if g.objtype == GEOM and g.objid in self.want:
                out[g.objid] = i
        self.idx[key] = out
        return out

    def apply(self, scn, st, loop, t):
        if not self.items:
            return
        at = self._index(scn)
        for a, ids in self.items:
            kind = a["kind"]
            o = st.get(a.get("station") or (self.result if kind == "bars" else None), {})
            for k, gid in ids:
                if gid not in at:
                    continue
                g = scn.geoms[at[gid]]
                if kind == "hinge" and o.get("closure", 0) > 0:
                    R = rot(a["axis"], math.radians(o["closure"] * a["closed_deg"]))
                    h = np.asarray(a["hinge"], float) / 1000.0
                    g.pos[:] = h + R @ (np.asarray(g.pos) - h)
                    g.mat[:] = R @ np.asarray(g.mat).reshape(3, 3)
                elif kind == "led" and o:
                    c, lvl = led_colour(a["station"], o, t, a)
                    if "ring" in a["geoms"][k] and o["state"] == "running":
                        lvl = 0.3 + 0.7 * o["progress"]
                    g.rgba[:3] = [v * lvl for v in c]
                    g.emission = 0.9 * lvl
                elif kind == "bars" and o.get("bars") is not None:
                    h = max(0.001, o["bars"][k] * a["max_h"] / 1000.0)
                    g.size[2] = h / 2
                    g.pos[2] = a["base_z"] / 1000.0 + h / 2
                    g.rgba[:3] = CAPS[k % 4] if o["bars"][k] > 0 else LED["off"]
                    g.emission = 0.8 if (k == 2 and o["state"] == "done") else 0.3
                elif kind == "slide" and o.get("state") == "running":
                    lo, hi = a["travel"]
                    off = ((lo + hi) / 2 + (hi - lo) / 2 * math.sin(2 * math.pi * o["since"] / a["period_s"])) / 1000.0
                    g.pos[:] = np.asarray(g.pos) + off * np.asarray(a["axis"], float)
                elif kind == "loop":
                    on = loop.get(LOOP[k % 4], False)
                    cols = a.get("colors") or {}
                    g.rgba[:3] = (cols.get("on") or LED["green"])[:3] if on else (cols.get("off") or LED["off"])[:3]
                    g.emission = 0.8 if on else 0.0

