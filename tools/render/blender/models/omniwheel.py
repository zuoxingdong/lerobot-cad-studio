"""The 4" double-row omniwheel in place of the single-body wheel mesh (parts `wheel_<k>`, each following its
wheel geom, so the hub and rollers turn with the capture's wheel spin): two black nylon hub plates with
roller forks, 2 x 6 staggered slate rubber barrel rollers on steel pins with a teal ring at each roller end,
a hub bolt circle and the brass shaft coupler on the inboard side.  Size, axis and
centre come from the wheel mesh itself (ctx.local), the outer face from the base plate's pose."""
import math

import numpy as np

import _bl as B
import _hw as H
import _kit as K

ROLE = "robot"
WHEELS = {"wheel_0": "^vis_4-Omni-Directional-Wheel_Single_Body-v1$", "wheel_1": "^vis_4-Omni-Directional-Wheel_Single_Body-v1-1$",
          "wheel_2": "^vis_4-Omni-Directional-Wheel_Single_Body-v1-2$"}
BASE = "^vis_base_plate_layer1-v5$"
N = 6                         # rollers per row


def frame(ctx, rx):
    """(centre mm, axis, u, radius, half width) of a wheel mesh in its own frame; axis points outboard"""
    V, F = ctx.local(rx)
    V = V * 1000.0
    c0 = V.mean(0)
    w, E = np.linalg.eigh(np.cov((V - c0).T))
    ax = E[:, 0] / np.linalg.norm(E[:, 0])
    u = np.cross(ax, [0.0, 0.0, 1.0] if abs(ax[2]) < 0.9 else [1.0, 0.0, 0.0])
    u /= np.linalg.norm(u)
    v = np.cross(ax, u)
    P = V - c0
    c = c0 + sum(d * (float((P @ d).min()) + float((P @ d).max())) / 2 for d in (ax, u, v))
    P = V - c
    t = P @ ax
    R = float(np.linalg.norm(P - np.outer(t, ax), axis=1).max())
    base = np.linalg.inv(ctx.pose(rx)) @ ctx.pose(BASE)
    if (base[:3, 3] * 1000 - c) @ ax > 0:
        ax, u = -ax, -u
    return c, ax, u, R, float(t.max() - t.min()) / 2


def roller(Rw, Rax, half, key_r, key_c):
    """one barrel roller along +x at the origin: rubber on the wheel's circle, teal end rings, PA end cores,
    steel pin ends"""
    prof = []
    n = K.nseg(10, 4)
    for k in range(n + 1):
        s = -half + 2 * half * k / n
        prof.append((math.sqrt(Rw * Rw - s * s) - Rax, s))
    rub = K.lathe([(1.6, -half)] + prof + [(1.6, half)], K.nseg(20, 8), key_r)
    ends = []
    r_end = math.sqrt(Rw * Rw - half * half) - Rax
    for sg in (-1, 1):
        if not K.web():                                   # the web LOD tints the end cores instead
            ends.append(K.ring(3.4, max(4.2, 0.72 * r_end), -0.4, 0.8, "roller_ring", 20, 0.2).moved(t=(0, 0, sg * (half + 0.4) - 0.2)))
        z0, z1 = (half, half + 1.6) if sg > 0 else (-half - 1.6, -half)
        ends.append(K.cyl(3.4, z0, z1, "roller_ring" if K.web() else key_c, 16, 0.3))
        ends.append(K.cyl(1.0, min(z0, z1) - (0.8 if sg < 0 else 0), max(z0, z1) + (0.8 if sg > 0 else 0), "steel", 8, 0))
    P = K.cat([rub] + ends)
    return P.moved(K.rot("y", 90))


def hub(Rax, row_z, phase):
    """one hub plate at z = row_z: a disc under its row's rollers and a round-topped fork lug at each roller
    joint (phase), which takes the two pins meeting there"""
    t, Rin, hw = 3.2, Rax - 10.0, 3.2
    Rt = Rax / math.cos(math.pi / N)
    poly, na = [], K.nseg(12, 4)
    for k in range(N):
        g = phase + 2 * math.pi * k / N
        c, s_ = math.cos(g), math.sin(g)
        pt = lambda r, w: (r * c - w * s_, r * s_ + w * c)
        poly.append(pt(math.sqrt(Rin * Rin - hw * hw), -hw))
        poly += [pt(Rt - hw + hw * math.cos(b), hw * math.sin(b)) for b in np.linspace(-math.pi / 2, math.pi / 2, na)]
        poly.append(pt(math.sqrt(Rin * Rin - hw * hw), hw))
        g1 = g + math.asin(hw / Rin)
        g2 = g + 2 * math.pi / N - math.asin(hw / Rin)
        poly += [(Rin * math.cos(b), Rin * math.sin(b)) for b in np.linspace(g1, g2, na + 2)[1:-1]]
    holes = [K.circle(7.0, K.nseg(24))]
    for k in range(N):
        a = phase + 2 * math.pi * (k + 0.5) / N
        holes.append(K.circle(3.6, K.nseg(12), 25.0 * math.cos(a), 25.0 * math.sin(a)))
    return K.plate_holes(poly, holes, row_z - t / 2, row_z + t / 2, "wheel")


def wheel(Rw, hw):
    """the wheel along its own +z (outboard), rollers in two staggered rows"""
    rho = min(9.5, 0.48 * hw)
    Rax = Rw - rho
    half = Rw * math.sin(math.pi / N) * 0.72
    rows = (-hw + rho + 0.5, hw - rho - 0.5)
    P = []
    one = roller(Rw, Rax, half, "rubber_roller", "wheel")
    for j, z in enumerate(rows):
        a0 = math.pi * j / N
        for k in range(N):
            a = a0 + 2 * math.pi * k / N
            P.append(one.moved(K.rot("z", math.degrees(a) + 90), (Rax * math.cos(a), Rax * math.sin(a), z)))
        P.append(hub(Rax, z, a0 + math.pi / N))
    # the core between the plates and the bolt circle through both
    P.append(K.ring(7.0, Rax - 12.5, rows[0] + 1.6, rows[1] - 1.6, "wheel", 48, 0.4))
    P.append(K.ring(3.0, 7.0, rows[0] - 12.0, rows[0] - 1.6, "brass", K.nseg(32, 12), 0.4))
    for k in range(N):
        a = 2 * math.pi * k / N
        x, y = 18 * math.cos(a), 18 * math.sin(a)
        P.append(H.screw(3.0, "screw_zinc").moved(t=(x, y, rows[1] + 1.6)))
        P.append(K.cyl(2.8, rows[0] - 3.4, rows[0] - 1.6, "screw_zinc", 6, 0.2, (x, y)))
    return P


def build(ctx):
    m = B.Model(ctx, ctx.name)
    for part, rx in WHEELS.items():
        c, ax, u, R, hw = frame(ctx, rx)
        M = np.stack([u, np.cross(ax, u), ax], 1)
        m.origin[part] = (0, 0, 0)
        m.add(*[p.moved(M, c) for p in wheel(R, hw)], sub=part)
    return m.finish()
