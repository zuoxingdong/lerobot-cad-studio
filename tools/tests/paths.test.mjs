/* node --test tools/tests/paths.test.mjs   (run from studio/)
   The out/ layout: the products at the top level, the rest under out/work/; tools/paths.py and
   tools/paths.mjs agree, and no source names an out/ subdir of its own. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as P from '../paths.mjs';
import { ROOT } from './_root.mjs';

const DIRS = ['WORK', 'CACHE', 'RENDER', 'SIM', 'E2E'];

test('the products sit at the out/ top level, everything else under out/work/', () => {
  assert.equal(P.STUDIO, ROOT);
  assert.equal(P.OUT, path.join(ROOT, 'out'));
  assert.equal(P.WORK, path.join(P.OUT, 'work'));
  for (const k of DIRS.slice(1)) assert.equal(path.dirname(P[k]), P.WORK, k);
  assert.deepEqual([...P.PRODUCTS].sort(),
    ['draft.mp4', 'hero.mp4', 'hero_web.mp4', 'lab-task.mp4', 'sim-report.md', 'teleop.mp4']);
});

test('tools/paths.py is the twin of tools/paths.mjs', () => {
  const py = 'import json, sys; sys.path.insert(0, "tools"); import paths as P; '
    + `print(json.dumps({k: getattr(P, k) for k in ${JSON.stringify(['STUDIO', 'OUT', ...DIRS, 'PRODUCTS'])}}))`;
  const got = JSON.parse(execFileSync('python3', ['-c', py], { cwd: ROOT, encoding: 'utf8' }));
  for (const [k, v] of Object.entries(got)) assert.deepEqual(v, P[k], k);
});

test('no source hard-codes an out/ subdir (they import tools/paths)', () => {
  const OLD = [/\bout\/(render|sim|cache|e2e)(?![\w-])/, /join\([^)\n]*['"]out['"]/];
  const EXT = /\.(py|mjs|js|json|md|yml|sh|toml|html)$/;
  const SKIP = new Set(['node_modules', 'out', 'site', '.venv', '__pycache__', '.pytest_cache', 'fixtures']);
  const files = ['README.md', 'package.json', '.gitignore'];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(f); } else if (EXT.test(e.name)) files.push(f);
    }
  };
  for (const d of ['tools', 'src', '.github']) if (fs.existsSync(path.join(ROOT, d))) walk(d);
  const bad = [];
  for (const f of files) {
    if (/^tools\/(paths\.(py|mjs)|tests\/paths\.test\.mjs)$/.test(f)) continue;
    fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
      if (OLD.some((re) => re.test(line))) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.ok(files.length > 100, 'walked ' + files.length);
  assert.deepEqual(bad, []);
});
