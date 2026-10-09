/* `npm run sim:export` and the Sim tab's "Download MJCF zip" of the default design are the same
 * model: scene.xml, every mesh file and the design hash byte for byte (the Pi case included,
 * which the page generates from its parameters). */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { unzipSync, strFromU8 } from 'fflate';
import { pageZip } from './page-zip.mjs';
import { readOut, STUDIO } from '../../sim/lib.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rps-parity-'));
const cli = spawnSync(process.execPath, [path.join(STUDIO, 'tools/sim/export.mjs'), '--robot', 'lekiwi-pincopen', '--out', dir],
  { cwd: STUDIO, encoding: 'utf8', timeout: 600000 });
const out = cli.status === 0 ? readOut(dir) : null;
const page = await pageZip({ lab: false });
const zip = unzipSync(page.zip);
page.session.free();
fs.rmSync(dir, { recursive: true, force: true });

const same = (a, b) => !!a && !!b && a.byteLength === b.byteLength && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

test('the CLI export ran', () => {
  assert.equal(cli.status, 0, (cli.stderr || '').slice(-400));
});

test('scene.xml is byte-identical', () => {
  assert.ok(same(Buffer.from(out.xml), zip['scene.xml']));
});

test('every mesh file is byte-identical, pi_case_cradle and pi_case_panel included', () => {
  const names = [...zip ? Object.keys(zip) : []].filter((k) => k.startsWith('meshes/')).map((k) => k.slice(7)).sort();
  assert.equal(names.join(','), [...out.meshes.keys()].sort().join(','));
  const differ = names.filter((n) => !same(out.meshes.get(n), zip['meshes/' + n]));
  assert.equal(differ.join(','), '');
  assert.ok(names.includes('pi_case_cradle.msh') && names.includes('pi_case_panel.msh'));
});

test('the design hash and the rest of scene.json agree (export timing aside)', () => {
  const a = out.sidecar, b = JSON.parse(strFromU8(zip['scene.json']));
  assert.equal(a.design_hash, page.session.hash);
  assert.equal(b.design_hash, page.session.hash);
  delete a.timing_ms;
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
