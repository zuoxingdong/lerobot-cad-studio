#!/usr/bin/env python3
"""Build every CadQuery part at its defaults and verify it.

    uv run --extra cad python tools/cad/selftest.py [--keep]

One part at a time: parallel CadQuery/trimesh work has OOM-killed this machine.
Exit 0 = every part built and was verified, 1 = a generator raised, 2 = nothing was verified.
"""
import argparse
import json
import os
import shutil
import sys
import tempfile
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

BED = 256.0                      # Bambu P1/X1 bed, for the "fits the bed" check
# print orientation per mesh: '' as built, 'flat' +90 deg about X, 'flip' 180 deg about X
PRINT_MODE = {'pi_case_cradle': '', 'pi_case_panel': 'flat'}
PARTS = {
    'pi_case': dict(meshes=['pi_case_cradle', 'pi_case_panel']),
}


def build_part(part, out, log=print):
    """Build one part into `out` and verify it -> {'checks': [...], 'meshes': [...]}."""
    import common
    import gen_pi_case
    import verify_pi
    if part != 'pi_case':
        raise ValueError(part)
    info = gen_pi_case.build({}, out, log=log)
    checks, meshes = [], []
    for name in PARTS[part]['meshes']:
        fp = info['files'][name]
        _, mi = common.mesh_info(fp)
        bed = common.print_orient(fp, os.path.join(out, name + '_PRINT.stl'), PRINT_MODE.get(name, ''))
        meshes.append(dict(name=name, volume_cm3=mi['volume_cm3'], bed_size=bed))
        checks.append({'name': '%s mesh is a closed solid' % name, 'pass': mi['watertight'],
                       'detail': 'watertight=%s bodies=%d faces=%d vol=%.2f cm3'
                                 % (mi['watertight'], mi['body_count'], mi['faces'], mi['volume_cm3'])})
        checks.append({'name': '%s is a single body' % name, 'pass': mi['body_count'] == 1,
                       'detail': '%d body(ies)' % mi['body_count']})
        checks.append({'name': '%s fits a %.0f mm bed' % (name, BED),
                       'pass': all(x <= BED for x in bed),
                       'detail': 'bed footprint %.0f x %.0f x %.0f mm' % tuple(bed)})
        if name in info.get('valid', {}):
            checks.append({'name': '%s CadQuery solid is valid' % name, 'pass': bool(info['valid'][name]),
                           'detail': 'OCC isValid=%s, solid volume %.2f cm3'
                                     % (info['valid'][name], info['solid_volume_cm3'][name])})
    checks += verify_pi.run(info['files']['pi_case_cradle'], info['files']['pi_case_panel'], log=log)
    with open(os.path.join(out, 'report.json'), 'w') as f:
        json.dump({'part': part, 'checks': checks, 'meshes': meshes}, f, indent=1)
    return {'checks': checks, 'meshes': meshes}


def selftest(keep=False):
    print("LeRobot CAD Studio CAD selftest (every part at its defaults)\n" + "=" * 78)
    t_all = time.time()
    rows, failed, ok_all = [], [], True
    for part in sorted(PARTS):
        print("\n### %s" % part)
        out = tempfile.mkdtemp(prefix='rps-cad-%s-' % part)
        t0 = time.time()
        try:
            res = build_part(part, out)
        except Exception:
            ok_all = False
            traceback.print_exc()
            rows.append((part, time.time() - t0, 0, 0, out))
            continue
        for c in res['checks']:
            print("   [%s] %-52s %s" % ('PASS' if c['pass'] else 'FAIL', c['name'], c['detail']))
            if not c['pass']:
                failed.append((part, c['name'], c['detail']))
        for m in res['meshes']:
            print("   mesh %-22s %7.2f cm3  bed %5.0f x %5.0f x %5.0f"
                  % (m['name'], m['volume_cm3'], m['bed_size'][0], m['bed_size'][1], m['bed_size'][2]))
        passed = sum(1 for c in res['checks'] if c['pass'])
        rows.append((part, time.time() - t0, passed, len(res['checks']), out))
        if not keep:
            shutil.rmtree(out, ignore_errors=True)
    print("\n" + "=" * 78)
    print("%-18s %8s %10s   %s" % ('part', 'seconds', 'checks', 'dir'))
    for part, dt, p, t, d in rows:
        print("%-18s %8.1f %6d/%-3d   %s" % (part, dt, p, t, d if keep else '-'))
    print("total %.1f s   every part built and verified: %s" % (time.time() - t_all, ok_all))
    if failed:
        print("\nchecks that FAIL at the as-printed defaults (design findings, not tool errors):")
        for part, name, detail in failed:
            print("  %-16s %s\n%s%s" % (part, name, ' ' * 19, detail))
    if not ok_all:
        return 1
    # A run that asserted nothing is not a pass (a missing optional dependency reads 0/0).
    checks_run = sum(total for _, _, _, total, _ in rows)
    if not rows or checks_run == 0:
        print("\nSELFTEST INCONCLUSIVE: %d part(s), %d checks run - nothing was verified.\n"
              "Install the cad extra first: uv sync --extra cad" % (len(rows), checks_run))
        return 2
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--keep', action='store_true', help='keep the build directories')
    ap.add_argument('--selftest', action='store_true', help='accepted for compatibility; always on')
    sys.exit(selftest(keep=ap.parse_args().keep))


if __name__ == '__main__':
    main()
