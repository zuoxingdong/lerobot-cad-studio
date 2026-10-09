// Node side of the sim tools: the studio's own model for a robot + design, and an export dir's layout
//   <out>/scene.xml  meshes/<name>.msh  scene.json  design.json  [report.json ctrl.f32 report.md]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pkg from '../../src/core/package.js';
import { defaultDesign } from '../../src/core/store.js';
import { buildSlots } from '../../src/features/slots.js';
import { createPartOps } from '../../src/features/part-ops.js';
import { sceneDoc } from '../../src/features/sim-scene.js';
import { applyParametrics } from '../../src/features/sim-design.js';
import { opsBase } from '../../src/features/parts.js';
import { parseObj, decorXml, meshFiles, labAnim } from '../../src/features/sim-scene-decor.js';

export const STUDIO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** {model, slots, design, scene, geometry, labScene} as the page holds them: parametric parts
    regenerated, `design.parts[id].ops` applied, the lab decor on. */
export async function loadStudio(robot, designPath = null) {
  const robots = await pkg.listEmbedded();
  if (!robots.includes(robot)) throw new Error(`"${robot}" is not a robot; pick one of ${robots.join(', ')}`);
  const model = await pkg.loadEmbedded(robot, { loadGeometry: true });
  const slots = buildSlots(model);
  let design;
  if (designPath) {
    const d = JSON.parse(fs.readFileSync(designPath, 'utf8'));
    if (d.robot && d.robot !== robot) throw new Error(`design is for "${d.robot}", not "${robot}"`);
    design = slots.reconcile({ ...defaultDesign(robot), ...d, robot }).design;
  } else design = slots.applyDefaults(defaultDesign(robot));
  applyParametrics(model, design);
  const geometry = new Map();
  const parts = design.parts || {};
  const ops = createPartOps({ model, slots });
  for (const [key, rec] of Object.entries(parts)) {
    if (!rec || !Array.isArray(rec.ops) || !rec.ops.length || !model.component(key)) continue;
    /* a parametric part's ops run on the package mesh while its knobs are default (as the page) */
    const base = opsBase(model, design, key);
    const r = base ? ops.rebase(key, base, rec.ops, model.component(key).geometry) : ops.build(key, rec.ops);
    if (r.refused) throw new Error(`design.parts.${key}: op ${r.refused.index} refused (${r.refused.reason})`);
    if (r.ok && r.geometry !== ops.original(key)) for (const id of r.group.ids) geometry.set(id, r.geometry);
  }
  return { model, slots, design, scene: await sceneDoc('lab'), geometry, labScene: labSceneFiles() };
}

/** The lab decor from its sources, in the shape sim-scene.js loadLabScene gives the page. */
export function labSceneFiles(dir = path.join(STUDIO, 'assets/scenes/lab')) {
  const meshes = new Map();
  for (const f of fs.readdirSync(path.join(dir, 'props')).filter((x) => x.endsWith('.obj')).sort()) {
    meshes.set(f.slice(0, -4), parseObj(fs.readFileSync(path.join(dir, 'props', f), 'utf8')));
  }
  return { decor: JSON.parse(fs.readFileSync(path.join(dir, 'decor.json'), 'utf8')), meshes, lib: { decorXml, meshFiles, labAnim } };
}

export function writeOut(dir, { xml, meshes, sidecar, design }) {
  fs.rmSync(path.join(dir, 'meshes'), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'meshes'), { recursive: true });
  for (const [f, b] of meshes) fs.writeFileSync(path.join(dir, 'meshes', f), b);
  fs.writeFileSync(path.join(dir, 'scene.xml'), xml);
  fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify(sidecar, null, 1) + '\n');
  if (design) fs.writeFileSync(path.join(dir, 'design.json'), JSON.stringify(design, null, 1) + '\n');
}

export function readOut(dir) {
  const meshes = new Map();
  for (const f of fs.readdirSync(path.join(dir, 'meshes')).sort()) {
    meshes.set(f, new Uint8Array(fs.readFileSync(path.join(dir, 'meshes', f))));
  }
  return { xml: fs.readFileSync(path.join(dir, 'scene.xml'), 'utf8'), meshes,
    sidecar: JSON.parse(fs.readFileSync(path.join(dir, 'scene.json'), 'utf8')) };
}

export function args(argv, spec) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (spec[k] === 'flag') out[k] = true;
      else out[k] = argv[++i];
    } else out._.push(a);
  }
  return out;
}
