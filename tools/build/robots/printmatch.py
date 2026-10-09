"""Which upstream print file is the same part as a display mesh, and in which bed pose.

Loads ~70 MB of STL through trimesh, so the answer is cached in tools/build/inputs/print_match.json.
"""
import json
import os

import numpy as np

from packlib.atomic import write_json
from packlib.printfit import plate_transform
from .paths import PRINT_MATCH, PRINT_MATCH_SCHEMA
from .urdf import cm, log

def match_print_files(mesh_dir, print_dir, links, vis):
    """link -> the print file that is the same part (volume <=0.5 %, extents confirmed) + its pose."""
    # The cache is keyed by PRINT_MATCH_SCHEMA, so one written before the bed pose existed is
    # rebuilt rather than silently believed.
    if os.path.exists(PRINT_MATCH):
        cached = json.load(open(PRINT_MATCH))
        if cached.get('schema') == PRINT_MATCH_SCHEMA:
            return cached['links']
        log('   print-match cache is older than the bed-pose fit - rebuilding it')
    import trimesh
    log('   matching print files by volume (this loads every mesh once)...')
    prints = []
    for dirpath, _, files in os.walk(print_dir):
        for fn in files:
            if not fn.lower().endswith('.stl'):
                continue
            fp = os.path.join(dirpath, fn)
            try:
                m = trimesh.load(fp)
            except Exception:
                continue
            prints.append((os.path.relpath(fp, print_dir), abs(float(m.volume)),
                           np.sort(np.asarray(m.extents, float))))
            del m
    out = {}
    for link in links:
        f = vis[link]['file']
        fp = os.path.join(mesh_dir, f)
        if not os.path.exists(fp):
            continue
        m = trimesh.load(fp)
        v, e = abs(float(m.volume)), np.sort(np.asarray(m.extents, float))
        del m
        best = None
        for rel, pv, pe in prints:
            if v <= 0 or abs(pv - v) / max(pv, v) > 0.005:
                continue
            de = float(np.abs(pe - e).max())
            if de > 0.5:
                continue
            if best is None or de < best[1]:
                best = (rel, de, abs(pv - v) / max(pv, v))
        if best:
            out[link] = dict(file=best[0], extent_delta_mm=round(best[1], 4),
                             volume_delta_pct=round(best[2] * 100, 4))
    # the bed pose each plate states, derived and then PROVED on the plate's own surface
    posed = 0
    for link, p in out.items():
        fit = plate_transform(os.path.join(mesh_dir, vis[link]['file']),
                              os.path.join(print_dir, p['file']))
        if not fit:
            log('   !! %s: %s is not a rigid image of the visual mesh - no bed pose stated'
                % (link, p['file']))
            continue
        p['print_transform'], p['print_fit_worst_mm'], p['print_fit_rmse_mm'], p['print_bbox_mm'] = fit
        posed += 1
    write_json(PRINT_MATCH, dict(schema=PRINT_MATCH_SCHEMA, links=out))
    log('   %d of %d links have a 3DPrintMeshes twin (%d state a bed pose)'
        % (len(out), len(links), posed))
    return out
