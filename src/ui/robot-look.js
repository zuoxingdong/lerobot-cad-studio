/* The robot's web look, one mirror for the Sim tab (ui/sim-finish.js) and the showcase robot: the robot rules
   and drawn fields of tools/render/looks.json, the filament lots, and a cheap FDM print on `layer` looks (the
   wobble band and a shade and gloss per layer in the shader, each faded out once it is under a pixel), and the
   fingertip covers' faces (`fabric`). tools/tests/ui/sim-finish.test.mjs holds RULES and LOOKS to looks.json. */
import * as THREE from 'three';

export const RULES = [
  [/^vis_(.*_)?st[s]?3215/i, 'servo'],
  [/^vis_.*omni-directional-wheel/i, 'wheel'],
  [/^vis_.*standoff/i, 'brass'],
  [/^vis_.*(removable_tip|tip_support)/i, 'fabric_knit_blue'],
  [/^vis_(camera-model|.*_df200$)/i, 'camera_module'],
  [/^vis_battery/i, 'battery'],
  [/^vis_base_plate/i, 'acrylic_clear'],
  [/^vis_lipo_battery_mount/i, 'pla_dark'],
  [/^vis_(base_08q|rotation_pitch|so_arm100|wrist_roll_pitch)/i, 'pla_aqua'],
  [/^vis_/, 'pla_cyan'],
];

/* looks.json library entries: the fields the web mirror draws, `lot` (the lots' bases), `layer` (the print) */
export const LOOKS = {
  servo: { base: [0.03, 0.033, 0.04], rough: 0.45 },
  wheel: { base: [0.035, 0.035, 0.037], rough: 0.45 },
  brass: { base: [0.78, 0.56, 0.28], rough: 0.35, metal: 1 },
  fabric_knit_blue: { base: [0.01, 0.035, 0.15], rough: 0.9, sheen: 0.15, sheen_rough: 0.5 },
  /* no rule: the covers' coated grip face and tip in the dress (robot_kit), the blue knit on the back and sides */
  nitrile_coat: { base: [0.014, 0.014, 0.015], rough: 0.82, sheen: 0.06, sheen_rough: 0.6 },
  camera_module: { base: [0.04, 0.04, 0.044], rough: 0.4 },
  battery: { base: [0.05, 0.38, 0.78], rough: 0.3, coat: 0.2 },
  acrylic_clear: { base: [0.97, 0.98, 0.975], rough: 0.01, transmission: 1, ior: 1.49, volume: { color: [0.93, 0.975, 0.965], density: 6 } },
  pla_dark: { base: [0.035, 0.037, 0.04], rough: 0.62, sheen: 0.08, layer: { pitch_mm: 0.2, band_mm: 0.8 } },
  pla_aqua: { base: [0.035, 0.58, 0.67], rough: 0.55, sheen: 0.08, lot: [[0.035, 0.58, 0.67], [0.04, 0.6, 0.67], [0.03, 0.56, 0.68]],
    layer: { pitch_mm: 0.2, band_mm: 1.2, band_albedo: 0.012, layer_albedo: 0.012, rough_amp: 0.12 } },
  pla_cyan: { base: [0.255, 0.55, 0.66], rough: 0.55, sheen: 0.08, lot: [[0.255, 0.55, 0.66], [0.275, 0.57, 0.66], [0.245, 0.53, 0.68]],
    layer: { pitch_mm: 0.2, band_mm: 1.2, band_albedo: 0.012, layer_albedo: 0.012, rough_amp: 0.08 } },
  rubber_roller: { base: [0.2, 0.29, 0.35], rough: 0.6, sheen: 0.2, sheen_rough: 0.5, ior: 1.52 },
};
/* the one-mesh wheel: rollers beyond `roller_from` of the radius (looks.json wheel.wheel), on the hub */
export const WHEEL = { roller_from: 0.78, hub: 'wheel', roller: 'rubber_roller' };

/** the look key of a geom name (`vis_<sane id>`) */
export function keyOfGeom(n) {
  for (const [re, k] of RULES) if (re.test(n)) return k;
  return 'pla_cyan';
}

/** a stable lot per part (or node) name */
export function lotOf(id, n) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % n;
}

