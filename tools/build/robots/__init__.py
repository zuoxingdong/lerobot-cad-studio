"""The asset generators behind tools/build/make_robots.py, one module per concern.

A REGULAR package (this file must exist), so it is never confused with a data directory of
the same name on sys.path.
"""
from .composition import build_composition
from .lekiwi import build_lekiwi
from .parts import build_parts
from .paths import PARTS, ROBOTS
from .pincopen import write_pincopen

__all__ = ['PARTS', 'ROBOTS', 'build_composition', 'build_lekiwi', 'build_parts', 'write_pincopen']
