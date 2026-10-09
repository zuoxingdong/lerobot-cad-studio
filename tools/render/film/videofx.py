"""The tubes' liquid and the omni wheels in the video: stepped from the sim state after every mj_step,
posed on an MjvScene after mjv_updateScene. Only scene geoms are touched, never the model or the data.

Liquid mirrors src/features/sim-liquid.js createLiquid() with the same float formulas; the wheel
spin mirrors src/features/sim-wheels.js. Both read their geometry from the sidecar (scene.json).
"""

from __future__ import annotations

import math

import numpy as np

G = 9.81


def decay(e, v, w, z, dt):
    """e = s - s*, de/dt over dt for e'' + 2 zeta w e' + w^2 e = 0, exactly (underdamped)"""
    wd = w * math.sqrt(1 - z * z)
    k, c, s = math.exp(-z * w * dt), math.cos(wd * dt), math.sin(wd * dt)
    B = (v + z * w * e) / wd
    return k * (e * c + B * s), k * ((wd * B - z * w * e) * c - (wd * e + z * w * B) * s)


class Liquid:
    """One puck's tubes: sample(t, pos, R) with R row-major 3x3; surfaces() -> [(sx, sy)] tube-frame slopes."""

    def __init__(self, spec):
        self.spec, self.n = spec, len(spec["wells"])
        self.w, self.z = spec["omega"], spec["zeta"]
        self.local = [(x / 1000, y / 1000, spec["z_rest_mm"] / 1000) for x, y in spec["wells"]]
        self.reset()

    def reset(self):
        self.S = [[0.0, 0.0] for _ in range(self.n)]
        self.V = [[0.0, 0.0] for _ in range(self.n)]
        self.F1 = [[0.0, 0.0, 0.0] for _ in range(self.n)]
        self.F2 = [[0.0, 0.0, 0.0] for _ in range(self.n)]
        self.hist = []
        self.R = [1.0, 0, 0, 0, 1.0, 0, 0, 0, 1.0]

    def sample(self, t, pos, R):
        R = [float(v) for v in R]
        P = [[pos[i] + R[3 * i] * q[0] + R[3 * i + 1] * q[1] + R[3 * i + 2] * q[2] for i in range(3)] for q in self.local]
        if self.hist and t < self.hist[-1][0]:
            self.reset()
        if self.hist and not t > self.hist[-1][0]:
            return
        self.hist.append((t, P))
        if len(self.hist) > 3:
            self.hist.pop(0)
        self.R = R
        if len(self.hist) < 3:
            return
        (ta, a), (tb, b), (tc, c) = self.hist
        dt, smax = tc - tb, self.spec["s_max"]
        al = 1 - math.exp(-dt / self.spec["accel_tau_s"])
        for k in range(self.n):
            F1, F2 = self.F1[k], self.F2[k]
            for i in range(3):
                F1[i] += al * (2 * ((c[k][i] - b[k][i]) / (tc - tb) - (b[k][i] - a[k][i]) / (tb - ta)) / (tc - ta) - F1[i])
                F2[i] += al * (F1[i] - F2[i])
            acc = F2
            ge = [-acc[0], -acc[1], -G - acc[2]]
            nt = [-(R[j] * ge[0] + R[3 + j] * ge[1] + R[6 + j] * ge[2]) for j in range(3)]
            nz = max(nt[2], 0.2 * math.sqrt(nt[0] ** 2 + nt[1] ** 2 + nt[2] ** 2))
            want = (-nt[0] / nz, -nt[1] / nz)
            for i in range(2):
                e, v = decay(self.S[k][i] - want[i], self.V[k][i], self.w, self.z, dt)
                self.S[k][i], self.V[k][i] = e + want[i], v
            m = math.hypot(*self.S[k])
            if m > smax:
                u = (self.S[k][0] / m, self.S[k][1] / m)
                out = self.V[k][0] * u[0] + self.V[k][1] * u[1]
                self.S[k] = [u[0] * smax, u[1] * smax]
                if out > 0:
                    self.V[k] = [self.V[k][0] - out * u[0], self.V[k][1] - out * u[1]]

    def surfaces(self):
        return [tuple(s) for s in self.S]

    def tilt_deg(self):
        """(against the tube axis, against the world vertical) per tube"""
        R, out = np.asarray(self.R).reshape(3, 3), []
        for sx, sy in self.S:
            n = np.array([-sx, -sy, 1.0]) / math.sqrt(sx * sx + sy * sy + 1)
            out.append((math.degrees(math.atan(math.hypot(sx, sy))), math.degrees(math.acos(min(1.0, float((R @ n)[2]))))))
        return out


def glow_level(o):
    """src/features/sim-liquid.js glowLevel: the reader's excitation on the hit tube, 0..1"""
    if not o:
        return 0.0
    if o["state"] in ("closing", "running", "opening"):
        return o["closure"]
    return 0.3 if o["state"] == "done" else 0.0