const lots = (s) => (s && s.lot ? (Array.isArray(s.lot) ? s.lot : s.lot.base) : null);

/** specs plus `<key>.<i>`, each lot's base, for every spec with lots */
export function withLots(specs) {
  const out = { ...specs };
  for (const [k, s] of Object.entries(specs)) (lots(s) || []).forEach((b, i) => { out[k + '.' + i] = { ...s, base: b }; });
  return out;
}

/** the lot look of a node: `<key>.<i>` when its key has lots, else the key itself */
export function lotKey(specs, key, id) {
  const L = lots(specs[key]);
  return L ? key + '.' + lotOf(id, L.length) : key;
}

const PRINT = `
float rpsH = vRpsP.z * 1000.0;
float rpsB = rpsH / RPS_BAND, rpsL = rpsH / RPS_PITCH;
float rpsWB = clamp(1.0 - 2.0 * fwidth(rpsB), 0.0, 1.0), rpsWL = clamp(1.0 - 2.0 * fwidth(rpsL), 0.0, 1.0);
float rpsN = fract(sin(floor(rpsL) * 12.9898) * 43758.5453) - 0.5;
`;

/**
 * The FDM print on a material of a `layer` look: the albedo's wobble band (band_albedo per band_mm) and a
 * shade and gloss per layer (layer_albedo, rough_amp per pitch_mm), along the rest frame's z.
 * `rest`: object -> the rest frame in metres (a Matrix4; the print axis is its z).  Returns m, or null.
 */
