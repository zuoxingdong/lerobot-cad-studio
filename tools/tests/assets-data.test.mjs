// src/data/packed.js (the data npm run pack writes) and src/data/assets.js (the API over it), as the
// app ships them.  The ROBOTS / PARTS blobs are read out of packed.js as JSON; the API is checked by shape.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STUDIO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SITE = join(STUDIO, 'site');
const JS = join(STUDIO, 'src', 'data', 'packed.js');
const API = join(STUDIO, 'src', 'data', 'assets.js');
const MANIFEST = join(STUDIO, 'src', 'data', 'assets_manifest.json');
const BUDGET = 4e6;

const packed = existsSync(MANIFEST) && statSync(JS).size > 10000;

describe('packed asset data', { skip: packed ? false : 'not packed yet - run tools/build/pack_assets.py' }, () => {
  const src = readFileSync(JS, 'utf8');
  const blob = (name) => {
    const start = src.indexOf(`export const ${name} = `);
    return JSON.parse(src.slice(start + `export const ${name} = `.length, src.indexOf(';\n', start)));
  };
  const ROBOTS = blob('ROBOTS');
  const PARTS = blob('PARTS');
  const table = (owner) => (owner.startsWith('part:') ? PARTS[owner.slice(5)] : ROBOTS[owner]).meshes;
  const owners = [...Object.keys(ROBOTS), ...Object.keys(PARTS).map((p) => 'part:' + p)];
  const man = JSON.parse(readFileSync(MANIFEST, 'utf8'));

  test('every package and part made it in', () => {
    assert.deepEqual(Object.keys(ROBOTS), ['lekiwi', 'pincopen', 'lekiwi-pincopen']);
    assert.equal(ROBOTS.pincopen.manifest.kind, 'attachment', 'packed for the composition, never listed');
    assert.deepEqual(Object.keys(PARTS).sort(),
      ['cam_retainer', 'camera_shims', 'corner_mast_printed', 'df200_arch', 'pi_case_vertical']);
    assert.equal(ROBOTS['lekiwi-pincopen'].manifest.schema, 'rps/robot@2');
    for (const p of Object.values(PARTS)) assert.equal(p.part.schema, 'rps/part@1');
  });

  test('the API is exported, and the data module carries no code', () => {
    const api = readFileSync(API, 'utf8');
    for (const fn of ['loadGeometry', 'loadGeometryAsync', 'meshOwner', 'preloadAll',
                      'robotIds', 'isRobot', 'partIds', 'part', 'scene', 'isLoaded', 'manifest']) {
      assert.ok(api.includes(`export function ${fn}`) || api.includes(`export async function ${fn}`),
                `missing export ${fn}`);
    }
    assert.ok(api.includes("DecompressionStream('gzip')"), 'async path');
    assert.ok(api.includes("import { gunzipSync } from 'fflate'"), 'sync path');
    assert.ok(api.includes("import { ROBOTS, PARTS, SCENES } from './packed.js'"), 'the data');
    assert.ok(!/^(import|export (async )?function)\b/m.test(src), 'packed.js is data only');
  });

  test('every component and part mesh is packed, and every mesh_ref resolves', () => {
    for (const [rid, r] of Object.entries(ROBOTS)) {
      for (const c of r.manifest.components || []) {
        assert.ok(c.mesh, `${rid}/${c.id}: no mesh id`);
        assert.ok(r.meshes[c.mesh], `${rid}/${c.id}: mesh ${c.mesh} not packed`);
        assert.equal(c.transform, undefined, `${rid}/${c.id}: the packer computes no transforms`);
      }
    }
    for (const [pid, p] of Object.entries(PARTS)) {
      for (const m of p.part.meshes) if (m.file) assert.ok(p.meshes[m.id], `${pid}/${m.id} not packed`);
    }
    for (const owner of owners) {
      for (const [mid, m] of Object.entries(table(owner))) {
        assert.ok(m.faces > 0, `${owner}/${mid}: faces`);
        if (!m.mesh_ref) { assert.ok(m.stl_gz && m.stl_gz.length > 32, `${owner}/${mid}: stl_gz`); continue; }
        let [o, mi] = [owner, mid];
        for (let i = 0; i < 8; i++) {
          const e = table(o)[mi];
          if (!e.mesh_ref) break;
          const c = e.mesh_ref.lastIndexOf(':');
          o = e.mesh_ref.slice(0, c); mi = e.mesh_ref.slice(c + 1);
          assert.ok(table(o) && table(o)[mi], `${owner}/${mid}: dangling ref ${e.mesh_ref}`);
          assert.ok(i < 7, `${owner}/${mid}: mesh_ref cycle`);
        }
      }
    }
  });

  test('every part plate carries its fitted bed pose', () => {
    for (const [pid, p] of Object.entries(PARTS)) {
      for (const m of p.part.meshes) {
        if (!m.file || !m.print || m.print.startsWith('part:')) continue;
        assert.equal(m.print_transform.length, 16, `${pid}/${m.id}: print_transform`);
        assert.ok(m.print_fit_rmse_mm < 1e-3, `${pid}/${m.id}: rmse ${m.print_fit_rmse_mm}`);
        assert.equal(m.print_bbox_mm.length, 3);
      }
    }
  });

  test('instancing actually happened', () => {
    const lek = ROBOTS.lekiwi.meshes;
    const refs = Object.values(lek).filter((m) => m.mesh_ref).length;
    assert.ok(refs >= 5, `expected the wheels/servos/standoffs to be instanced, got ${refs} refs`);
  });

  test('every robot has an embedded PNG thumbnail; an attachment has none', () => {
    for (const [rid, r] of Object.entries(ROBOTS)) {
      if (r.manifest.kind === 'attachment') { assert.equal(r.thumbnail, null, `${rid}: an attachment is never a Home card`); continue; }
      assert.ok(r.thumbnail, `${rid}: no thumbnail`);
      const head = Buffer.from(r.thumbnail.slice(0, 16), 'base64');
      assert.equal(head.subarray(1, 4).toString('latin1'), 'PNG', `${rid}: not a PNG`);
    }
  });

  test('every stored mesh inflates to a binary STL with the face count it claims', () => {
    // proves the gzip payload is real, not just present - the same bytes loadGeometry() feeds
    // to STLLoader.  Checked on the biggest mesh of each package plus a random sample.
    const pick = [];
    for (const rid of owners) {
      const stored = Object.entries(table(rid)).filter(([, m]) => m.stl_gz);
      if (!stored.length) continue;
      stored.sort((a, b) => b[1].stl_gz.length - a[1].stl_gz.length);
      pick.push([rid, ...stored[0]]);
      if (stored.length > 3) pick.push([rid, ...stored[stored.length >> 1]]);
    }
    for (const [rid, mid, m] of pick) {
      const raw = gunzipSync(Buffer.from(m.stl_gz, 'base64'));
      assert.ok(raw.length >= 84, `${rid}/${mid}: too short`);
      const faces = raw.readUInt32LE(80);
      assert.equal(faces, m.faces, `${rid}/${mid}: header says ${faces} faces, manifest says ${m.faces}`);
      assert.equal(raw.length, 84 + 50 * faces, `${rid}/${mid}: STL length does not match its face count`);
      // vertices are snapped to 1/64 mm and must be finite, in a plausible millimetre range
      const v0 = raw.readFloatLE(84 + 12);
      assert.ok(Number.isFinite(v0) && Math.abs(v0) < 5000, `${rid}/${mid}: first vertex ${v0}`);
    }
  });

  test('the 4 MB asset-data budget holds', () => {
    assert.equal(man._summary.over_budget, false,
                 `${(man._summary.total_b64_bytes / 1e6).toFixed(2)} MB of base64`);
    assert.ok(man._summary.total_b64_bytes <= BUDGET);
  });

  test('decimation kept every body of the tricky parts', () => {
    // an omni wheel is one link made of many roller bodies; per-body decimation must not drop them
    const wheel = ROBOTS.lekiwi.meshes['4-Omni-Directional-Wheel_Single_Body-v1'];
    assert.ok(wheel.faces > 8000, `wheel is down to ${wheel.faces} faces`);
  });
});

test('the built page exists and is under the 8 MB budget', { skip: existsSync(join(SITE, 'index.html')) ? false : 'not built yet' }, () => {
  const n = statSync(join(SITE, 'index.html')).size;
  assert.ok(n < 8e6, `${(n / 1e6).toFixed(2)} MB`);
});