def rot(axis, ang):
    a = np.asarray(axis, float)
    a = a / np.linalg.norm(a)
    K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + math.sin(ang) * K + (1 - math.cos(ang)) * K @ K


def wheel_rates(specs, vx, vy, wz):
    """rad/s about each joint axis from the robot-frame base velocity: no slip along the drive direction"""
    out = []
    for w in specs:
        ax, ay = w["axle"][0], w["axle"][1]
        rx = ax * ax + ay * ay
        if rx < 1e-9:
            out.append(0.0)
            continue
        ux, uy = vx - wz * w["rim_mm"][1] / 1000, vy + wz * w["rim_mm"][0] / 1000
        out.append(((ux * ay - uy * ax) / rx) / (w["radius_mm"] / 1000))
    return out


class Effects:
    """Per physics step: the liquid from the puck pose, the wheel angles from the base velocity.
    apply(scn, st): shears each liquid column and meniscus onto its surface plane, lights the hit
    tube under the reader, and turns each wheel's geoms about its axle."""

    def __init__(self, mujoco, m, meta):
        self.mj = mujoco
        lab = meta.get("lab") or {}
        P = (lab.get("props") or [None])[0]
        self.liq = Liquid(P["liquid"]) if P and P.get("liquid") else None
        names = {m.geom(i).name: i for i in range(m.ngeom)}
        self.cols = {}
        if self.liq:
            self.puck = m.body(P["body"]).id
            for k in range(self.liq.n):
                for part in ("liquid", "meniscus"):
                    g = names.get("%s_%s_%d" % (P["body"], part, k + 1))
                    if g is not None:
                        self.cols[g] = k
            self.hit, self.glow = P["liquid"]["hit"], P["liquid"]["glow"]
        self.wheels = [w for w in meta.get("wheels") or [] if w["body"] in [m.body(i).name for i in range(m.nbody)]]
        self.wbody = {m.body(w["body"]).id: i for i, w in enumerate(self.wheels)}
        self.ang = [0.0] * len(self.wheels)
        jn = [m.joint(i).name for i in range(m.njnt)]
        self.base = [(m.joint(n).qposadr[0], m.joint(n).dofadr[0]) for n in ("base_x", "base_y", "base_yaw")] if "base_yaw" in jn else None
        self.dt, self.gb = float(m.opt.timestep), m.geom_bodyid.copy()
        self.want = set(self.cols) | {g for g in range(m.ngeom) if int(self.gb[g]) in self.wbody}
        self.idx = {}

    def _index(self, scn):
        """scene slots of the geoms posed here, cached per scene while its geom order holds"""
        GEOM, got = self.mj.mjtObj.mjOBJ_GEOM, self.idx.get(id(scn))
        if got is not None and all(scn.geoms[i].objtype == GEOM and scn.geoms[i].objid == g for i, g in got):
            return got
        got = [(i, scn.geoms[i].objid) for i in range(scn.ngeom) if scn.geoms[i].objtype == GEOM and scn.geoms[i].objid in self.want]
        self.idx[id(scn)] = got
        return got

    def step(self, d):
        if self.liq:
            self.liq.sample(float(d.time), d.xpos[self.puck].tolist(), d.xmat[self.puck].tolist())
        if self.wheels and self.base:
            bx, by, bw = (float(d.qvel[v]) for _, v in self.base)
            yaw = float(d.qpos[self.base[2][0]])
            c, s = math.cos(yaw), math.sin(yaw)
            for i, r in enumerate(wheel_rates(self.wheels, c * bx + s * by, -s * bx + c * by, bw)):
                self.ang[i] = math.fmod(self.ang[i] + r * self.dt * 180 / math.pi, 360.0)

    def apply(self, scn, d, st=None):
        surf = self.liq.surfaces() if self.liq else []
        lvl = glow_level((st or {}).get("reader")) if self.liq else 0.0
        for i, _ in self._index(scn):
            g = scn.geoms[i]
            if g.objid in self.cols:
                k = self.cols[g.objid]
                sx, sy = surf[k]
                R = np.asarray(g.mat).reshape(3, 3)
                g.mat[:] = R @ np.array([[1.0, 0, 0], [0, 1.0, 0], [sx, sy, 1.0]])
                if k == self.hit and lvl > 0:
                    g.rgba[:3] = [(1 - 0.6 * lvl) * c + 0.6 * lvl * e for c, e in zip(g.rgba[:3], self.glow)]
                    g.emission = 0.9 * lvl
            elif int(self.gb[g.objid]) in self.wbody:
                body = int(self.gb[g.objid])
                j = self.wbody[body]
                pivot = d.xpos[body]
                Rw = rot(d.xmat[body].reshape(3, 3) @ np.asarray(self.wheels[j]["axis_local"], float), math.radians(self.ang[j]))
                g.pos[:] = pivot + Rw @ (np.asarray(g.pos) - pivot)
                g.mat[:] = Rw @ np.asarray(g.mat).reshape(3, 3)
