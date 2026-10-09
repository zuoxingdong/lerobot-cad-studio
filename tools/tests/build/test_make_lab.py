"""tools/build/make_lab.py: byte-identical on a re-run, equal to the committed props, in budget."""

from __future__ import annotations

import filecmp
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
PROPS = os.path.join(STUDIO, "assets", "scenes", "lab", "props")


def make(out):
    r = subprocess.run([sys.executable, os.path.join(STUDIO, "tools", "build", "make_lab.py"), "--out", out],
                       capture_output=True, text=True, timeout=300)
    assert r.returncode == 0, r.stdout + r.stderr
    return r.stdout


def test_rerun_is_byte_identical_and_matches_the_committed_props(tmp_path):
    a, b = str(tmp_path / "a"), str(tmp_path / "b")
    log = make(a)
    make(b)
    names = sorted(os.listdir(a))
    assert names == sorted(os.listdir(b)) == sorted(f for f in os.listdir(PROPS) if f.endswith(".obj"))
    same, diff, err = filecmp.cmpfiles(a, b, names, shallow=False)
    assert not diff and not err
    same, diff, err = filecmp.cmpfiles(a, PROPS, names, shallow=False)
    assert not diff and not err, "props/ is stale: rerun make_lab.py (%s)" % diff
    total = int(log.strip().splitlines()[-1].split(" meshes, ")[1].split(" ")[0])
    assert 0 < total <= 60000


def test_every_face_is_a_valid_triangle():
    for f in sorted(os.listdir(PROPS)):
        nv = nf = 0
        with open(os.path.join(PROPS, f), encoding="ascii") as fh:
            for line in fh:
                if line.startswith("v "):
                    nv += 1
                elif line.startswith("f "):
                    idx = [int(c.split("//")[0]) for c in line.split()[1:]]
                    assert len(idx) == 3 and len(set(idx)) == 3 and all(1 <= i <= nv for i in idx), f
                    nf += 1
        assert nv > 0 and nf > 0, f
