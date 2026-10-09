/* node --test tools/tests/ui/showcase-baked.test.mjs   (run from studio/)
   The baked path of the showcase: the lightmapped-material patch, the metal satin rule, the reader hood's
   tint gate (looks.py tint_gate), the clear-medium liquids, the shared film grade, and the committed
   manifest's lightmap, normal-map, probe and white-balance blocks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SITE } from '../_root.mjs';
import * as THREE from 'three';
import { Looks, lightmapped } from '../../../src/ui/showcase-looks.js';
import { gradeChunk, wbMatrix } from '../../../src/ui/showcase-render.js';

const WEB = path.join(SITE, 'lab');

test('lightmapped: the lightmap is the diffuse, the probe keeps only an occluded specular', () => {
  const m = lightmapped(new THREE.MeshStandardMaterial(), 0.3);
  const sh = { uniforms: {}, fragmentShader: '#include <lights_fragment_maps>\nvoid main() {}' };
  m.onBeforeCompile(sh);
  assert.ok(!sh.fragmentShader.includes('#include <lights_fragment_maps>'), 'the chunk was not replaced');
  assert.ok(!sh.fragmentShader.includes('iblIrradiance +='), 'the probe still adds diffuse');
  assert.ok(sh.fragmentShader.includes('rpsOcc * getIBLRadiance'), 'the specular is not occluded');
  assert.equal(sh.uniforms.rpsAlbedo.value, 0.3);
  assert.equal(m.customProgramCacheKey(), 'rps-lightmapped');
});

test('metals are satined on the web (one probe, no roughness maps)', () => {
  const L = new Looks({ alu: { base: [0.9, 0.9, 0.9], metal: 1, rough: 0.2 }, wall: { base: [0.7, 0.7, 0.7], rough: 0.85 } }, {});
  assert.ok(L.get('alu').roughness >= 0.42);
  assert.equal(L.get('wall').roughness, 0.85);
});

test('the tint gate keeps an idle colour dark and lights the read colour', () => {
  const L = new Looks({ glow_off: { base: [0.035, 0.036, 0.04], rough: 0.5, tint_nits: 400, tint_gate: [0.06, 0.25] } }, {});
  const m = L.get('glow_off~tint', [0.1, 0.2, 0.4, 0.9], true);
  Looks.paint(m, [0.14, 0.22, 0.36], 0.9, m.userData.tint);       // the capture's idle colour (display sRGB)
  assert.equal(m.emissiveIntensity, 0, 'idle glows');
  assert.ok(Math.abs(m.color.r - 0.035) < 1e-6, 'idle base is not the off grey');
  Looks.paint(m, [0.45, 0.62, 1.0], 0.9, m.userData.tint);        // a bright read colour
  assert.ok(Math.abs(m.emissiveIntensity - 0.9 * 400 / 683) < 1e-6, `read ${m.emissiveIntensity}`);
});

test('a clear liquid without the transmission pass: a faint dark film, no glow unless tinted and lit', () => {
  const spec = { base: [1, 1, 1], rough: 0, transmission: 1, ior: 1.333, volume: { color: [0.975, 0.96, 0.86], density: 100 } };
  const L = new Looks({ liquid: spec }, {}, { transmission: false });
  const m = L.get('liquid');
  assert.ok(m.transparent && m.opacity < 0.3 && !m.depthWrite, `opacity ${m.opacity}`);
  assert.ok(Math.max(m.color.r, m.color.g, m.color.b) < 0.1 && m.color.b < m.color.r, 'the film is not a dark warm tint');
  assert.equal(m.emissiveIntensity * Math.max(m.emissive.r, m.emissive.g, m.emissive.b), 0, 'an untinted liquid glows');
  const t = L.get('liquid~tint', [0.6, 0.8, 0.5, 0], true);
  Looks.paint(t, [0.8, 0.9, 0.7], 0, t.userData.tint);
  assert.equal(t.emissiveIntensity, 0, 'the idle tinted liquid glows');
  assert.ok(t.color.g < 0.1, `painted colour ${t.color.g}`);
  Looks.paint(t, [0.3, 1, 0.4], 0.9, t.userData.tint);
  assert.ok(t.emissiveIntensity > 0, 'the read tube does not glow');
  assert.ok(new Looks({ liquid: spec }, {}, { transmission: true }).get('liquid').transmission === 1, 'real transmission on request');
});

test('one film grade: the white balance inside the Neutral tone map, Blender\'s matrix first', () => {
  const W = [[0.87, -0.22, -0.04], [0.01, 1.07, -0.01], [0.02, 0.07, 1.75]];
  assert.deepEqual(wbMatrix({ wb: W, white_balance_k: 4000 }), W);
  const d = wbMatrix({ white_balance_k: 4000 });
  assert.ok(d[0][0] < 1 && d[1][1] === 1 && d[2][2] > 1 && d[0][1] === 0, 'the kelvin fallback is not a diagonal gain');
  assert.deepEqual(wbMatrix({ wb: W }, false), [[1, 0, 0], [0, 1, 0], [0, 0, 1]], 'the stand-in is balanced already');
  const src = gradeChunk(W, THREE.ShaderChunk.tonemapping_pars_fragment);
  const body = src.slice(src.indexOf('vec3 NeutralToneMapping( vec3 color ) {'));
  const cols = /mat3\( ([^)]*) \) \* color;/.exec(body);
  assert.ok(cols && body.indexOf(cols[0]) < body.indexOf('toneMappingExposure'), 'the matrix is not the first step');
  const v = cols[1].split(',').map(Number);                         // column-major: v[3 * j + i] = W[i][j]
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) assert.ok(Math.abs(v[3 * j + i] - W[i][j]) < 1e-6);
  assert.throws(() => gradeChunk(W, 'vec3 AgXToneMapping( vec3 color ) {}'));
});

test('the committed manifest: lightmaps, probe and lightmapped nodes agree', { skip: !existsSync(path.join(WEB, 'manifest.json')) }, () => {
  const M = JSON.parse(readFileSync(path.join(WEB, 'manifest.json'), 'utf8'));
  assert.equal(M.stand_in, false, 'the committed manifest is an unbaked stand-in; site/lab/ is frozen output');
  const files = new Map(M.files.map((f) => [f.name, f]));
  assert.ok(M.lightmaps.length >= 1 && M.probe && files.has(M.probe.file));
  for (const l of M.lightmaps) {
    assert.ok(files.has(l.file), l.file);
    assert.ok(l.scale > 0 && l.channel === 0 && l.srgb === true, l.file);
    if (l.normal) assert.ok(files.has(l.normal.file) && l.normal.res >= l.res, l.normal.file);
  }
  const W = M.film.wb;
  assert.ok(Array.isArray(W) && W.length === 3 && W.every((r) => r.length === 3), 'no white-balance matrix');
  assert.ok(W[0].reduce((a, b) => a + b) < W[1].reduce((a, b) => a + b) && W[2].reduce((a, b) => a + b) > 1, 'a warm key is not cooled');
  const lm = Object.values(M.lab.nodes).filter((n) => n.lm !== undefined);
  assert.ok(lm.length > 20, `${lm.length} lightmapped nodes`);
  for (const n of lm) {
    assert.ok(n.lm < M.lightmaps.length, `lm ${n.lm}`);
    assert.ok(n.alb > 0 && n.alb <= 1, `alb ${n.alb}`);
    assert.ok(M.materials[n.mat.split('~')[0]], n.mat);
  }
  assert.ok(Object.values(M.lab.nodes).some((n) => n.catcher), 'no shadow catchers');
});
