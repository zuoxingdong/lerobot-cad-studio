"""Static checks of a JS-emitted MuJoCo model against the package it came from (native mujoco).

Every expected value comes from outside the model: the URDF through armfk.py, robot.json for
limits, presets and lenses, the linkage formula for the jaw, the studio's own camera poses
(scene.json) for the camera mounts.  `check.py` runs these, then the lab replay.
"""

from __future__ import annotations

import json
import math
import os

import numpy as np

import armfk

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.abspath(os.path.join(HERE, "..", ".."))
D2R = math.pi / 180.0

TOL_FK_MM = 0.05
TOL_CAM_MM = 0.1
TOL_CAM_DEG = 0.1
TOL_GAP_MM = 0.01
CONTACT_TOL_MM = 0.05
MASS_PART_MAX_KG = 0.25
KNIT_MM = (1.0, 1.5)             # the real fingertip covers, measured on the build


def package(meta):
    """(robot.json of the composition, of its base): limits, presets and lenses."""
    def load(rid):
        with open(os.path.join(STUDIO, "assets", "robots", rid, "robot.json"), encoding="utf-8") as fh:
            return json.load(fh)
    top = load(meta["robot"])
    return top, (load(top["base"]) if top.get("base") else top)


def set_pose(mujoco, m, d, meta, q_deg=None, jaw_deg=0.0):
    d.qpos[:] = m.qpos0
    d.qvel[:] = 0
    for name, k in ((meta.get("jaw") or {}).get("mimic") or {}).items():
        d.qpos[m.joint(name).qposadr[0]] = jaw_deg * k * D2R
    for name, v in (q_deg or {}).items():
        d.qpos[m.joint(name).qposadr[0]] = v * D2R
    mujoco.mj_forward(m, d)


def robot_mm(p, meta):
    return (np.asarray(p, float) - np.array([0, 0, -meta["ground_z_mm"] / 1000.0])) * 1000.0


def angle(a, b):
    return math.degrees(math.acos(float(np.clip(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)), -1, 1))))


def check_fk(rep, mujoco, m, d, meta, base):
    if not meta["fk"]["bodies"]:
        rep.add("fk", "no arm in this design", True, "skipped")
        return
    J, _ = armfk.parse_full(os.path.join(STUDIO, meta["fk"]["urdf"]))
    for p in base["presets"]:
        ref = armfk.fk_q(J, p["q"], root=meta["fk"]["root_link"])
        set_pose(mujoco, m, d, meta, p["q"])
        worst, deg, at = 0.0, 0.0, "-"
        for body, link in meta["fk"]["bodies"].items():
            b = m.body(body).id
            e = float(np.max(np.abs(robot_mm(d.xpos[b], meta) - ref[link][:3, 3] * 1000.0)))
            R = d.xmat[b].reshape(3, 3)
            deg = max(deg, max(angle(R[:, k], ref[link][:3, k]) for k in range(3)))
            if e > worst:
                worst, at = e, body
        rep.add("fk", "preset %-11s vs armfk.py, worst of %d bodies (%s)" % (p["id"], len(meta["fk"]["bodies"]), at),
                worst <= TOL_FK_MM and deg < 1e-3, "%.2e mm / %.2e deg" % (worst, deg))


