"""The look library against its sources: every model slot and decor key resolves to a library spec, every
texture it names is a CC0 lock entry, emission units, the print-axis maths, and fetch_assets' pinning."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
RENDER = os.path.join(STUDIO, "tools", "render")
import fetch_assets  # noqa: E402
import looks  # noqa: E402
import printdir  # noqa: E402

TABLE = json.load(open(os.path.join(RENDER, "looks.json"), encoding="utf-8"))
DECOR = json.load(open(os.path.join(STUDIO, "assets", "scenes", "lab", "decor.json"), encoding="utf-8"))
LOCK = fetch_assets.load()
LIB = TABLE["library"]


def test_model_slot_keys_resolve():
    mats = os.path.join(RENDER, "blender", "models", "_mats.py")
    if not os.path.exists(mats):
        pytest.skip("no model materials")
    keys = re.findall(r'^\s*"(\w+)": \(\(', open(mats, encoding="utf-8").read(), re.M)
    assert keys and not [k for k in keys if k not in LIB and k not in TABLE["alias"]]


def test_decor_keys_and_rules_reach_the_library():
    for k in DECOR["materials"]:
        assert TABLE["alias"].get(k, k) in LIB, k
    for r in TABLE["rules"]:
        assert r["key"] in LIB, r["key"]
    assert all(v in LIB for v in TABLE["alias"].values())


def test_robot_rules():
    key = lambda n: looks.resolve({"name": n}, DECOR, TABLE)[0]  # noqa: E731
    assert key("vis_ST3215_Servo_Motor-v1-2") == key("vis_pincopen_sts3215_drive") == "servo"
    assert key("vis_STS3215_03a_Wrist_Roll-v1") == "servo"
    assert key("vis_servo_controller_mount-v3") == key("vis_omni_wheel_mount-v5") == "pla_cyan"
    assert key("vis_pincopen_removable_tip_2") == "fabric_knit_blue" and key("vis_corner_mast_printed_df200") == "camera_module"
    assert key("vis_corner_mast_printed_head") == key("vis_df200_arch_retainer") == "pla_cyan"      # camera yokes
    assert key("vis_pincopen_distal_shell") == "pla_cyan" and key("vis_Wrist_Roll_Pitch_08i-v1") == "pla_aqua"
    assert key("vis_lipo_battery_mount-v3") == "pla_dark" and key("vis_94868A713_NO-THREADS_Female-Threaded-Hex-Standoff-3") == "brass"
    for k in ("pla_cyan", "pla_aqua"):          # the photographed prints: light cyan and aqua matte PLA with layer lines
        s = LIB[k]
        b = s["base"]
        assert b[2] > b[1] > 0.4 > b[0] and s["rough"] >= 0.55 and s["layer"]["pitch_mm"] == 0.2 and s["lot"]["base"]
    assert max(LIB["servo"]["base"]) < 0.05 and LIB["servo"]["label"]


def maps_of(spec):
    for f in ("rough_var", "smudge", "height"):
        if (spec.get(f) or {}).get("map"):
            yield spec[f]["map"], {"rough_var": "var", "smudge": "mask", "height": "height"}[f]
    fl = spec.get("floor") or {}
    if fl.get("rough_map"):
        yield fl["rough_map"]["map"], "var"
    wh = spec.get("wheel") or {}
    if wh.get("height"):
        yield wh["height"]["map"], "height"


def test_textures_are_locked_cc0():
    assets = {e["id"]: e for e in LOCK["assets"]}
    assert fetch_assets.problems(LOCK) == []
    assert all(e["license"] == "CC0-1.0" and len(e["sha256"]) == 64 for e in LOCK["assets"])
    used = [(m, r) for s in LIB.values() for m, r in maps_of(s)] + [(TABLE["world"]["hdri"], "hdr")]
    for name, role in used:
        assert name in assets and role in assets[name]["maps"], (name, role)
    bad = dict(LOCK, assets=[dict(LOCK["assets"][0], license="CC-BY-NC-4.0", id="x")])
    assert fetch_assets.problems(bad)


def test_fetch_verifies_and_reuses(tmp_path, monkeypatch):
    blob = b"not really an hdr"
    entry = {"id": "t", "source": "s", "url": "https://example.invalid/t.hdr", "res": "1K", "license": "CC0-1.0",
             "author": "a", "used_by": ["test"], "maps": {"hdr": "t.hdr"}, "sha256": hashlib.sha256(blob).hexdigest()}
    calls = []
    monkeypatch.setattr(fetch_assets, "download", lambda url: calls.append(url) or blob)
    lock = {"assets": [entry]}
    assert fetch_assets.fetch(lock, str(tmp_path), log=lambda *_: None) == (1, 0)
    assert fetch_assets.fetch(lock, str(tmp_path), log=lambda *_: None) == (0, 1) and len(calls) == 1
    assert open(fetch_assets.path(entry, "hdr", str(tmp_path)), "rb").read() == blob
    with pytest.raises(SystemExit):
        fetch_assets.fetch({"assets": [dict(entry, id="u", sha256="0" * 64)]}, str(tmp_path), log=lambda *_: None)
    pinned = {"assets": [dict(entry, id="v", sha256="")]}
    fetch_assets.fetch(pinned, str(tmp_path), pin=True, log=lambda *_: None)
    assert pinned["assets"][0]["sha256"] == entry["sha256"]


def test_emission_units():
    looks.configure(TABLE)
    k = TABLE["calibration"]["key_scale"]
    rgb, s = looks.emission(LIB["panel_light"])
    assert math.isclose(s, 3180 / 683 * k) and math.isclose(sum(c * w for c, w in zip(rgb, (0.2126, 0.7152, 0.0722))), 1, rel_tol=1e-3)
    assert math.isclose(looks.emission(LIB["screen_ui_hi"])[1], 300 / 683)      # self-lit: never scaled
    assert math.isclose(looks.tint_strength(), TABLE["tint_nits"] / 683)
    assert looks.emission(LIB["pla_white"]) == (None, 0.0)
    r, g, b = looks.kelvin_rgb(4000)
    assert r > g > b
    assert max(abs(c - 1) for c in looks.kelvin_rgb(6500)) < 0.06


def box_mesh(s, R=np.eye(3), t=np.zeros(3), n=6):
    """a subdivided box with half sizes s, rotated by R and moved by t"""
    g = np.linspace(-1, 1, n)
    V, F = [], []
    for ax in range(3):
        for sign in (-1, 1):
            u, v = [a for a in range(3) if a != ax]
            base = len(V)
            for i in g:
                for j in g:
                    p = np.zeros(3)
                    p[ax], p[u], p[v] = sign, i, j
                    V.append(p * s)
            for i in range(n - 1):
                for j in range(n - 1):
                    a = base + i * n + j
                    F += [(a, a + n, a + 1), (a + 1, a + n, a + n + 1)]
    return np.array(V) @ R.T + t, np.array(F)


def rot(axis, deg):
    a = np.asarray(axis, float) / np.linalg.norm(axis)
    K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    th = math.radians(deg)
    return np.eye(3) + math.sin(th) * K + (1 - math.cos(th)) * K @ K


def test_print_axis_from_the_print_transform():
    Vs, Fs = box_mesh(np.array([30.0, 12.0, 45.0]))            # an STL in mm, printed on its tall Z
    R = rot((1, 2, 3), 40)
    Vc, Fc = box_mesh(np.array([0.030, 0.012, 0.045]), R, np.array([0.1, 0.2, 0.3]))
    bed = np.eye(4).T.ravel().tolist()
    ax, how = printdir.print_axis(Vc - Vc.mean(0), Fc, (Vs, Fs), bed)
    assert how == "print" and abs(abs(ax @ R[:, 2]) - 1) < 1e-6
    ax, how = printdir.print_axis(Vc, Fc)                     # no print file: the flattest axis
    assert how == "flat" and abs(abs(ax @ R[:, 1]) - 1) < 1e-6
    a, r, _ = printdir.wheel_frame(*box_mesh(np.array([0.05, 0.05, 0.01])))
    assert abs(abs(a[2]) - 1) < 1e-6 and math.isclose(r, 0.05 * math.sqrt(2), rel_tol=1e-6)


def test_layer_lines_follow_the_axis():
    ax = (0.0, 0.0, 1.0)
    assert abs(looks.layer_phase((0.3, -0.2, 0.00005), ax)) > 0.99      # a quarter layer up
    assert abs(looks.layer_phase((5.0, 3.0, 0.0), ax)) < 1e-9           # constant across a layer


def test_values_glass_and_new_keys():
    fl, film = LIB["floor_vinyl"], TABLE["film"]
    assert 0.36 <= fl["base"][1] <= 0.38 and fl["coat"] <= 0.08            # the floor sits below the white casework
    assert 1500 <= LIB["daylight"]["nits"] <= 3500 and 2.0 <= film["exposure"] <= 2.6       # Khronos PBR Neutral
    assert LIB["glass"]["rough"] <= 0.01 and LIB["glass"]["smudge"]["zone"]["z_below"] < 0.5 and LIB["glass"]["shadow_clear"]
    tube = LIB["tube_clear"]
    assert 0.85 <= tube["transmission"] <= 0.9 and tube["rough"] <= 0.07 and not LIB["label"].get("transmission")   # clear PP
    lo, hi = LIB["glow_off"]["tint_gate"]                     # the reader lining is dark at its idle colour
    assert 0.04 < lo < hi
    ac = LIB["acrylic_clear"]
    assert ac["ior"] == 1.49 and ac["transmission"] == 1.0 and ac["shadow_clear"] and ac["edge"]
    for k in ("pcb", "ic", "connector_w", "connector_k", "cable_jacket", "screw_zinc", "acrylic_clear", "rubber_roller"):
        assert k in LIB and LIB[k]["base"], k
    assert LIB["pcb"]["pcb"]["silk"] and LIB["pcb"]["coat"] > 0
    for k in ("pla_white", "pla_grey"):                 # banding that reads when the layers are sub-pixel
        s = LIB[k]
        assert s["layer"]["rough_amp"] > 0 and s["infill"] and s["seam"] and len(s["lot"]["base"]) >= 2 and s["wear"]


def test_cables_start_at_known_parts():
    import glob
    text = "".join(open(f, encoding="utf-8").read() for f in glob.glob(os.path.join(STUDIO, "assets", "robots", "*", "robot.json"))
                   + glob.glob(os.path.join(STUDIO, "assets", "parts", "*", "part.json")))
    name = lambda v: v["on"] if isinstance(v, dict) else v  # noqa: E731
    parts = {name(v) for c in TABLE["cables"] for v in c["via"] if name(v).startswith("vis_") and name(v)[4:] in text}
    anchor = re.compile(r"^@(servo_\w+\.\d|cam_\w+|pi_usb\.\d|batt_dc|switch\.\d|driver_dc|adapter_usb|strap)$")
    groups = set(TABLE["cable_defer"])
    for c in TABLE["cables"]:
        assert c["group"] in groups and len(c["via"]) >= 2 and c["key"] in LIB and c["plug"] in LIB
        assert 1.02 <= c.get("slack", 1.05) <= 1.08 and c["d_mm"] >= 2.4       # drape, no loops above the wrist
        assert c["group"] != "usb" or c["d_mm"] >= 3.5
        for v in c["via"]:
            assert anchor.match(name(v)) or name(v) in parts, v
            assert not isinstance(v, dict) or len(v["at"]) == 3


BUILD_ALL = '''
import bpy, json, sys
sys.path.insert(0, %(blender)r)
import looks
T = json.load(open(%(looks)r))
looks.configure(T)
bad = []
for k in T["library"]:
    for tint in (False, True):
        try:
            looks.build(bpy, k, looks.lookup(k, {}, T), tint)
        except Exception as e:
            bad.append("%%s: %%s" %% (k, e))
print("RESULT " + json.dumps(dict(bad=bad, n=len(bpy.data.materials))))
'''


@pytest.mark.blender
def test_every_library_graph_builds(tmp_path):
    import subprocess
    import blender as BL
    try:
        BL.find_blender()
    except SystemExit as e:
        pytest.skip(str(e))
    (tmp_path / "all.py").write_text(BUILD_ALL % dict(blender=os.path.join(RENDER, "blender"), looks=os.path.join(RENDER, "looks.json")))
    r = subprocess.run(BL.command(str(tmp_path / "all.py"), [], timeout=600), capture_output=True, text=True, timeout=3600)
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-2000:]
    res = json.loads(next(ln for ln in r.stdout.splitlines() if ln.startswith("RESULT "))[7:])
    assert res["bad"] == [] and res["n"] >= 2 * len(LIB) - 5