export function printed(m, spec, rest) {
  const L = spec && spec.layer;
  if (!L || !(L.band_albedo || L.layer_albedo || L.rough_amp)) return null;
  const u = { rpsRest: { value: rest.clone() } }, f = (v) => Number(v || 0).toFixed(5);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.rpsRest = u.rpsRest;
    sh.vertexShader = 'uniform mat4 rpsRest;\nvarying vec3 vRpsP;\n' + sh.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRpsP = (rpsRest * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = `varying vec3 vRpsP;\n#define RPS_BAND ${f(L.band_mm || 1)}\n#define RPS_PITCH ${f(L.pitch_mm || 0.2)}\n` + sh.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>\n${PRINT}diffuseColor.rgb *= 1.0 + ${f(L.band_albedo)} * sin(6.2832 * rpsB) * rpsWB + ${f(2 * (L.layer_albedo || 0))} * rpsN * rpsWL;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor + ${f(2 * (L.rough_amp || 0))} * rpsN * rpsWL, 0.04, 1.0);`);
  };
  m.customProgramCacheKey = () => 'rps-print' + [L.band_mm, L.pitch_mm, L.band_albedo, L.layer_albedo, L.rough_amp].join(',');
  m.userData.print = { band_mm: L.band_mm, pitch_mm: L.pitch_mm };
  return m;
}

const GRAIN = `
vec3 rpsQ = vRpsG / RPS_CELL, rpsC = floor(rpsQ);
vec3 rpsH = fract(sin(vec3(dot(rpsC, vec3(127.1, 311.7, 74.7)), dot(rpsC, vec3(269.5, 183.3, 246.1)),
  dot(rpsC, vec3(113.5, 271.9, 124.6)))) * 43758.5453) - 0.5;
float rpsW = clamp(1.0 - 1.5 * length(fwidth(rpsQ)), 0.0, 1.0);
`;
/* value noise at q (cells), its gradient in g: the sand's grains */
const NOISE = `
float rpsHash(vec3 c) { return fract(sin(dot(c, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float rpsNoise(vec3 q, out vec3 g) {
  vec3 i = floor(q), f = fract(q), u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
  float a = rpsHash(i), b = rpsHash(i + vec3(1, 0, 0)), c = rpsHash(i + vec3(0, 1, 0)), d = rpsHash(i + vec3(1, 1, 0));
  float e = rpsHash(i + vec3(0, 0, 1)), f1 = rpsHash(i + vec3(1, 0, 1)), g1 = rpsHash(i + vec3(0, 1, 1)), h = rpsHash(i + vec3(1, 1, 1));
  float k1 = b - a, k2 = c - a, k3 = e - a, k4 = a - b - c + d, k5 = a - c - e + g1, k6 = a - b - e + f1, k7 = -a + b + c - d + e - f1 - g1 + h;
  g = du * vec3(k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z, k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x, k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y);
  return a + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z;
}
`;
/* the sand: two octaves of grains (the offline noise's 4 mm cell and half), each faded out under a pixel */
const SAND = `
vec3 rpsG1, rpsG2;
vec3 rpsQ = vRpsG / RPS_CELL;
float rpsV = rpsNoise(rpsQ, rpsG1), rpsV2 = rpsNoise(2.0 * rpsQ + 17.0, rpsG2);
float rpsW = clamp(1.0 - 1.5 * length(fwidth(rpsQ)), 0.0, 1.0), rpsW2 = clamp(1.0 - 3.0 * length(fwidth(rpsQ)), 0.0, 1.0);
vec3 rpsGr = rpsW * rpsG1 + rpsW2 * rpsG2;
vec3 rpsGv = rpsGr.x * vRpsX + rpsGr.y * vRpsY + rpsGr.z * vRpsZ;
`;
const fab = new WeakMap();

/**
 * The covers' faces on a dress material: `bump` sand (nitrile_coat: grains at the offline noise's scale, 4 x `mm`,
 * tilted by amp / mm, the roughness within `rough_var.range`) or `knit` (ribs of `mm` across the rest frame's x,
 * of amp_mm deep, and a fuzz per stitch), each faded out under a pixel; double-sided; pressable (coverPress).
 * `rest`: object -> the part's own frame in metres (a Matrix4: the body's, so the ribs run as offline).  Returns m, or null.
 */
export function fabric(m, spec, rest) {
  const sand = spec && spec.bump && spec.bump.kind === 'sand' ? spec.bump : null, knit = spec && spec.knit;
  const K = sand || knit;
  if (!K || !K.mm) return null;
  const f = (v) => Number(v).toFixed(5), cell = sand ? 4 * K.mm : K.mm;
  const tilt = f(Math.min((sand ? 5 : 2 * Math.PI) * (K.amp_mm || 0) / cell, 0.6));
  const R = (spec.rough_var || {}).range;
  const u = { rpsRest: { value: rest.clone() }, rpsPress: { value: new THREE.Vector4(0, 0, 0, 1e9) } };
  fab.set(m, u);
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = 'uniform mat4 rpsRest;\nuniform vec4 rpsPress;\nvarying vec3 vRpsG;\nvarying vec3 vRpsX;\nvarying vec3 vRpsY;\nvarying vec3 vRpsZ;\n' + sh.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRpsG = (rpsRest * vec4(position, 1.0)).xyz * 1000.0;\n' +
        'float rpsP = dot(transformed, rpsPress.xyz) - rpsPress.w;\nif (rpsP > 0.0) transformed -= rpsPress.xyz * rpsP;\n' +
        'mat3 rpsR = transpose(mat3(rpsRest));\nvRpsX = normalize(normalMatrix * rpsR[0]);\nvRpsY = normalize(normalMatrix * rpsR[1]);\nvRpsZ = normalize(normalMatrix * rpsR[2]);');
    sh.fragmentShader = `varying vec3 vRpsG;\nvarying vec3 vRpsX;\nvarying vec3 vRpsY;\nvarying vec3 vRpsZ;\n#define RPS_CELL ${f(cell)}\n${sand ? NOISE : ''}` + sh.fragmentShader
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${sand ? SAND : GRAIN}` +
        (sand && R ? `roughnessFactor = mix(roughnessFactor, mix(${f(R[0])}, ${f(R[1])}, rpsV), rpsW);` : ''))
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + (sand
        ? `normal = normalize(normal + ${tilt} * (dot(rpsGv, normal) * normal - rpsGv));`
        : `normal = normalize(normal + ${tilt} * rpsW * (cos(6.2832 * rpsQ.x + 1.5708) * vRpsX + 0.3 * rpsH));`));
  };
  m.side = THREE.DoubleSide;                  // an open shell (the covers' cut end): both sides, as the film draws it
  m.customProgramCacheKey = () => 'rps-fabric' + [sand ? 'sand' : 'knit', K.mm, K.amp_mm, R].join(',');
  m.userData.fabric = sand ? 'sand' : 'knit';
  return m;
}

/** a fabric() material's rest frame, once known */
export function setFabricRest(m, rest) {
  const u = fab.get(m);
  if (u) u.rpsRest.value.copy(rest);
}

/* the gap each cover keeps from the mid-plane, in the covers' own units (m), as press.py EPS */
export const PRESS_EPS = 5e-5;

/**
 * The two fingertip covers pressed together: where a jaw closes past the covers' touch (MuJoCo lets them pass, the
 * real jaw stops), each flattens at the mid-plane, `eps` (the meshes' own units) short of it.  parts: [{mesh, key}] of the
 * dress's fabric() meshes, key = the body; the covers are the two bodies wearing the sand.  Returns update(), to
 * call once the meshes are posed, or null.  Twin: tools/render/blender/press.py (tools/tests/render/test_press.py).
 */
export function coverPress(parts, eps) {
  const by = new Map();
  for (const { mesh, key } of parts) if (fab.has(mesh.material)) (by.get(key) || by.set(key, []).get(key)).push(mesh);
  const pair = [...by.values()].filter((ms) => ms.some((o) => o.material.userData.fabric === 'sand'));
  if (pair.length !== 2) return null;
  const G = pair.map((ms) => {
    const sand = ms.find((o) => o.material.userData.fabric === 'sand');
    const c = new THREE.Box3().setFromBufferAttribute(sand.geometry.attributes.position).getCenter(new THREE.Vector3());
    const P = ms.map((o) => {                          // the positions as drawn (a quantized attribute is normalized)
      const a = o.geometry.attributes.position, out = new Float32Array(3 * a.count);
      for (let i = 0; i < a.count; i++) { out[3 * i] = a.getX(i); out[3 * i + 1] = a.getY(i); out[3 * i + 2] = a.getZ(i); }
      return out;
    });
    return { ms, sand, c, P };
  });
  const n = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), t = new THREE.Vector3();
  const ext = (g, sgn) => {
    let h = -Infinity;
    g.ms.forEach((o, k) => {
      const e = o.matrixWorld.elements, P = g.P[k];
      const w0 = sgn * (e[0] * n.x + e[1] * n.y + e[2] * n.z), w1 = sgn * (e[4] * n.x + e[5] * n.y + e[6] * n.z);
      const w2 = sgn * (e[8] * n.x + e[9] * n.y + e[10] * n.z), w3 = sgn * (e[12] * n.x + e[13] * n.y + e[14] * n.z);
      for (let i = 0; i < P.length; i += 3) h = Math.max(h, w0 * P[i] + w1 * P[i + 1] + w2 * P[i + 2] + w3);
    });
    return h;
  };
  const set = (g, sgn, lim) => {
    for (const o of g.ms) {
      const e = o.matrixWorld.elements, s = Math.hypot(e[0], e[1], e[2]), p = fab.get(o.material).rpsPress.value;
      if (lim === null) { p.set(0, 0, 0, 1e9); continue; }
      t.set(e[12], e[13], e[14]);
      p.set(sgn * (e[0] * n.x + e[1] * n.y + e[2] * n.z) / s, sgn * (e[4] * n.x + e[5] * n.y + e[6] * n.z) / s,
        sgn * (e[8] * n.x + e[9] * n.y + e[10] * n.z) / s, (lim - sgn * t.dot(n)) / s);
    }
  };
  return () => {
    for (const g of G) for (const o of g.ms) o.updateWorldMatrix(true, false);
    a.copy(G[0].c).applyMatrix4(G[0].sand.matrixWorld);
    b.copy(G[1].c).applyMatrix4(G[1].sand.matrixWorld);
    n.subVectors(b, a).normalize();
    const e = G[0].sand.matrixWorld.elements, d = eps * Math.hypot(e[0], e[1], e[2]);
    const hA = ext(G[0], 1), hB = -ext(G[1], -1), on = hA - hB > -2 * d, mid = (hA + hB) / 2;
    set(G[0], 1, on ? mid - d : null);
    set(G[1], -1, on ? -(mid + d) : null);
  };
}

/** the print's rest frame of a Design mesh: object mm -> m */
export const MM_REST = new THREE.Matrix4().makeScale(0.001, 0.001, 0.001);