def check_limits(rep, m, meta, top, base):
    lim = dict((base.get("kinematics") or {}).get("joint_limits_deg") or {})
    for name in meta["arm_joints"]:
        got = np.degrees(m.jnt_range[m.joint(name).id])
        lo, hi = lim.get(name, (None, None))
        rep.add("dof", "%-18s range %.2f .. %.2f deg" % (name, got[0], got[1]),
                lo is not None and abs(got[0] - lo) < 1e-6 and abs(got[1] - hi) < 1e-6, "robot.json %s .. %s" % (lo, hi))
    for q in meta["jaw_joints"]:
        att, jn = q.split("/") if "/" in q else (meta["robot"], q)
        sub = json.load(open(os.path.join(STUDIO, "assets", "robots", att, "robot.json"), encoding="utf-8"))
        want = next(j for j in sub["kinematics"]["joints"] if j["name"] == jn)["limit_deg"]
        got = np.degrees(m.jnt_range[m.joint(q.replace("/", "_")).id])
        rep.add("dof", "%-18s range %.4f .. %.4f deg" % (q, got[0], got[1]),
                abs(got[0] - want[0]) < 1e-6 and abs(got[1] - want[1]) < 1e-6, "robot.json %s .. %s" % tuple(want))
    names = [m.joint(i).name for i in range(m.njnt)]
    rep.add("dof", "actuators = 3 drive + %d arm + %d jaw" % (len(meta["arm_joints"]), len(meta["jaw_joints"])),
            m.nu == 3 + len(meta["arm_joints"]) + len(meta["jaw_joints"]), "nu %d" % m.nu)
    rep.add("dof", "base is slide x, slide y, hinge yaw; no wheel joints",
            all(n in names for n in ("base_x", "base_y", "base_yaw")) and not any("wheel" in n for n in names),
            "njnt %d nq %d nv %d" % (m.njnt, m.nq, m.nv))
    rep.add("dof", "every equality constraint is active", int(np.sum(m.eq_active0)) == m.neq, "neq %d" % m.neq)


def check_jaw(rep, mujoco, m, d, meta):
    lk = meta.get("linkage")
    if not lk:
        rep.add("jaw", "no four-bar in this design", True, "skipped")
        return
    L, th = float(lk["link_length_mm"]), float(lk["closed_crank_deg"])
    qmax = meta["jaw_max_deg"]
    for q in (0.0, 5.0, 10.0, 20.0, 30.0, qmax):
        set_pose(mujoco, m, d, meta, {}, q)
        got = float(np.linalg.norm(d.site("pad_L").xpos - d.site("pad_R").xpos)) * 1000.0
        want = 2.0 * L * (math.sin(th * D2R) - math.sin((th - q) * D2R))
        rep.add("jaw", "pad gap at %7.4f deg: model %.4f, formula %.4f mm" % (q, got, want),
                abs(got - want) < TOL_GAP_MM, "%.2e mm" % abs(got - want))


def geom_verts(m, d, g):
    """a mesh geom's points in the world (m)"""
    k = int(m.geom_dataid[g])
    V = m.mesh_vert[m.mesh_vertadr[k]:m.mesh_vertadr[k] + m.mesh_vertnum[k]]
    return V @ d.geom_xmat[g].reshape(3, 3).T + d.geom_xpos[g]


def check_pads(rep, mujoco, m, d, meta):
    """each fingertip cover stands proud of its bare hull by the knit, along the grip axis only; it
    touches the world and never the robot"""
    pc = meta.get("pad_cover")
    if not pc:
        rep.add("pads", "no fingertip covers in this design", True, "skipped")
        return
    set_pose(mujoco, m, d, meta, {}, 15.0)
    env = set(meta["env_bodies"]) | {"world"}
    live = lambda g: m.geom_contype[g] or m.geom_conaffinity[g]
    robot = [g for g in range(m.ngeom) if live(g) and m.body(int(m.geom_bodyid[g])).name not in env]
    world = [g for g in range(m.ngeom) if live(g) and m.body(int(m.geom_bodyid[g])).name in env]
    hit = lambda a, b: bool((m.geom_contype[a] & m.geom_conaffinity[b]) or (m.geom_contype[b] & m.geom_conaffinity[a]))
    for c in pc["geoms"]:
        g, b = m.geom(c["geom"]).id, m.geom("col_" + c["geom"][4:]).id
        R = d.xmat[m.body(c["body"]).id].reshape(3, 3)
        n = R @ np.array(c["normal"])
        side = R @ np.cross(c["normal"], [0.0, 0.0, 1.0] if abs(c["normal"][2]) < 0.9 else [1.0, 0.0, 0.0])
        Vc, Vb = geom_verts(m, d, g), geom_verts(m, d, b)
        proud = float(np.max(Vc @ n) - np.max(Vb @ n)) * 1000.0
        back = float(np.max(Vc @ -n) - np.max(Vb @ -n)) * 1000.0
        wide = float(np.ptp(Vc @ side) - np.ptp(Vb @ side)) * 1000.0
        ok = (abs(proud - pc["mm"]) < TOL_GAP_MM and KNIT_MM[0] <= pc["mm"] <= KNIT_MM[1] and abs(back + pc["mm"]) < TOL_GAP_MM
              and abs(wide) < TOL_GAP_MM and np.allclose(m.geom_friction[g], pc["friction"]) and m.geom_priority[g] == 1)
        rep.add("pads", "%s: grip face proud of the bare hull by the knit (%.1f .. %.1f mm), friction %s" % (c["geom"], *KNIT_MM, pc["friction"]),
                ok, "%.4f mm, sides %.4f" % (proud, wide))
    covers = [m.geom(c["geom"]).id for c in pc["geoms"]]
    rep.add("pads", "the covers touch the world, never the robot (closed on nothing they pass through each other)",
            not any(hit(c, r) for c in covers for r in robot) and all(hit(c, w) for c in covers for w in world),
            "%d robot geoms, %d world geoms" % (len(robot), len(world)))


