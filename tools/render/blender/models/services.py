"""Overhead services (world frame, mm): a 300 x 60 wire-basket cable tray at z 2400 on threaded-rod
trapezes, running behind the liquid handler with branches over the incubator and the reader, and a drop
from the tray to each instrument's cable end (the ends the station models use): a 22 mm bundle leaving the
tray 180 mm along the run, hanging in a soft curve, with a service loop below the entry, in natural spiral
wrap (a milky band over a grey core, so it reads as a hose, not a corkscrew) at an 11 mm pitch."""
import math

import numpy as np

import _bl as B
import _kit as K

ROLE = "dressing"
Z, W, HT = 2400.0, 300.0, 60.0
RUNS = [((-1440, 1330), (1425, 1330)), ((1425, 1330), (1425, 490)), ((-1440, 1330), (-1440, 490))]
DROPS = {"lh": (0, 555, 770), "inc": (0, 425, 262), "reader": (0, 440, 292)}   # station frame, z over T


def basket(a, b):
    """a wire basket from a to b: 6 longitudinal wires and U-shaped cross wires every 50 mm"""
    a, b = np.array(a, float), np.array(b, float)
    L = float(np.linalg.norm(b - a))
    t = (b - a) / L
    n = np.array([-t[1], t[0]])
    P = []
    for s in (-W / 2, -W / 4, 0, W / 4, W / 2):
        z = Z if abs(s) < W / 2 else Z + HT
        p0, p1 = a + n * s, b + n * s
        P.append(K.bar((p0[0], p0[1], z), (p1[0], p1[1], z), 2.5, "steel", 6))
    for s in (-W / 2, W / 2):
        p0, p1 = a + n * s, b + n * s
        P.append(K.bar((p0[0], p0[1], Z + HT / 2), (p1[0], p1[1], Z + HT / 2), 2.5, "steel", 6))
    if K.web():
        return P
    for k in range(int(L // 50) + 1):
        c = a + t * min(k * 50.0, L)
        pts = [c + n * (-W / 2), c + n * (-W / 2), c + n * (W / 2), c + n * (W / 2)]
        path = [(pts[0][0], pts[0][1], Z + HT), (pts[1][0], pts[1][1], Z), (pts[2][0], pts[2][1], Z), (pts[3][0], pts[3][1], Z + HT)]
        P.append(K.sweep(K.fillet_path(path, 12, 3), 2.0, "steel", 6))
    return P


def trapeze(p, t):
    n = np.array([-t[1], t[0]])
    q0, q1 = np.array(p) + n * (W / 2 + 40), np.array(p) - n * (W / 2 + 40)
    P = [K.bar((q0[0], q0[1], Z - 20), (q1[0], q1[1], Z - 20), 12, "steel", 8)]
    for q in (q0, q1):
        P.append(K.bar((q[0], q[1], Z - 32), (q[0], q[1], 2700), 5, "steel", 8))
    return P


def bezier(P, n):
    P = np.asarray(P, float)
    t = np.linspace(0, 1, n)[:, None]
    while len(P) > 1:
        P = np.stack([(1 - t) * P[i] + t * P[i + 1] for i in range(len(P) - 1)])
    return P[0]


def centreline(top, end, along, back):
    """tray exit -> soft curve down -> a service loop hanging behind and under the entry -> into the cable end"""
    top, end = np.array(top, float), np.array(end, float)
    a, b = np.append(along, 0.0), np.append(back, 0.0)
    exit_ = top + a * 180.0 - (0, 0, 70)
    low = end + b * 70 - (0, 0, 120)
    drop = bezier([top, exit_, exit_ - (0, 0, 500), low + a * 120 + (0, 0, 380), low + a * 50], 40)
    loop = K.fillet_path([drop[-1], low, low - a * 40, end + b * 25 - a * 10, end], 40, 6)
    P = np.concatenate([drop, np.asarray(loop[1:], float)])
    keep = [0]
    for i in range(1, len(P)):
        if np.linalg.norm(P[i] - P[keep[-1]]) > 4.0:
            keep.append(i)
    return P[keep]


def helix(P, r, pitch, per_turn=8, phase=0.0):
    """a helix of pitch around the polyline P at radius r (parallel-transport frames)"""
    seg = np.linalg.norm(np.diff(P, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    S = np.arange(0, s[-1], pitch / per_turn)
    C = np.stack([np.interp(S, s, P[:, k]) for k in range(3)], 1)
    T = np.gradient(C, axis=0)
    T /= np.linalg.norm(T, axis=1)[:, None]
    u = np.cross(T[0], [1.0, 0, 0])
    u /= np.linalg.norm(u)
    out = []
    for i in range(len(C)):
        u = u - T[i] * (u @ T[i])
        u /= np.linalg.norm(u)
        a = 2 * math.pi * (S[i] + phase) / pitch
        out.append(C[i] + r * (math.cos(a) * u + math.sin(a) * np.cross(T[i], u)))
    return out


def drop(top, end, along, back, r=11.0):
    """a cable bundle from the tray to an instrument in natural spiral wrap"""
    P = centreline(top, end, along, back)
    out = [K.sweep(P, r - 1.4, "polymer_grey", 12)]
    if not K.web():
        for ph in (0.0, 2.6):
            out.append(K.sweep(helix(P[:-3], r - 0.4, 11.0, phase=ph), 1.3, "polymer_white", 5, caps=True))
    return out


def build(ctx):
    m = B.Model(ctx, ctx.name)
    for a, b in RUNS:
        m.add(*basket(a, b))
        t = (np.array(b, float) - np.array(a, float))
        t /= np.linalg.norm(t)
        L = float(np.linalg.norm(np.array(b, float) - np.array(a, float)))
        for s in np.arange(150, L, 1200):
            m.add(*trapeze(np.array(a, float) + t * s, t))
    T = ctx.lab["T_mm"]
    for sid, (lx, ly, lz) in DROPS.items():
        st = B.station(ctx, sid)
        c, s_ = math.cos(math.radians(st["yaw"])), math.sin(math.radians(st["yaw"]))
        ox, oy = st["origin"]
        wx, wy = ox + c * lx - s_ * ly, oy + s_ * lx + c * ly
        m.add(*drop((wx, wy, Z), (wx, wy, T + lz), (c, s_), (-s_, c)))
    return m.finish()
