"""Where local runs land (gitignored): the finished products at the out/ top level, everything else under
out/work/. tools/paths.mjs is the JS twin; tools/tests/paths.test.mjs keeps them equal."""
import errno
import os
import shutil

STUDIO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
OUT = os.path.join(STUDIO, "out")
WORK = os.path.join(OUT, "work")
CACHE = os.path.join(WORK, "cache")      # pack/ decimations, render/ CC0 downloads
RENDER = os.path.join(WORK, "render")    # captures, .blend files, frames, stills, the bake
SIM = os.path.join(WORK, "sim")          # sim exports and runs
E2E = os.path.join(WORK, "e2e")
PRODUCTS = ("hero.mp4", "hero_web.mp4", "lab-task.mp4", "teleop.mp4", "draft.mp4", "sim-report.md")


def publish(src, name, keep=False):
    """src -> out/<name> by a rename (a copy through out/work/ when keep or across filesystems): a product
    is never half-written"""
    assert name in PRODUCTS, name
    dst = os.path.join(OUT, name)
    if not keep:
        try:
            os.replace(src, dst)
            return dst
        except OSError as e:
            if e.errno != errno.EXDEV:
                raise
    os.makedirs(WORK, exist_ok=True)
    tmp = os.path.join(WORK, "." + name + ".part")
    shutil.copyfile(src, tmp)
    os.replace(tmp, dst)
    if not keep:
        os.remove(src)
    return dst
