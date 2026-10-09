"""jobs.py and hero.prepare without Blender: truncated PNGs are found, and a stale .blend never takes
rendered frames with it unless --fresh."""

from __future__ import annotations

import json
import os
import zlib

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
RENDER = os.path.abspath(os.path.join(HERE, "..", "..", "render"))
import hero as HERO  # noqa: E402
import jobs as JOBS  # noqa: E402


def png(path, w=4, h=2):
    def chunk(t, b):
        return len(b).to_bytes(4, "big") + t + b + zlib.crc32(t + b).to_bytes(4, "big")
    raw = b"".join(b"\0" + b"\x80" * (3 * w) for _ in range(h))
    data = JOBS.PNG_SIG + chunk(b"IHDR", w.to_bytes(4, "big") + h.to_bytes(4, "big") + bytes([8, 2, 0, 0, 0])) + \
        chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    open(path, "wb").write(data)
    return data


def test_png_ok_finds_truncated_frames(tmp_path):
    p = str(tmp_path / "f00001.png")
    data = png(p)
    assert JOBS.png_ok(p)
    open(p, "wb").write(data[:-5])
    assert not JOBS.png_ok(p)
    open(p, "wb").write(b"")
    assert not JOBS.png_ok(p) and not JOBS.png_ok(str(tmp_path / "none.png"))


def test_stamps_survive_a_bad_file(tmp_path):
    (tmp_path / "stamps.json").write_text("{not json")
    st = JOBS.Stamps(str(tmp_path))
    assert st.d == {} and st.stale("build", "k")
    st.done("build", "k")
    assert not JOBS.Stamps(str(tmp_path)).stale("build", "k")


@pytest.fixture
def fake(tmp_path, monkeypatch):
    lab, dst, src = tmp_path / "lab", tmp_path / "dst", tmp_path / "looks.json"
    lab.mkdir()
    for f, v in (("report.json", {"timestep": 0.002}), ("scene.json", {})):
        (lab / f).write_text(json.dumps(v))
    (lab / "ctrl.f32").write_bytes(b"\0" * 8)
    src.write_text("1")
    builds = []

    def capture(*a, **k):
        return {"frame0": 0, "frames": 3}, None, None

    def write(cap, doc, *_):
        os.makedirs(cap, exist_ok=True)
        json.dump(doc, open(os.path.join(cap, "capture.json"), "w"))

    def blender(script, args, blend, log, timeout=None):
        open(args[args.index("--out") + 1], "w").write("blend %d" % len(builds))
        builds.append(args)
    monkeypatch.setattr(HERO.CAP, "capture", capture)
    monkeypatch.setattr(HERO.CAP, "write", write)
    monkeypatch.setattr(HERO, "blender", blender)
    monkeypatch.setattr(HERO.JOBS, "build_inputs", lambda cap: [str(src)])
    monkeypatch.setattr(HERO, "_HELD", [])
    return str(lab), str(dst), src, builds


def test_stale_build_keeps_frames_until_fresh(fake, capsys):
    lab, dst, src, builds = fake
    HERO.prepare(lab, dst, None, None, [])
    HERO.prepare(lab, dst, None, None, [])
    assert len(builds) == 1                                         # inputs unchanged: no rebuild
    os.makedirs(os.path.join(dst, "frames"))
    png(os.path.join(dst, "frames", "f00000.png"))
    src.write_text("2")
    HERO.prepare(lab, dst, None, None, [])
    assert len(builds) == 1 and os.path.exists(os.path.join(dst, "frames", "f00000.png"))
    assert "WARNING" in capsys.readouterr().out
    HERO.prepare(lab, dst, None, None, [], fresh=True)
    assert len(builds) == 2 and not os.path.exists(os.path.join(dst, "frames"))
    os.remove(os.path.join(dst, "lab.blend"))
    os.makedirs(os.path.join(dst, "frames"))
    png(os.path.join(dst, "frames", "f00000.png"))
    with pytest.raises(SystemExit):
        HERO.prepare(lab, dst, None, None, [])                      # frames but no .blend: ask for --fresh
