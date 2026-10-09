#!/usr/bin/env python3
"""Run a tools/render/blender/ script in headless Blender: capped at 8 GB, niced, one Blender at a time.

    blender.py <script> [--blend file.blend] [script args...]      e.g. blender.py build --cap DIR --out lab.blend

Blender is $BLENDER, else the newest 5.2.x under $HOME/opt/blender (Linux), /Applications (macOS) or
Program Files (Windows). The lock is $BLENDER_LOCK (default <tmp>/rps-blender.lock); every Blender job,
GPU or not, takes it. The lock needs flock and the memory cap systemd-run; without them a job runs
unlocked or uncapped, with a warning.
"""
from __future__ import annotations

import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, "blender")
MEMORY_MAX = "8G"


def find_blender():
    exe = os.environ.get("BLENDER")
    if exe:
        return exe
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        pats = [os.path.join(r, "Blender*.app", "Contents", "MacOS", "Blender") for r in ("/Applications", os.path.join(home, "Applications"))]
    elif sys.platform == "win32":
        pats = [os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "Blender Foundation", "Blender 5.2*", "blender.exe")]
    else:
        pats = [os.path.join(home, "opt", "blender", "5.2.*", "blender")]

    def ver(p):
        return tuple(int(x) for x in re.findall(r"\d+", p))

    found = sorted((p for pat in pats for p in glob.glob(pat) if os.access(p, os.X_OK)), key=ver)
    if not found:
        raise SystemExit("blender.py: no Blender 5.2.x in %s; set BLENDER" % " or ".join(pats))
    return found[-1]


def lock_path():
    return os.environ.get("BLENDER_LOCK") or os.path.join(tempfile.gettempdir(), "rps-blender.lock")


_warned = set()


def warn(what):
    if what not in _warned:
        _warned.add(what)
        print("blender.py: warning: %s" % what, file=sys.stderr)


def command(script, args, blend=None, timeout=None):
    """the wrapped command line; script is a name under blender/ or a .py path; timeout (s) counts from
    when the lock is taken"""
    path = script if script.endswith(".py") else os.path.join(SCRIPTS, script + ".py")
    if not os.path.isfile(path):
        raise SystemExit("blender.py: no script %s" % path)
    cmd = [find_blender(), "-b"]
    cmd += [blend] if blend else ["--factory-startup"]
    cmd += ["--python-exit-code", "1", "-P", path, "--", *args]
    wrap = ["nice", "-n", "5"] if shutil.which("nice") else []
    if timeout and shutil.which("timeout"):
        wrap = ["timeout", "-k", "30", str(int(timeout))] + wrap
    if shutil.which("systemd-run"):
        wrap = ["systemd-run", "--user", "--scope", "-q", "-p", "MemoryMax=" + MEMORY_MAX, "-p", "MemorySwapMax=0"] + wrap
    else:
        warn("no systemd-run: Blender runs without the %s memory cap" % MEMORY_MAX)
    if shutil.which("flock"):
        wrap = ["flock", lock_path()] + wrap
    else:
        warn("no flock: Blender runs without the lock (%s)" % lock_path())
    return wrap + cmd


def run(script, args, blend=None):
    return subprocess.call(command(script, list(args), blend), cwd=os.path.join(HERE, "..", ".."))


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    script, rest, blend = argv[0], argv[1:], None
    if "--blend" in rest:
        i = rest.index("--blend")
        blend = os.path.abspath(rest[i + 1])
        rest = rest[:i] + rest[i + 2:]
    return run(script, rest, blend)


if __name__ == "__main__":
    sys.exit(main())
