"""The Blender job runner for hero.py: content stamps of each step's inputs, the .blend's build inputs,
one Blender job under the lock (timeout, peak VRAM of its own processes, peak host RSS), a dst lock and
the PNG check that resumable renders use."""
from __future__ import annotations

import glob
import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.dirname(HERE))
from paths import RENDER, STUDIO  # noqa: E402

# scripts and files that never change a .blend
NOT_BUILD = {"render.py", "check_fit.py", "thumb.py"}
PNG_SIG, PNG_END = b"\x89PNG\r\n\x1a\n", b"IEND\xaeB`\x82"


def digest(paths, extra=""):
    """sha256 over the names and bytes of the files that exist, plus extra"""
    h = hashlib.sha256()
    for p in sorted(paths):
        if os.path.exists(p):
            h.update(os.path.relpath(p, STUDIO).encode())
            with open(p, "rb") as fh:
                for b in iter(lambda: fh.read(1 << 20), b""):
                    h.update(b)
    h.update(extra.encode())
    return h.hexdigest()


def build_inputs(cap):
    """every file that changes a .blend built from the capture dir cap"""
    bl = os.path.join(HERE, "blender")
    code = glob.glob(os.path.join(bl, "*.py")) + glob.glob(os.path.join(bl, "models", "*.py"))
    return [os.path.join(cap, f) for f in ("capture.json", "capture.npz", "meshes.npz")] + [
        os.path.join(HERE, f) for f in ("looks.json", "models.json", "assets.lock.json")] + [
        os.path.join(STUDIO, "assets", "scenes", "lab", "decor.json")] + [
        p for p in code if os.path.basename(p) not in NOT_BUILD]


class Stamps:
    """step -> digest of its inputs (dst/stamps.json)"""

    def __init__(self, dst):
        self.path = os.path.join(dst, "stamps.json")
        try:
            self.d = json.load(open(self.path))
        except (OSError, ValueError):
            self.d = {}

    def stale(self, step, key):
        return self.d.get(step) != key

    def done(self, step, key):
        self.d[step] = key
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(self.d, fh, indent=1)
        os.replace(tmp, self.path)


def png_ok(path):
    """a complete PNG: the signature, an IHDR and the IEND chunk at the end"""
    try:
        with open(path, "rb") as fh:
            head = fh.read(16)
            fh.seek(-12, os.SEEK_END)
            tail = fh.read(12)
    except OSError:
        return False
    return head[:8] == PNG_SIG and head[12:16] == b"IHDR" and tail[4:] == PNG_END


def lock(dst, who):
    """hold an exclusive lock on dst for this process's life (one writer per dst)"""
    import fcntl
    os.makedirs(dst, exist_ok=True)
    fh = open(os.path.join(dst, ".lock"), "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        raise SystemExit("%s: %s is in use by another job" % (who, dst))
    return fh


def _children():
    """pid -> child pids, from /proc (empty elsewhere)"""
    kids = {}
    for st in glob.glob("/proc/[0-9]*/stat"):
        try:
            s = open(st).read()
        except OSError:
            continue
        pid, ppid = int(st.split("/")[2]), int(s[s.rindex(")") + 2:].split()[1])
        kids.setdefault(ppid, []).append(pid)
    return kids


class Gpu:
    """peak VRAM (MiB) of the compute processes under one pid, polled with nvidia-smi"""

    def __init__(self, pid):
        self.exe, self.pid, self.peak, self._stop = shutil.which("nvidia-smi"), pid, 0, threading.Event()

    def used(self):
        try:
            r = subprocess.run([self.exe, "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
                               capture_output=True, text=True, timeout=5)
        except subprocess.TimeoutExpired:
            return 0
        kids, mine, todo = _children(), set(), [self.pid]
        while todo:
            p = todo.pop()
            mine.add(p)
            todo += kids.get(p, [])
        rows = [ln.split(",") for ln in r.stdout.strip().splitlines() if "," in ln]
        return sum(int(m) for p, m in rows if p.strip().isdigit() and int(p) in mine and m.strip().isdigit())

    def __enter__(self):
        if self.exe:
            threading.Thread(target=self._poll, daemon=True).start()
        return self

    def _poll(self):
        while not self._stop.wait(0.5):
            self.peak = max(self.peak, self.used())

    def __exit__(self, *_):
        self._stop.set()


def blender(script, args, blend=None, log=None, timeout=None, who="blender"):
    """one Blender job (blender.py's lock, cap and nice); returns and logs {job, args, wall_s, vram_gb, rss_gb}"""
    import blender as BL
    t, rss = time.time(), None
    cmd = BL.command(script, list(args), blend, timeout)
    if os.path.exists("/usr/bin/time"):
        rss = os.path.join(RENDER, ".rss.%d" % os.getpid())
        os.makedirs(os.path.dirname(rss), exist_ok=True)
        i = cmd.index(BL.find_blender())
        cmd = cmd[:i] + ["/usr/bin/time", "-f", "%M", "-o", rss] + cmd[i:]
    p = subprocess.Popen(cmd, cwd=STUDIO)
    with Gpu(p.pid) as g:
        code = p.wait()
    if code == 124 and timeout:
        raise SystemExit("%s: blender %s timed out after %d s" % (who, script, timeout))
    if code:
        raise SystemExit("%s: blender %s exited %d" % (who, script, code))
    out = dict(job=script, args=" ".join(args[:6]), wall_s=round(time.time() - t, 1), vram_gb=round(g.peak / 1024, 2))
    if rss and os.path.exists(rss):
        try:
            out["rss_gb"] = round(int(open(rss).read().split()[-1]) / 1048576, 2)
        except (ValueError, IndexError):
            pass
        os.remove(rss)
    if log is not None:
        log.append(out)
    return out
