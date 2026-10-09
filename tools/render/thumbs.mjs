// The Home thumbnails, step 1: each robot's default design at the stowed pose as world-space triangles,
// one file per visible part named like the sim's visual geoms (`vis_<id>`), so looks.json's robot rules apply.
//   node tools/render/thumbs.mjs [--out DIR]      then: python3 tools/render/blender.py thumb --in DIR
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { loadStudio } from '../sim/lib.mjs';
import { visibilityFor } from '../../src/features/slot-options.js';
import { sane } from '../../src/features/sim-mjcf.js';
import { RENDER } from '../paths.mjs';

export const ROBOTS = ['lekiwi', 'lekiwi-pincopen'];
const argv = process.argv.slice(2);
const OUT = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(RENDER, 'thumbs'));

/** world-space float32 triangles (m) of one geometry under matrix M (mm) */
function triangles(geo, M) {
  const pos = geo.attributes.position, idx = geo.index;
  const n = idx ? idx.count : pos.count;
  const out = new Float32Array(n * 3), v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(M).multiplyScalar(0.001);
    out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
  }
  return out;
}

for (const robot of ROBOTS) {
  const { model, slots, design, geometry } = await loadStudio(robot);
  const stowed = (model.manifest.presets || []).find((p) => p.id === 'stowed');
  if (stowed) model.setJoints(stowed.q);
  const vis = visibilityFor(model, slots, design);
  const dir = path.join(OUT, robot);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const parts = [];
  for (const c of model.components) {
    if (!vis.get(c.id)) continue;
    const geo = geometry.get(c.id) || (await model.geometryFor(c.id));
    if (!geo || !geo.attributes || !geo.attributes.position) continue;
    const tri = triangles(geo, model.worldMatrix(c.id));
    const name = 'vis_' + sane(c.id);
    fs.writeFileSync(path.join(dir, name + '.f32'), Buffer.from(tri.buffer));
    parts.push({ name, file: name + '.f32', triangles: tri.length / 9 });
  }
  fs.writeFileSync(path.join(dir, 'parts.json'), JSON.stringify({ robot, pose: stowed ? 'stowed' : 'zero', parts }, null, 1) + '\n');
  console.log(`${robot}: ${parts.length} parts, ${parts.reduce((a, p) => a + p.triangles, 0)} triangles -> ${path.relative(process.cwd(), dir)}`);
}
