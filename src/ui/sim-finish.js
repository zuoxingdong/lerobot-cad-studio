/* The robot's real finish in the Sim tab: each part resolved to its photoreal look by the robot
   rules of tools/render/looks.json (ui/robot-look.js, the mirror the showcase robot shares), built
   with the showcase's Looks (showcase-looks.js).  Printed parts take one of their filament lots per
   part and the cheap print; the omni wheel is a black hub with slate rubber rollers until the
   bake's wheels ride it.  Once open, the meshes also get crease-angle normals and an ambient
   occlusion (ui/robot-shade.js), put back on dispose. */
import * as THREE from 'three';
import { Looks } from './showcase-looks.js';
import { shade } from './robot-shade.js';
import { RULES, LOOKS, WHEEL, keyOfGeom, lotOf, withLots, printed, MM_REST } from './robot-look.js';
import { sane } from '../features/sim-mjcf.js';

export { RULES, LOOKS, WHEEL, lotOf };

/** the look key of a part id */
export const keyOf = (id) => keyOfGeom('vis_' + sane(id));

const specs = withLots({ ...LOOKS, pla_object: { base: 'object', rough: 0.55, sheen: 0.08 } });

/* the wheel's frame: its thin axis, the centre and the roller radius, object space */
function wheelFrame(geo) {
  if (!geo.boundingBox) geo.computeBoundingBox();
  const b = geo.boundingBox, size = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
  const ax = size.x <= size.y && size.x <= size.z ? 0 : size.y <= size.z ? 1 : 2;
  const r = WHEEL.roller_from * Math.max(...[size.x, size.y, size.z].filter((_, i) => i !== ax)) / 2;
  return { c, ax, r, key: [c.x, c.y, c.z, ax, r].map((v) => v.toFixed(1)).join(',') };
}

/* hub or roller by the object-space radius about the thin axis */
function wheelPatch(m, { c, ax, r }) {
  const hub = LOOKS[WHEEL.hub];
  const u = {
    rpsC: { value: c }, rpsMask: { value: new THREE.Vector3(ax === 0 ? 0 : 1, ax === 1 ? 0 : 1, ax === 2 ? 0 : 1) },
    rpsR: { value: r }, rpsHub: { value: new THREE.Color().setRGB(...hub.base, THREE.LinearSRGBColorSpace) },
    rpsHubRough: { value: hub.rough },
  };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = 'varying vec3 vRpsP;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvRpsP = position;');
    sh.fragmentShader = 'varying vec3 vRpsP;\nuniform vec3 rpsC, rpsMask, rpsHub;\nuniform float rpsR, rpsHubRough;\n' + sh.fragmentShader
      .replace('#include <color_fragment>', '#include <color_fragment>\nbool rpsIn = length((vRpsP - rpsC) * rpsMask) < rpsR;\nif (rpsIn) diffuseColor.rgb = rpsHub;\n#ifdef USE_COLOR\nif (rpsIn) diffuseColor.rgb *= vColor;\n#endif')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (rpsIn) roughnessFactor = rpsHubRough;');
  };
  m.customProgramCacheKey = () => 'rps-wheel';
  m.userData.wheel = { axis: ax, r_mm: +r.toFixed(2) };
  return m;
}

const hexLinear = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b, 0]; };

/* the meshes' normals and an AO colour, in their pose now (Design mm, Z up); the floor under the lowest part.
   AO per corner: an STL fans long slivers off each hole rim, which per-vertex AO streaks dark */
function shadeRobot(map, mats, state) {
  const items = [...map.keys()].filter((m) => m.geometry && m.geometry.attributes.position)
    .map((m) => ({ geometry: m.geometry, matrix: m.matrix }));
  let floor = Infinity;
  for (const it of items) {
    const g = it.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    floor = Math.min(floor, g.boundingBox.clone().applyMatrix4(it.matrix).min.z);
  }
  const t0 = performance.now();
  return shade(items, { floor: floor - 0.5, corners: true }).then((res) => {
    if (state.dead) return;
    for (const [g, s] of res) {
      state.kept.set(g, { normal: g.attributes.normal, color: g.attributes.color || null });
      if (s.normal) g.setAttribute('normal', new THREE.BufferAttribute(s.normal, 3, true));
      g.setAttribute('color', new THREE.BufferAttribute(s.color, 3, true));
    }
    for (const m of mats()) { m.vertexColors = true; m.needsUpdate = true; }
    state.shaded = { geometries: res.size, ms: Math.round(performance.now() - t0) };
  });
}

function unshade(state) {
  for (const [g, k] of state.kept) {
    if (k.normal) g.setAttribute('normal', k.normal);
    if (k.color) g.setAttribute('color', k.color); else g.deleteAttribute('color');
  }
  state.kept.clear();
}

/**
 * The real materials of the robot's meshes, shared by look, lot and colour.
 * @param meshes Map<id, Mesh> (the Design meshes)
 * @param opts {shade: false to skip the normals and AO}
 * @returns {{map: Map<Mesh, Material>, keys: Map<id, string>, ready: Promise, state, dispose()}}
 */
export function createSimFinish(meshes, { shade: soft = true } = {}) {
  const looks = new Looks(specs, {}, { transmission: false });
  const wheels = new Map(), map = new Map(), keys = new Map();
  for (const [id, mesh] of meshes) {
    if (!mesh.isMesh) continue;
    const key = keyOf(id), s = LOOKS[key];
    const tint = mesh.material && mesh.material.userData.tinted;          // an imported or recoloured part
    let m;
    if (key === 'wheel') {
      const f = wheelFrame(mesh.geometry);
      if (!wheels.has(f.key)) wheels.set(f.key, wheelPatch(looks.make(WHEEL.roller), f));
      m = wheels.get(f.key);
    } else if (tint && key.startsWith('pla')) m = looks.get('pla_object', hexLinear(tint.hex));
    else {
      const k = s.lot ? key + '.' + lotOf(id, s.lot.length) : key, fresh = !looks.cache.has(k + '|');
      m = looks.get(k);
      if (fresh) printed(m, s, MM_REST);
    }
    map.set(mesh, m);
    keys.set(id, key);
  }
  const state = { dead: false, kept: new Map(), shaded: null };
  const mats = () => [...looks.cache.values(), ...wheels.values()];
  const ready = soft && typeof performance !== 'undefined' ? shadeRobot(map, mats, state) : Promise.resolve();
  return {
    map, keys, ready, state,
    dispose() {
      state.dead = true;
      unshade(state);
      for (const m of looks.cache.values()) m.dispose();
      for (const m of wheels.values()) m.dispose();
      looks.cache.clear();
      wheels.clear();
    },
  };
}
