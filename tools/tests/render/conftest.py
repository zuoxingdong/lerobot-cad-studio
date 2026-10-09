"""A visual lab export with its lab run, shared by the render tests; a test that takes it is `slow`.
The markers (blender, gl, slow) are declared in pyproject.toml. Select with -m, not -k: every test id
here contains the directory name "render"."""

import os
import subprocess

import pytest

STUDIO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SIM = os.path.join(STUDIO, "tools", "sim")


@pytest.fixture(scope="session")
def lab(tmp_path_factory):
    out = str(tmp_path_factory.mktemp("lab"))
    for args in (["export.mjs", "--robot", "lekiwi-pincopen", "--visual", "--out", out], ["run-lab.mjs", out]):
        subprocess.run(["node", os.path.join(SIM, args[0]), *args[1:]], cwd=STUDIO, check=True,
                       capture_output=True, timeout=900)
    return out


def pytest_collection_modifyitems(items):
    for it in items:
        if "lab" in getattr(it, "fixturenames", ()):
            it.add_marker(pytest.mark.slow)
