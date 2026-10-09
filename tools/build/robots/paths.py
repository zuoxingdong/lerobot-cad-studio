"""Every path, pin and shared input the asset generators read.  Imports nothing of our own."""
import json
import os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))    # tools/build
STUDIO = os.path.dirname(os.path.dirname(HERE))
ASSETS = os.path.join(STUDIO, 'assets')
ROBOTS = os.path.join(ASSETS, 'robots')
PARTS = os.path.join(ASSETS, 'parts')
# Committed generator inputs: the earlier studio's profile (measured frames: deck grid, pan
# axis, reach disc, mast camera, wrist mount), the PincOpen registration and the print-file
# match cache.  RPS_V3_PROFILE overrides the profile.
INPUTS = os.path.join(HERE, 'inputs')
V3_PROFILE = os.environ.get('RPS_V3_PROFILE') or os.path.join(INPUTS, 'v3-profile-lekiwi.json')
REG_JSON = os.path.join(INPUTS, 'pincopen_registration.json')
PRINT_MATCH = os.path.join(INPUTS, 'print_match.json')
PRINT_MATCH_SCHEMA = 'rps/print-match@2'   # @2 = the derived bed pose per plate

LEKIWI_COMMIT = 'efa608d7ee5a495a4803b1d28cd0c955b4f1e033'
PINCOPEN_COMMIT = '1b5a3dc83cb4eae042d535bda3765b9e12a9b8a7'
FETCHED = '2026-09-13'

if not os.path.exists(V3_PROFILE):
    raise SystemExit('make_robots.py cannot find the v3 profile %r (committed under '
                     'tools/build/inputs/); restore it, or point RPS_V3_PROFILE at a copy.'
                     % V3_PROFILE)
PROF = json.load(open(V3_PROFILE))


def rel(path):
    """`path` relative to studio/, the spelling every message and record uses."""
    return os.path.relpath(path, STUDIO)
