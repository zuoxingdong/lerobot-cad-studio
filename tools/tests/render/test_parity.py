"""The Python half of the Python/JS parity golden (tools/tests/fixtures/photoreal-golden.json): the camera
basis (campath), kelvin_rgb, sRGB -> linear and the emission strengths (looks). The node half is
tools/tests/ui/showcase-parity.test.mjs. RPS_WRITE_GOLDEN=1 rewrites the file from Python."""

from __future__ import annotations

import json
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
import campath  # noqa: E402
import looks  # noqa: E402

GOLDEN = os.path.join(STUDIO, "tools", "tests", "fixtures", "photoreal-golden.json")
ROWS = [[0.2, -0.1, 0.8, 30, -20, 2.5, 40], [1, 2, 0.5, -135, -45, 1.2, 55], [0, 0, 1, 90, 10, 3, 25],
        [-0.5, 0.3, 0.2, 179.5, -70, 0.8, 71]]
KELVIN = [1900, 2700, 4000, 4600, 6500]
SRGB = [0, 0.02, 0.04045, 0.2, 0.5, 0.9, 1]
EMIT = [dict(spec={"nits": 1200, "kelvin": 4000, "key": True}, table={"calibration": {"key_scale": 0.4}}),
        dict(spec={"nits": 300, "emit_rgb": [1, 0.5, 0.2]}, table={"units": {"lm_per_w": 683}}),
        dict(spec={"emit": 0.5, "base": [0.8, 0.2, 0.1]}, table={}, emit=6.0),
        dict(spec={"emit": 1.5, "base": [0.1, 0.9, 0.3]}, table={}, emit=4.0)]


def golden():
    cams = []
    for r in ROWS:
        eye, right, up, fwd = campath.basis(r)
        cams.append(dict(row=r, eye=eye.tolist(), right=right.tolist(), up=up.tolist(), forward=fwd.tolist(),
                         lens_mm=campath.lens_mm(r[6])))
    emits, keep = [], dict(looks.CONF)
    try:
        for e in EMIT:
            looks.configure(e["table"])
            rgb, s = looks.emission(e["spec"], e.get("emit", looks.EMIT))
            emits.append(dict(e, emit=e.get("emit", looks.EMIT), key_scale=looks.CONF["key_scale"], rgb=list(rgb), strength=s))
    finally:
        looks.CONF.clear()
        looks.CONF.update(keep)
    return dict(camera=cams, kelvin=[dict(k=k, rgb=list(looks.kelvin_rgb(k))) for k in KELVIN],
                srgb=[[c, looks.srgb_to_lin(c)] for c in SRGB], emission=emits)


def numbers(d):
    if isinstance(d, dict):
        return [v for k in sorted(d) for v in numbers(d[k])]
    if isinstance(d, (list, tuple)):
        return [v for x in d for v in numbers(x)]
    return [float(d)] if isinstance(d, (int, float)) and not isinstance(d, bool) else []


def shape(d):
    if isinstance(d, dict):
        return {k: shape(v) for k, v in d.items()}
    if isinstance(d, (list, tuple)):
        return [shape(x) for x in d]
    return type(d).__name__ if not isinstance(d, (int, float)) or isinstance(d, bool) else "num"


def test_python_matches_the_golden():
    now = golden()
    if os.environ.get("RPS_WRITE_GOLDEN"):
        with open(GOLDEN, "w", encoding="utf-8") as fh:
            json.dump(now, fh, indent=1)
            fh.write("\n")
    ref = json.load(open(GOLDEN, encoding="utf-8"))
    assert shape(ref) == shape(now)
    assert np.allclose(numbers(ref), numbers(now), rtol=0, atol=1e-12)
