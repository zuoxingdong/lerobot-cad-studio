#!/usr/bin/env python3
"""Generate assets/robots/*/robot.json and assets/parts/*/part.json.

    nice -n 10 python3 tools/build/make_robots.py [--only lekiwi|pincopen|parts|lekiwi-pincopen]

  assets/robots/lekiwi/robot.json           rps/robot@1, from its URDF + tools/build/inputs/
  assets/robots/pincopen/robot.json         rps/robot@1 attachment (never a robot of its own), from
                                            inputs/pincopen_registration.json
  assets/parts/<id>/part.json               rps/part@1, from the committed meshes (+ record.json)
  assets/robots/lekiwi-pincopen/robot.json  rps/robot@2: lekiwi + pincopen + parts, by reference

Nothing here invents a number: every pose is read out of the URDF, carried over from the v3
profile with its provenance, produced by registration, or measured on a committed mesh.
Robot frame, millimetres, +X right, +Y forward, +Z up.  Matrices are COLUMN-MAJOR 16.
Every input is inside studio/.
"""
import argparse
import json
import os

from robots import ROBOTS, build_composition, build_lekiwi, build_parts, write_pincopen


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='all',
                    choices=['all', 'lekiwi', 'pincopen', 'parts', 'lekiwi-pincopen'])
    a = ap.parse_args()
    lek = pinc = None
    if a.only in ('all', 'lekiwi'):
        lek = build_lekiwi()
    if a.only in ('all', 'pincopen'):
        pinc = write_pincopen()
    if a.only in ('all', 'parts'):
        build_parts()
    if a.only in ('all', 'lekiwi-pincopen'):
        if lek is None:
            lek = json.load(open(os.path.join(ROBOTS, 'lekiwi', 'robot.json')))
        build_composition(lek, pinc)


if __name__ == '__main__':
    main()
