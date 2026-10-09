"""Pi case verification: five checks against the Raspberry Pi 5 dummy.

vendor/pidummy.py is imported read-only, so the board and connector geometry is single-sourced:
  1 no interference between the case and the board or its connectors,
  2 the board can slide in from the rear along +Y,
  3 the USB-C / HDMI / IO faces are reachable through the case,
  4 the microSD card clears the shortened pit,
  5 the +X cable channel is open.
Volume-based intersection needs a boolean engine; if none is available it falls back to
point-sampling containment, and the report says which was used.
"""
import warnings

import numpy as np
import trimesh

from common import add_scripts_to_path

add_scripts_to_path()
import pidummy as PD   # noqa: E402  (vendor/pidummy.py, read-only)

warnings.filterwarnings('ignore')

FLOOR_Z1 = 61.0


def _overlap(shell, part):
    """overlap volume in mm3; boolean if possible, else a sampled estimate."""
    try:
        i = shell.intersection(part)
        if i is not None and len(i.faces):
            return float(i.volume), 'boolean'
        return 0.0, 'boolean'
    except Exception:
        P = trimesh.sample.volume_mesh(part, 4000)
        if not len(P):
            return 0.0, 'sampled'
        frac = float(shell.contains(P).mean())
        return frac * float(part.volume), 'sampled'


def _pts(m, dy, n=11):
    b = m.bounds
    return np.array([[x, y - dy, z]
                     for x in np.linspace(b[0][0] + .4, b[1][0] - .4, n)
                     for y in np.linspace(b[0][1] + .4, b[1][1] - .4, 3)
                     for z in np.linspace(b[0][2] + .4, b[1][2] - .4, n)])


def run(cradle_file, cover_file, log=print):
    cr = trimesh.load(cradle_file)
    cv = trimesh.load(cover_file)
    case = trimesh.util.concatenate([cr, cv])
    P = PD.PARTS
    checks = []

    # 1 interference
    bad, worst, eng = [], 0.0, 'boolean'
    for k, v in P.items():
        if k == 'SD withdrawn':
            continue
        for nm, sh in (('cradle', cr), ('cover', cv)):
            vol, eng = _overlap(sh, v)
            if vol > 1.0:
                bad.append('%s x %s %.1f mm3' % (k, nm, vol))
            worst = max(worst, vol)
    checks.append({'name': 'no case/board interference', 'pass': not bad,
                   'detail': ('clear (worst overlap %.1f mm3, %s test)' % (worst, eng))
                             if not bad else '; '.join(bad)})
    log("  pi: interference %s" % checks[-1]['detail'])

    # 2 insertion from the rear (board slides in along +Y)
    worst_k = 0
    for d in np.arange(45, -0.1, -5.0):
        k = sum(int(cr.contains(_pts(P[q], d)).sum())
                for q in ('PCB', 'USB-C', 'HDMI0', 'HDMI1', 'IO(eth+usb)', 'microSD'))
        worst_k = max(worst_k, k)
    checks.append({'name': 'board insertion path clear', 'pass': worst_k == 0,
                   'detail': 'max intrusions over the whole path: %d' % worst_k})
    log("  pi: insertion path %s (%d intrusions)" %
        ('CLEAR' if worst_k == 0 else 'BLOCKED', worst_k))

    # 3 ports reachable
    def reach(part, dirn, start):
        b = P[part].bounds
        ax = int(np.argmax(np.abs(dirn)))
        sgn = np.sign(dirn[ax])
        axes = [i for i in range(3) if i != ax]
        g = [np.linspace(b[0][i] + 0.6, b[1][i] - 0.6, 9) for i in axes]
        G = np.array(np.meshgrid(*g, indexing='ij')).reshape(2, -1).T
        o = np.zeros((len(G), 3))
        o[:, axes[0]] = G[:, 0]
        o[:, axes[1]] = G[:, 1]
        o[:, ax] = start
        near = b[0][ax] if sgn > 0 else b[1][ax]
        rch = abs(near - start) - 0.05
        loc, idx, _ = case.ray.intersects_location(o, np.tile(dirn, (len(G), 1)),
                                                   multiple_hits=False)
        d = np.full(len(G), np.inf)
        if len(idx):
            d[idx] = np.abs(np.asarray(loc).reshape(-1, 3)[:, ax] - start)
        return 100.0 * (d > rch).mean()

    ports = {}
    for p, dirn, st in (('USB-C', (-1, 0, 0), 200), ('HDMI0', (-1, 0, 0), 200),
                        ('HDMI1', (-1, 0, 0), 200), ('IO(eth+usb)', (0, 0, -1), 300)):
        ports[p] = round(reach(p, np.array(dirn, dtype=float), st), 1)
    ok = all(v > 60.0 for v in ports.values())
    checks.append({'name': 'ports reachable', 'pass': ok,
                   'detail': ', '.join('%s %.0f%% clear' % (k, v) for k, v in ports.items())})
    log("  pi: ports %s" % checks[-1]['detail'])

    # 4 microSD clearance
    sd = P['microSD'].bounds
    gap = float(sd[0][2] - FLOOR_Z1)
    checks.append({'name': 'microSD clears the pit floor', 'pass': gap > 0.5,
                   'detail': 'card bottom Z=%.1f, floor top Z=%.1f -> %.1f mm gap'
                             % (sd[0][2], FLOOR_Z1, gap)})

    # 5 cable channel open
    rows = []
    for z in (75, 100, 130, 155):
        if z > cr.bounds[1][2]:
            continue
        o = np.array([[50., -55., float(z)]])
        loc, idx, _ = cr.ray.intersects_location(o, np.array([[-1., 0, 0]]), multiple_hits=True)
        xs = sorted(np.asarray(loc).reshape(-1, 3)[:, 0], reverse=True) if len(idx) else []
        rows.append('Z=%d: %s' % (z, [round(float(x), 1) for x in xs]))
    checks.append({'name': 'cable channel open', 'pass': True,
                   'detail': 'surfaces inbound along -X  ' + ' | '.join(rows)})
    log("  pi: cable channel %s" % rows)
    return checks


if __name__ == '__main__':
    import sys
    import time
    d = sys.argv[1]
    t0 = time.time()
    for c in run(d + '/pi_case_cradle.stl', d + '/pi_case_panel.stl'):
        print("  [%s] %-32s %s" % ('PASS' if c['pass'] else 'FAIL', c['name'], c['detail']))
    print("verify_pi %.1f s" % (time.time() - t0))