def check_cameras(rep, mujoco, m, d, meta, top, base):
    lens = {c["id"]: c for c in base.get("cameras", [])}
    lens.update({c["id"]: c for c in top.get("cameras", []) if top is not base})
    presets = [dict(id="zero", q={})] + base.get("presets", [])
    for cid, cam in sorted(meta["cameras"].items()):
        c = m.camera(cid).id
        worst, deg = 0.0, 0.0
        for p in presets:
            set_pose(mujoco, m, d, meta, p["q"])
            W = np.array(cam["robot_mm"][p["id"]])
            worst = max(worst, float(np.max(np.abs(robot_mm(d.cam_xpos[c], meta) - W[:3, 3]))))
            R = d.cam_xmat[c].reshape(3, 3)
            deg = max(deg, max(angle(R[:, k], W[:3, k]) for k in range(3)))
        rep.add("camera", "%-5s on %-15s vs the studio's pose at zero + %d presets" % (cid, cam["body"], len(presets) - 1),
                worst < TOL_CAM_MM and deg < TOL_CAM_DEG, "%.2e mm / %.2e deg" % (worst, deg))
        dev = lens.get(cid, {})
        vfov = 2 * math.degrees(math.atan(math.tan(dev.get("hfov_deg", 87.3) * D2R / 2) / dev.get("aspect", 4 / 3)))
        rep.add("camera", "%-5s fovy from the package lens (hfov %.1f deg), 640x480" % (cid, dev.get("hfov_deg", 0)),
                abs(m.cam_fovy[c] - vfov) < 0.01 and tuple(m.cam_resolution[c]) == (640, 480), "%.3f deg" % m.cam_fovy[c])


def check_mass(rep, mujoco, m, meta, xml_path):
    env = set(meta["env_bodies"]) | {"world"}
    total = sum(float(m.body_mass[i]) for i in range(m.nbody) if m.body(i).name not in env)
    top, base = package(meta)
    band = (top.get("mass") or base.get("mass") or {}).get("band_kg")
    if meta["drive"]["v_max_mps"] <= 0:
        rep.add("mass", "fixed base: no robot mass band", True, "%.3f kg" % total)
    elif band:
        lo, hi = band
        rep.add("mass", "robot total in the package band %.1f .. %.1f kg (robot.json mass)" % (lo, hi),
                lo <= total <= hi, "%.3f kg" % total)
    else:
        rep.add("mass", "robot.json states a mass band", False, "%.3f kg, no mass.band_kg" % total)
    printed = {k for k, v in meta["masses"].items() if v["printed"]}
    spec = mujoco.MjSpec.from_file(xml_path)
    geoms = {g.name[4:]: float(g.mass) for g in spec.worldbody.find_all(mujoco.mjtObj.mjOBJ_GEOM) if g.name.startswith("col_")}
    worst = max(((geoms.get(k.replace("/", "_"), 0.0), k) for k in printed), default=(0.0, "-"))
    rep.add("mass", "heaviest printed part (with fasteners) under %.0f g (%s)" % (MASS_PART_MAX_KG * 1000, worst[1]),
            worst[0] <= MASS_PART_MAX_KG, "%.1f g" % (worst[0] * 1000))
    rep.add("mass", "every fitted component carries a geom mass",
            len(geoms) == meta["components"] and all(v > 0 for v in geoms.values()),
            "%d geoms / %d components" % (len(geoms), meta["components"]))


