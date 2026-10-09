"""build.py in real Blender (skipped without one): a short capture becomes a keyed .blend, and the
rps/models@1 hook places static, multi-instance and follow parts exactly on the geoms they replace."""

from __future__ import annotations

import json
import os
import subprocess

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
RENDER = os.path.join(STUDIO, "tools", "render")
import blender as BL  # noqa: E402
import capture  # noqa: E402

COPY = '''
def copy(ctx, rx, name):
    V, F = ctx.mesh(rx)
    me = ctx.bpy.data.meshes.new(name)
    me.from_pydata(V.tolist(), [], F.tolist())
    return ctx.bpy.data.objects.new(name, me)
'''
MODELS = {
    "inc_copy": COPY + '''
def build(ctx):
    return {"static": copy(ctx, "^decor_inc_body$", "inc_copy_body"), "lid": copy(ctx, "^decor_inc_lid$", "inc_copy_lid")}
''',
    "nest_copy": COPY + '''
def build(ctx):
    return [copy(ctx, "^decor_nest_8$", "nest_copy_" + ctx.name)]
'''}
TABLE = {"schema": "rps/models@1", "models": [
    {"model": "inc_copy", "anchor": "^decor_inc_body$", "match": "^decor_inc_(body|lid)$", "follow": {"lid": "^decor_inc_lid$"}},
    {"model": "nest_copy", "anchor": "^decor_nest_8$", "match": "^decor_nest_8$"}]}
CHECK = '''
import bpy, json, sys
import numpy as np
sys.path.insert(0, %(blender)r)
import pose
cap = json.load(open(%(cap)r + "/capture.json"))
Z, M = np.load(%(cap)r + "/capture.npz"), np.load(%(cap)r + "/meshes.npz")
mov, sub = list(Z["moving"]), cap["sub"]
def world(key, j):
    g = next(g for g in cap["geoms"] if key in (g["name"], g["mesh"]))
    row = Z["track"][j, mov.index(g["i"])].astype(float) if g["i"] in mov else Z["first"][g["i"]]
    return M["v%%d" %% g["mesh_id"]].astype(float) @ pose.quat_mat(row[3:7]).T + row[0:3]
pairs = [("inc_copy_body", "decor_inc_body"), ("inc_copy_lid", "anim_inc_lid_0"),
         ("nest_copy_nest_copy", "nest_lh"), ("nest_copy_nest_copy.1", "nest_reader")]
sc, err = bpy.context.scene, 0.0
for j in range(0, cap["frames"] * sub, 7):
    f = cap["frame0"] + j / sub
    sc.frame_set(int(f), subframe=f - int(f))
    for a, b in pairs:
        ob = bpy.data.objects[a]
        mw = np.array(ob.evaluated_get(bpy.context.evaluated_depsgraph_get()).matrix_world)
        V = np.array([v.co[:] for v in ob.data.vertices]) @ mw[:3, :3].T + mw[:3, 3]
        err = max(err, float(np.abs(V - world(b, j)).max()))
C = bpy.data.collections
lid = bpy.data.objects["inc_copy_lid_follow"]
print("RESULT " + json.dumps(dict(err=err, capture=len(C["capture"].objects), replaced=len(C["replaced"].objects),
    models=len(C["models"].objects), frames=[sc.frame_start, sc.frame_end], look=sc.view_settings.view_transform,
    cam_keys=bool(sc.camera.animation_data and sc.camera.animation_data.action),
    lid_keys=bool(lid.animation_data and lid.animation_data.action),
    bevels=sum(1 for o in bpy.data.objects if any(m.type == "BEVEL" for m in o.modifiers)))))
'''


def blender_or_skip():
    try:
        return BL.find_blender()
    except SystemExit as e:
        pytest.skip(str(e))


@pytest.mark.blender
def test_build_places_models_on_their_geoms(lab, tmp_path):
    blender_or_skip()
    cap = str(tmp_path / "cap")
    capture.write(cap, *capture.capture(lab, os.path.join(lab, "ctrl.f32"), fps=30, sub=2, t0=26.4, seconds=1.2))
    mdir = tmp_path / "models"
    mdir.mkdir()
    for name, src in MODELS.items():
        (mdir / (name + ".py")).write_text(src)
    (tmp_path / "models.json").write_text(json.dumps(TABLE))
    blend = str(tmp_path / "lab.blend")
    code = BL.run("build", ["--cap", cap, "--out", blend, "--models", str(tmp_path / "models.json"),
                            "--models-dir", str(mdir)])
    assert code == 0 and os.path.getsize(blend) > 1e6
    (tmp_path / "check.py").write_text(CHECK % dict(blender=os.path.join(RENDER, "blender"), cap=cap))
    r = subprocess.run(BL.command(str(tmp_path / "check.py"), [], blend, timeout=600), capture_output=True, text=True,
                       timeout=3600)
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-2000:]
    res = json.loads(next(ln for ln in r.stdout.splitlines() if ln.startswith("RESULT "))[7:])
    assert res["err"] < 1e-6, res                               # metres, over frames and subframes
    assert res["replaced"] == 4 and res["capture"] == 354 - 4 and res["models"] >= 4 + 3 + 1
    assert res["frames"] == [792, 827] and res["look"] == "Khronos PBR Neutral"
    assert res["cam_keys"] and res["lid_keys"] and res["bevels"] > 50
