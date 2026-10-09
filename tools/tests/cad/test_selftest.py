#!/usr/bin/env python3
"""`selftest.py` must not report a green 0/0.

    npm run cad:test

The build is stubbed, so nothing here imports cadquery or trimesh.
"""
import io
import os
import unittest
from contextlib import redirect_stdout
from unittest import mock

CAD = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "cad"))

import selftest                          # noqa: E402


def run(parts, build):
    """selftest() over `parts`, with build_part stubbed; returns (exit code, stdout)."""
    buf = io.StringIO()
    with mock.patch.object(selftest, 'PARTS', parts), \
         mock.patch.object(selftest, 'build_part', build), \
         redirect_stdout(buf):
        code = selftest.selftest()
    return code, buf.getvalue()


def result(checks):
    return lambda part, out: {'checks': checks, 'meshes': []}


PASSING = [{'name': 'a', 'pass': True, 'detail': ''}]


class TestSelftestExitCode(unittest.TestCase):
    def test_zero_checks_is_not_a_pass(self):
        """Every part builds, nothing is verified: 0/0."""
        code, out = run({'pi_case': {}}, result([]))
        self.assertEqual(code, 2, 'a selftest that asserted nothing exited 0')
        self.assertIn('INCONCLUSIVE', out)
        self.assertIn('0 checks run', out)

    def test_no_parts_is_not_a_pass(self):
        code, out = run({}, result(PASSING))
        self.assertEqual(code, 2)
        self.assertIn('0 part(s), 0 checks run', out)

    def test_checks_that_ran_and_passed(self):
        code, out = run({'pi_case': {}}, result(PASSING))
        self.assertEqual(code, 0)
        self.assertNotIn('INCONCLUSIVE', out)

    def test_a_failed_check_is_a_design_finding_not_an_error(self):
        code, out = run({'pi_case': {}}, result([{'name': 'a', 'pass': False, 'detail': 'x'}]))
        self.assertEqual(code, 0)
        self.assertIn('checks that FAIL at the as-printed defaults', out)

    def test_a_generator_that_raises_exits_1(self):
        def boom(part, out):
            raise RuntimeError('no cadquery')
        code, _ = run({'pi_case': {}}, boom)
        self.assertEqual(code, 1)


if __name__ == '__main__':
    unittest.main()