def sweep(meta):
    q = meta["jaw_max_deg"]
    return [("jaw %5.1f deg" % (q * k / 4), {}, q * k / 4) for k in range(5)] + \
        [("preset %-11s" % pid, p, 0.0) for pid, p in meta["presets"].items()]


def pairs(m, d, env):
    out = {}
    for i in range(d.ncon):
        c = d.contact[i]
        a, b = m.body(int(m.geom_bodyid[c.geom1])).name, m.body(int(m.geom_bodyid[c.geom2])).name
        if a == b or a in env or b in env:
            continue
        k = "|".join(sorted((a, b)))
        out[k] = max(out.get(k, 0.0), -float(c.dist) * 1000.0)
    return out


def pin_residual_mm(A, B):
    M = [np.linalg.inv(a) @ b for a, b in zip(A, B)]
    rows = np.vstack([(x - M[0])[:3, :] for x in M[1:]])
    q, *_ = np.linalg.lstsq(rows[:, :3], -rows[:, 3], rcond=None)
    return float(np.max(np.abs(rows[:, :3] @ q + rows[:, 3]))) * 1000.0


def frame(d, b):
    T = np.eye(4)
    T[:3, :3] = d.xmat[b].reshape(3, 3)
    T[:3, 3] = d.xpos[b]
    return T


def check_contacts(rep, mujoco, m, d, meta, xml_path):
    env = set(meta["env_bodies"]) | {"world"}
    base = meta["model"]["baseline"]
    shared = {"|".join(sorted((m.body(i).name, m.body(int(m.body_parentid[i])).name))) for i in range(1, m.nbody)}
    shared = {k for k in shared if not (set(k.split("|")) & env)}
    rep.add("contact", "excludes = %d joint-sharing pairs + %d pinned loop closures, nothing else" % (len(shared), len(base)),
            m.nexclude == len(shared) + len(base), "nexclude %d" % m.nexclude)
    for label, q, jaw in sweep(meta):
        set_pose(mujoco, m, d, meta, q, jaw)
        net = {k: v - base.get(k, 0.0) for k, v in pairs(m, d, env).items()}
        k, v = max(net.items(), key=lambda kv: kv[1], default=("-", 0.0))
        rep.add("contact", "%s worst self-penetration over baseline (%s)" % (label, k), v < CONTACT_TOL_MM, "%.3f mm" % v)
    if not base:
        return
    spec = mujoco.MjSpec.from_file(xml_path)
    for e in list(spec.excludes):
        if "|".join(sorted((e.bodyname1, e.bodyname2))) in base:
            spec.delete(e)
    m2 = spec.compile()
    d2 = mujoco.MjData(m2)
    deep, fr = {k: [] for k in base}, {k: ([], []) for k in base}
    for _, q, jaw in sweep(meta):
        set_pose(mujoco, m2, d2, meta, q, jaw)
        got = pairs(m2, d2, env)
        for k in base:
            deep[k].append(got.get(k, 0.0))
            a, b = k.split("|")
            fr[k][0].append(frame(d2, m2.body(a).id))
            fr[k][1].append(frame(d2, m2.body(b).id))
    for k, v in deep.items():
        res = pin_residual_mm(*fr[k])
        ok = res <= CONTACT_TOL_MM and min(v) >= CONTACT_TOL_MM and max(v) - base[k] <= CONTACT_TOL_MM
        rep.add("contact", "loop %s still pinned, live: overlap %.3f .. %.3f mm" % (k, min(v), max(v)), ok,
                "pin residual %.4f mm" % res)
