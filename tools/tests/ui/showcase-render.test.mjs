/* node --test tools/tests/ui/showcase-render.test.mjs   (run from studio/)
   The showcase's tier policy: the drawing-buffer caps per tier, the low fallback without float render
   targets, and the LEDs' emission cap (the patch, and the lightmapped patch keeping it). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TIERS, pixelRatio, floatTargets, usableTier } from '../../../src/ui/showcase-render.js';
import { Looks, lightmapped, emitCapped, EMIT_CAP } from '../../../src/ui/showcase-looks.js';

const gl = (exts) => ({ extensions: { has: (n) => exts.includes(n) } });

test('the pixel ratio: capped by the tier dpr and its drawing-buffer budget', () => {
  assert.equal(pixelRatio(TIERS.high, 1, 1920, 1080), 1);
  assert.equal(pixelRatio(TIERS.high, 2, 800, 600), 1.5);
  assert.equal(pixelRatio(TIERS.medium, 2, 800, 600), 1.25);
  assert.equal(pixelRatio(TIERS.low, 3, 390, 844), 0.75);
  for (const [n, T] of [['high', TIERS.high], ['medium', TIERS.medium]]) {
    const p = pixelRatio(T, 2, 2560, 1440);
    assert.ok(p * p * 2560 * 1440 <= T.px + 1, `${n}: ${(p * p * 2560 * 1440 / 1e6).toFixed(1)} Mpx`);
  }
});

test('no float render targets: the HDR tiers fall back to low', () => {
  const none = gl([]), full = gl(['EXT_color_buffer_float']), half = gl(['EXT_color_buffer_half_float']);
  assert.equal(floatTargets(none), false);
  assert.ok(floatTargets(full) && floatTargets(half));
  for (const t of ['high', 'medium', 'low']) assert.equal(usableTier(t, none), 'low');
  assert.deepEqual(['high', 'medium', 'low'].map((t) => usableTier(t, full)), ['high', 'medium', 'low']);
  assert.equal(usableTier('nope', full), 'medium');
  assert.ok(TIERS.low.post === false && TIERS.high.post && TIERS.medium.post);
});

test('the LEDs: the emission is scaled to EMIT_CAP by its peak channel, also when lightmapped', () => {
  const L = new Looks({ led_off: { base: [0.7, 0.7, 0.7], rough: 0.3 }, wall: { base: [0.7, 0.7, 0.7] } }, {});
  const led = L.get('led_off~tint', [0.2, 1, 0.45, 0.9], true), wall = L.get('wall');
  assert.ok(led.userData.emitCap && !wall.userData.emitCap);
  const src = '#include <emissivemap_fragment>\n#include <lights_fragment_maps>\nvoid main() {}';
  const sh = { uniforms: {}, fragmentShader: src };
  led.onBeforeCompile(sh);
  assert.equal(sh.uniforms.rpsEmitCap, EMIT_CAP);
  assert.match(sh.fragmentShader, /totalEmissiveRadiance \*= min\( 1\.0, rpsEmitCap/);
  const lm = { uniforms: {}, fragmentShader: src };
  lightmapped(emitCapped(new THREE.MeshStandardMaterial()), 0.4).onBeforeCompile(lm);
  assert.ok(lm.uniforms.rpsEmitCap && lm.uniforms.rpsAlbedo && lm.fragmentShader.includes('rpsEmitCap /'));
  assert.equal(lightmapped(new THREE.MeshStandardMaterial()).customProgramCacheKey(), 'rps-lightmapped');
});
