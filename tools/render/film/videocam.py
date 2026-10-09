"""The video's main camera: frames the robot and the station it works at, and keeps both in sight.

Each shot looks from the station's open side, a little off the robot-station line. Rays from the eye
to the base, the grasp site and the nest must reach them (the robot and that station may be hit,
anything else is an occluder); if one is blocked the azimuth steps aside, then the camera rises.
The distance fits the whole robot and the nest inside the frame; a prop in the foreground scores a
shot down. Azimuth, elevation, distance and
look-at follow their goals through a critically damped spring, so moves are eased; a shot whose eased
path would pass behind a prop is taken last, and the camera cuts if its own view is ever blocked.
Deterministic: the choice is re-made on a fixed frame cadence from the sim state only.
"""

from __future__ import annotations

import math
import re

import numpy as np

STATION = re.compile(r"_(lh|inc|reader)$")
NEXT = {"drive_mid": "reader"}
OFFSETS = (0, 20, -20, 40, -40, 60, -60, 80, -80)
ELEVATIONS = (-24.0, -34.0, -46.0)
FOVY = 45.0
EVERY = 3                     # frames between shot choices
TAU = 0.55                    # s, the spring's time constant


class Director:
    def __init__(self, mujoco, m, meta, fps):
        self.mj, self.m, self.fps = mujoco, m, fps
        lab = meta.get("lab") or {}
        self.st = {s["id"]: s for s in lab.get("stations", [])}
        self.T = (lab.get("T_mm") or 277.0) / 1000.0
        self.base = m.body("base").id
        sites = [m.site(i).name for i in range(m.nsite)]
        self.grasp = m.site("grasp").id if "grasp" in sites else -1
        root = m.body_rootid[self.base]
        self.robot = {b for b in range(m.nbody) if m.body_rootid[b] == root}
        self.robot_list = sorted(self.robot)
        self.probe = self.robot_list[::max(1, len(self.robot_list) // 8)]    # bodies spread over the robot, for rays
        names = [m.body(b).name for b in range(m.nbody)]
        self.body_of = {sid: names.index(s["body"]) for sid, s in self.st.items() if s["body"] in names}
        puck = (lab.get("props") or [{}])[0].get("body")
        self.ok_bodies = set(self.robot) | ({names.index(puck)} if puck in names else set())
        self.groups = np.array([1, 1, 1, 0, 0, 0], np.uint8)
        self.gid = np.zeros(1, np.int32)
        self.cam = mujoco.MjvCamera()
        self.cam.type = mujoco.mjtCamera.mjCAMERA_FREE
        self.goal = self.state = self.vel = None
        self.frame, self.pick, self.rays, self.pick_blocked = 0, None, [], 0

    def station(self, phase, st):
        """the station in the shot: a lid moving or a read in progress, else the phase's, else the nearest"""
        for sid in ("reader", "inc"):
            o = (st or {}).get(sid)
            if o and (o["state"] in ("closing", "running", "opening") or (o["state"] == "done" and o["since"] < 4.0)):
                return sid
        mt = STATION.search(phase or "")
        if mt:
            return mt.group(1)
        return NEXT.get(phase)

    def nearest(self, b):
        best = min(self.st.values(), key=lambda s: math.hypot(s["park"][0] / 1000 - b[0], s["park"][1] / 1000 - b[1]), default=None)
        if best and math.hypot(best["park"][0] / 1000 - b[0], best["park"][1] / 1000 - b[1]) < 0.6:
            return best["id"]
        return None

    def _eye(self, look, az, el, dist):
        a, e = math.radians(az), math.radians(el)
        f = np.array([math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)])
        return look - dist * f, f

    def _blocked(self, d, eye, pts, sid):
        """how many of `pts` a prop hides from `eye` (the robot, the puck and the shot's station may)"""
        ok = self.ok_bodies | ({self.body_of[sid]} if sid in self.body_of else set())
        n = 0
        for p in pts:
            v = p - eye
            L = float(np.linalg.norm(v))
            x = self.mj.mj_ray(self.m, d, eye, v / L, self.groups, 1, -1, self.gid)
            n += 0 <= x < L - 0.03 and self.m.geom_bodyid[self.gid[0]] not in ok
        return n

    def _clutter(self, d, eye, f, dist, aspect, sid):
        """how many rays of a sparse grid over the frame meet a prop in front of the subject"""
        ok = self.ok_bodies | ({self.body_of[sid]} if sid in self.body_of else set())
        r = np.cross(f, [0.0, 0.0, 1.0])
        r /= np.linalg.norm(r)
        u = np.cross(r, f)
        th, n = math.tan(math.radians(FOVY) / 2), 0
        for sx in (-0.75, -0.25, 0.25, 0.75):
            for sy in (-0.5, 0.0, 0.5):
                v = f + sx * th * aspect * r + sy * th * u
                v /= np.linalg.norm(v)
                x = self.mj.mj_ray(self.m, d, eye, v, self.groups, 1, -1, self.gid)
                # a hit above the floor decals, well before the subject
                n += 0 <= x < 0.6 * dist and (eye + x * v)[2] > 0.05 and self.m.geom_bodyid[self.gid[0]] not in ok
        return n

    def _fit(self, look, f, pts, aspect):
        """the distance that holds every subject inside 70 % of the frame"""
        up = np.array([0.0, 0.0, 1.0])
        r = np.cross(f, up)
        r /= np.linalg.norm(r)
        u = np.cross(r, f)
        th = math.tan(math.radians(FOVY) / 2) * 0.7
        need = 0.9
        ring = [p + 0.2 * np.array([math.cos(a), math.sin(a), 0.0]) for p in pts[3:4] for a in (0, math.pi / 2, math.pi, 1.5 * math.pi)]
        for p in pts + ring:
            q = p - look
            x, y, z = float(q @ r), float(q @ u), float(q @ f)
            need = max(need, abs(x) / (th * aspect) - z, abs(y) / th - z)
        return need

    def _choose(self, d, sid, b, g, aspect):
        X = d.xpos[self.robot_list]
        top = X[int(np.argmax(X[:, 2]))].copy()
        pts = [np.array([b[0], b[1], 0.2]), np.array(g), top, np.array([b[0], b[1], 0.06])]
        if sid:
            s = self.st[sid]
            pts.append(np.array([s["nest"]["xy"][0] / 1000, s["nest"]["xy"][1] / 1000, self.T + 0.05]))
        look = sum(pts[:2] + pts[4:]) / (len(pts) - 2)
        look[2] = 0.22 + 0.3 * max(0.0, look[2] - 0.2)
        ring = [np.array([b[0] + dx, b[1] + dy, z]) for z in (0.1, 0.45) for dx, dy in ((0.15, 0), (-0.15, 0), (0, 0.15), (0, -0.15))]
        line = [pts[0] + u * (pts[4] - pts[0]) for u in (0.25, 0.5, 0.75)] if sid else []
        self.rays = pts + [look] + line + ring + list(d.xpos[self.probe])     # the subjects and the frame between them
        if sid:
            n = pts[4][:2] - b[:2]
            base_az = math.degrees(math.atan2(n[1], n[0])) - 50.0      # past the robot's right shoulder toward the station
            if math.sin(math.radians(base_az)) < -0.2:                   # keep to the open side (the eye at low y)
                base_az += 100.0
        else:
            base_az = 115.0 - 50.0 * min(1.0, max(0.0, (b[0] - 0.2) / 0.5))
        cands = [(i + abs(o) / 20.0, el, base_az + o) for i, el in enumerate(ELEVATIONS) for o in OFFSETS]
        prev = self.pick
        if prev and prev[0] == sid and abs((prev[2] - base_az + 180.0) % 360.0 - 180.0) <= 40.0:
            cands.insert(0, (-1.0, prev[1], prev[2]))                    # the running shot, preferred while it works
        best = None
        for pen, el, az in cands:
            f = self._eye(look, az, el, 1.0)[1]
            dist = self._fit(look, f, pts, aspect)
            nb = self._blocked(d, look - dist * f, self.rays, sid)
            score = 10 * nb + pen
            if best is not None and score >= best[0]:
                continue
            score += 1.5 * self._clutter(d, look - dist * f, f, dist, aspect, sid)
            if best is not None and score >= best[0]:
                continue
            score += 3 * (not self._path(d, np.array([*look, az, el, dist]), self.rays, sid))
            if best is None or score < best[0]:
                best = (score, el, az, dist, nb)
        self.pick, self.pick_blocked = (sid, best[1], best[2]), best[4]
        return look, best[2], best[1], best[3]

    def _path(self, d, goal, pts, sid):
        """the eased move from the current view to `goal` keeps the robot in sight"""
        if self.state is None:
            return True
        g = goal.copy()
        g[3] = self.state[3] + ((g[3] - self.state[3] + 180.0) % 360.0 - 180.0)
        for u in (0.33, 0.66):
            v = self.state + u * (g - self.state)
            if self._blocked(d, self._eye(v[:3], v[3], v[4], v[5])[0], pts, sid):
                return False
        return True

    def update(self, d, phase=None, st=None, aspect=4 / 3):
        b = d.xpos[self.base].copy()
        g = d.site_xpos[self.grasp].copy() if self.grasp >= 0 else b
        if self.frame % EVERY == 0 or self.goal is None:
            sid = self.station(phase, st) or self.nearest(b)
            look, az, el, dist = self._choose(d, sid, b, g, aspect)
            if self.state is not None:                                   # the short way round
                az = self.state[3] + ((az - self.state[3] + 180.0) % 360.0 - 180.0)
            self.goal = np.array([*look, az, el, dist])
        self.frame += 1
        if self.state is None:
            self.state, self.vel = self.goal.copy(), np.zeros(6)
        else:                                                            # critically damped, per frame
            w, h = 1.0 / TAU, 1.0 / self.fps
            acc = w * w * (self.goal - self.state) - 2 * w * self.vel
            self.vel = self.vel + h * acc
            self.state = self.state + h * self.vel
            v = self.state
            if self._blocked(d, self._eye(v[:3], v[3], v[4], v[5])[0], self.rays, self.pick[0]) > self.pick_blocked:
                self.state, self.vel = self.goal.copy(), np.zeros(6)          # a cut beats a blocked view
        c = self.cam
        c.lookat[:] = self.state[:3]
        c.azimuth, c.elevation, c.distance = float(self.state[3]), float(self.state[4]), float(self.state[5])
        return c
