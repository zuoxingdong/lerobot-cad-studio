"""looks.resolve order (name rule, then dm_<k> via decor.json + overlay, then the fallback), the tint rule,
and that looks.json / models.json parse against their contracts."""

from __future__ import annotations

import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
RENDER = os.path.join(STUDIO, "tools", "render")
import looks  # noqa: E402

TABLE = json.load(open(os.path.join(RENDER, "looks.json"), encoding="utf-8"))
DECOR = json.load(open(os.path.join(STUDIO, "assets", "scenes", "lab", "decor.json"), encoding="utf-8"))


def geom(name="", mat=None, channels=()):
    return {"name": name, "mat": mat, "channels": list(channels)}


def test_name_rules_come_first():
    assert looks.resolve(geom("vis_so101_STS3215_03a-v1", "dm_inst_white"), DECOR, TABLE)[0] == "servo"
    assert looks.resolve(geom("vis_lekiwi_4-Omni-Directional-Wheel_Single_Body-v1"), DECOR, TABLE)[0] == "wheel"
    assert looks.resolve(geom("vis_94868A713_Standoff-2"), DECOR, TABLE)[0] == "brass"
    assert looks.resolve(geom("vis_base_plate_layer1-v5"), DECOR, TABLE)[0] == "acrylic_clear"      # clear acrylic plates
    assert looks.resolve(geom("vis_SO_ARM100_08k_Mirror-v1"), DECOR, TABLE)[0] == "pla_aqua"       # the arm's filament
    key, spec = looks.resolve(geom("puck_1_liquid_3"), DECOR, TABLE)
    assert key == "liquid" and spec["transmission"] == 1.0 and spec["ior"] == 1.333 and spec["volume"]
    assert looks.resolve(geom("puck_1_meniscus_1"), DECOR, TABLE)[0] == "liquid"
    # a rule may match the mesh instead of the name
    assert looks.resolve({"name": "", "mesh": "decor_lh_glass", "mat": "dm_smoked_glass"}, DECOR, TABLE)[0] == "glass"


def test_decor_material_with_overlay():
    key, spec = looks.resolve(geom("", "dm_glass"), DECOR, TABLE)
    assert key == "glass" and spec["transmission"] == 1.0 and spec["ior"] == 1.585
    assert spec == TABLE["library"]["glass"]                         # the library replaces decor's rgba
    key, spec = looks.resolve(geom("", "dm_slab_white"), DECOR, TABLE)
    assert key == "slab_white" and spec == TABLE["library"]["plinth_top"]    # through the alias
    key, spec = looks.resolve(geom("", "dm_floor"), DECOR, TABLE)
    assert key == "floor" and spec["floor"]
    # an overlay goes over the library spec; a decor key with neither keeps decor's values
    table = dict(TABLE, overlay={"glass": {"rough": 0.3}})
    assert looks.resolve(geom("", "dm_glass"), DECOR, table)[1]["rough"] == 0.3
    decor = {"materials": {"haze": {"rgba": [0.5, 0.5, 0.5, 0.3]}}}
    spec = looks.resolve(geom("", "dm_haze"), decor, {})[1]
    assert spec["transmission"] == 1.0 and spec["base"] == looks.lin3([0.5, 0.5, 0.5])


def test_fallback_and_lookup():
    assert looks.resolve(geom("", "dm_no_such_material"), DECOR, TABLE)[0] == "pla"
    assert looks.resolve(geom(""), DECOR, TABLE) == ("pla", TABLE["fallback"]["spec"])
    assert looks.resolve(geom(""), {}, {})[0] == looks.FALLBACK[0]
    assert looks.lookup("servo", DECOR, TABLE) == TABLE["library"]["servo"]
    assert looks.lookup("inst_white", DECOR, TABLE)["rough"] == 0.42
    assert looks.lookup("nothing", DECOR, TABLE) == TABLE["fallback"]["spec"]
    assert TABLE["fallback"]["spec"]["base"] == "object"            # the models' alias check relies on it


def test_tint_rule():
    assert looks.is_tinted(geom("anim_inc_led_0", "dm_led_white", ["rgba", "emission"]))
    assert looks.is_tinted(geom("anim_reader_bar_1", "dm_cap_blue", ["pos", "size", "rgba"]))
    assert not looks.is_tinted(geom("anim_inc_lid_0", "dm_inst_grey", ["pos", "quat"]))


def test_srgb_to_linear():
    assert looks.srgb_to_lin(0.0) == 0.0 and abs(looks.srgb_to_lin(1.0) - 1.0) < 1e-12
    assert abs(looks.srgb_to_lin(0.5) - 0.21404) < 1e-5


def test_tables_parse():
    assert TABLE["schema"] == "rps/looks@1" and TABLE["film"]["view"] == "Khronos PBR Neutral"
    for r in TABLE["rules"]:
        re.compile(r.get("match") or r["mesh"])
    models = json.load(open(os.path.join(RENDER, "models.json"), encoding="utf-8"))
    assert models["schema"] == "rps/models@1"
    for e in models["models"]:
        for rx in [e["match"], e.get("anchor") or e["match"], *(e.get("follow") or {}).values()]:
            re.compile(rx)
        assert os.path.isfile(os.path.join(RENDER, "blender", "models", e["model"] + ".py")), e["model"]
