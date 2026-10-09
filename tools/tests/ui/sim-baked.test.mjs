/* node --test tools/tests/ui/sim-baked.test.mjs   (run from studio/)
   The Sim tab's baked lab: the committed static set split into cut-away zones (every triangle once, in
   room mm, the four walls of lab.room, nothing on a plinth cut, the floor never cut, decals only on the
   floor), the one-pass unlit patch, and the three names the lazy bundle takes from the page. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SITE } from '../_root.mjs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { splitSet } from '../../../src/ui/sim-baked.js';
import { unlit, isBaked } from '../../../src/ui/baked-lab.js';
import { THREE_VENDOR } from '../../../src/ui/three-vendor.js';
import { sceneDoc, labLayout } from '../../../src/features/sim-scene.js';

const WEB = path.join(SITE, 'lab');
const M = existsSync(path.join(WEB, 'manifest.json')) ? JSON.parse(readFileSync(path.join(WEB, 'manifest.json'), 'utf8')) : null;
const skip = !isBaked(M) && 'no bake committed';
const lab = labLayout(await sceneDoc('lab'), 277.33);

async function labScene() {
  await MeshoptDecoder.ready;
  const b = readFileSync(path.join(WEB, M.lab.file));
  const gltf = await new Promise((res, rej) => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
    .parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '', res, rej));
  return gltf.scene;
}
const tris = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;

test('the static set splits into zones: every triangle once, in room mm', { skip }, async () => {
  const scene = await labScene();
  let want = 0;
  scene.traverse((o) => { if (o.isMesh) want += tris(o.geometry); });
  const set = splitSet(scene, M, lab);
  assert.equal(set.reduce((n, x) => n + tris(x.geometry), 0), want, 'triangles lost or doubled');
  const box = new THREE.Box3();
  for (const x of set) { x.geometry.computeBoundingBox(); box.union(x.geometry.boundingBox); }
  assert.ok(box.min.x <= lab.room.x[0] + 10 && box.max.y >= lab.room.y[1] - 10 && box.max.z > 2600, `set box ${box.min.toArray()} .. ${box.max.toArray()} (mm)`);
  const walls = new Set(set.flatMap((x) => x.walls.map((w) => w.a + w.s)));
  assert.deepEqual([...walls].sort(), ['x-1', 'x1', 'y-1', 'y1'], 'the four walls of lab.room');
});

test('nothing on a plinth is cut, the floor is never cut, decals lie on the floor', { skip }, async () => {
  const set = splitSet(await labScene(), M, lab);
  for (const x of set) {
    const b = x.geometry.boundingBox || (x.geometry.computeBoundingBox(), x.geometry.boundingBox);
    const on = lab.stations.find((s) => b.min.x > s.plinth_rect.x[0] && b.max.x < s.plinth_rect.x[1] && b.min.y > s.plinth_rect.y[0] && b.max.y < s.plinth_rect.y[1]);
    if (on) assert.equal(x.zone, '', `${x.name} on the ${on.id} plinth is in zone ${x.zone}`);
    if (x.decal) assert.ok(b.max.z <= 3, `${x.name}: a decal at z ${b.max.z.toFixed(1)} mm`);
  }
  const floor = set.filter((x) => x.info.mat === 'floor_vinyl' && x.info.lm === 1);
  assert.ok(floor.length === 1 && floor[0].zone === '' && !floor[0].decal, 'the floor: ' + floor.map((x) => `${x.zone}|${x.decal}`).join());
  assert.ok(set.some((x) => x.decal && /tape|hazard/.test(x.info.mat)), 'no floor tape offset');
});

test('unlit: the direct lights compile out, the lightmap patch stays', () => {
  const m = new THREE.MeshStandardMaterial();
  m.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_maps>', '/* maps */'); };
  unlit(m);
  const sh = { uniforms: {}, fragmentShader: '#include <lights_fragment_begin>\n#include <lights_fragment_maps>' };
  m.onBeforeCompile(sh);
  assert.ok(sh.fragmentShader.includes('/* maps */'), 'the earlier patch was dropped');
  assert.ok(!/NUM_(DIR|POINT|SPOT|HEMI|RECT_AREA)_LIGHTS > 0/.test(sh.fragmentShader), 'a direct light survives');
  assert.ok(sh.fragmentShader.includes('RE_IndirectSpecular'), 'the indirect part is gone');
  assert.ok(m.customProgramCacheKey().endsWith('|unlit'));
});

test('three-vendor.js hands the lazy bundle real three exports', () => {
  const missing = Object.entries(THREE_VENDOR).filter(([, v]) => v === undefined).map(([k]) => k);
  assert.deepEqual(missing, []);
  assert.ok(Object.keys(THREE_VENDOR).length > 90);
});
