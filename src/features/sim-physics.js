/* What the MuJoCo model approximates: solver and servo constants, a mass per component, the
   fingertip covers.  Printed parts weigh their own volume at PRINT_FILL of PLA; bought parts come from a table.
   Inertia is left to MuJoCo (`mesh inertia="convex"` + a mass per geom).  Needs nothing. */

export const TIMESTEP = 0.002;                 // s, fixed
export const PLA_DENSITY = 1240;               // kg/m3
export const TPU_DENSITY = 1210;
/* Solid fraction of a part's own volume: 0.2 mm layers, 3-4 walls, 20-40 % infill give a
   volume-weighted 0.58-0.77 over the printed parts; 0.65 is the middle. */
export const PRINT_FILL = 0.65;
/* An M3 screw plus nut or insert is 2.1 g, about one per 47 g of PLA. Proportional, so no
   part's centre of mass moves. */
export const FASTENER_MASS_FRAC = 0.045;
/* The robot's mass band is per package: robot.json `mass.band_kg`, with its source. */
export const MASS_PART_MAX_KG = 0.25;
export const CONTACT_TOL_MM = 0.05;            // below this a contact is hull noise
export const DRIVE_V_MAX = 0.24;               // m/s
export const DRIVE_W_MAX = 96 * Math.PI / 180; // rad/s
export const STS3215_TORQUE = 3.0;             // N.m stall at 12 V
export const ARM = { kp: 80, kv: 4, damping: 0.1, armature: 0.02, frictionloss: 0.25 };
export const JAW = { kp: 8, kv: 0.3 };
export const ARENA = '4M';                     // the lab uses ~80 KB of arena
/* Collision bits: the world 1; the robot 4, touching the world and itself; a pad cover 2, the
   world only, so two covers closed on nothing pass through each other (the real jaw stops short). */
export const ROBOT_BITS = [4, 5], PAD_BITS = [2, 1];

/* Fabric covers on the fingertips, cut from a nitrile-coated knit glove, the coated face on the
   object.  A cover geom is the grip hull moved `mm` toward the other finger (knit 1.0-1.5 mm).
   mu 1.0: dry nitrile foam on smooth PP/PLA is 0.9-1.2.  Torsion mu l / 4 for the ~18 mm line the
   face presses on a post; rolling the ~0.2 mm the knit gives.  Soft: ~0.17 mm in at 1.6 N a pad. */
export const PAD_COVER = { mm: 1.2, friction: [1.0, 0.0045, 0.0002], solref: [0.006, 1], solimp: [0.8, 0.99, 0.0005] };

/** The points of a vertex-only .msh (mm). */
export function mshPoints(bytes) {
  const n = new DataView(bytes.buffer, bytes.byteOffset).getInt32(0, true);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset + 16, bytes.byteOffset + 16 + 12 * n));
}

/** A hull cloud moved `mm` along the unit `n`: the grip face out by the cover, the back face into the
    finger.  (A swept hull, the cloud plus its copy, leaves coplanar points that stall the support search.) */
export function coverCloud(bytes, n, mm = PAD_COVER.mm) {
  const P = mshPoints(bytes), out = new Uint8Array(16 + 4 * P.length);
  new DataView(out.buffer).setInt32(0, P.length / 3, true);
  const f = new Float32Array(out.buffer, 16, P.length);
  for (let i = 0; i < P.length; i++) f[i] = P[i] + mm * n[i % 3];
  return out;
}

/**
 * The pad covers of a two-finger gripper: on each finger, the fingertip hulls that reach the grip
 * face, moved toward the other finger along the gripper axis nearest the line between the fingertips.
 * @param fingers [{body, M: finger -> gripper frame (column-major 16), tips: [mesh names]}] x 2
 * @param meshes  name.msh -> bytes; gains pad_<name>.msh
 * @returns [{geom, body, normal (finger frame)}]
 */
export function padCovers(fingers, meshes) {
  const tips = fingers.map((f) => f.tips.map((name) => ({ name, P: mshPoints(meshes.get(`${name}.msh`)) })));
  if (tips.some((t) => !t.length)) return [];
  const c = tips.map((t, i) => {
    const s = [0, 0, 0], e = fingers[i].M;
    let n = 0;
    for (const { P } of t) { for (let k = 0; k < P.length; k++) s[k % 3] += P[k]; n += P.length / 3; }
    return [0, 1, 2].map((r) => (e[r] * s[0] + e[4 + r] * s[1] + e[8 + r] * s[2]) / n + e[12 + r]);
  });
  const out = [];
  fingers.forEach((f, i) => {
    const d = c[1 - i].map((v, k) => v - c[i][k]), a = d.map(Math.abs), ax = a.indexOf(Math.max(...a)), e = f.M;
    const n = [0, 1, 2].map((r) => Math.sign(d[ax]) * e[4 * r + ax]);            // the gripper axis in the finger frame
    const along = (P) => { let x = -Infinity; for (let k = 0; k < P.length; k += 3) x = Math.max(x, P[k] * n[0] + P[k + 1] * n[1] + P[k + 2] * n[2]); return x; };
    const reach = Math.max(...tips[i].map(({ P }) => along(P)));
    for (const { name, P } of tips[i]) {
      if (along(P) < reach - 0.5) continue;
      meshes.set(`pad_${name}.msh`, coverCloud(meshes.get(`${name}.msh`), n));
      out.push({ geom: `pad_${name}`, body: f.body, normal: n.map((v) => +v.toFixed(6)) });
    }
  });
  return out;
}

/* Bought parts, matched as a substring of the component's own id. `_df200` is the camera
   module only; `df200` alone would also claim the PLA arch, head and retainer. */
export const HARDWARE_KG = {
  ST3215_Servo_Motor: 0.060,
  STS3215_03a: 0.060,
  sts3215_drive: 0.060,
  'Battery---Battery': 0.300,
  '4-Omni-Directional-Wheel': 0.055,
  WaveShare_Mounting_Plate: 0.018,
  'Camera-Model': 0.012,
  _df200: 0.012,
  '94868A713': 0.006,
  Passive_Horn: 0.005,
  'Bottom-V2': 0.025,
  'Top-V2': 0.020,
};

/* Hardware with a mass but no mesh, in robot mm on the deck. Assumptions, all listed in the
   sidecar so a reader can take them back out. */
export const UNMODELLED = [
  ['Raspberry Pi 5 board', 0.046, [0, -71.65, 57]],
  ['Pi 5 active cooler', 0.010, [0, -71.65, 72]],
  ['Waveshare serial-bus servo driver', 0.025, [0, -36.5, 57]],
  ['12 V -> 5 V buck converter', 0.015, [0, -36.5, 62]],
  ['servo bus, power harness and 3 camera cables', 0.110, [0, 0, 40]],
];

/* The one open shell: its signed volume is meaningless, so the 1 mm voxel fill of the source
   STL stands in (its convex hull would read the forearm 72 % heavy). */
export const OPEN_SHELL_CM3 = { 'SO_ARM100_08k_Mirror-v1': 129.565 };

export function hardwareKg(shortId) {
  for (const [k, kg] of Object.entries(HARDWARE_KG)) if (shortId.includes(k)) return kg;
  return null;
}

/** Signed volume, mm3 (indexed or soup). */
export function signedVolume(geo) {
  const p = geo.attributes.position.array;
  const idx = geo.index ? geo.index.array : null;
  const n = idx ? idx.length : p.length / 3;
  let v = 0;
  for (let i = 0; i + 2 < n; i += 3) {
    const a = (idx ? idx[i] : i) * 3, b = (idx ? idx[i + 1] : i + 1) * 3, c = (idx ? idx[i + 2] : i + 2) * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

/** Every edge used by exactly two triangles, after a 1 µm weld. */
export function isWatertight(geo) {
  const p = geo.attributes.position.array;
  const idx = geo.index ? geo.index.array : null;
  const n = idx ? idx.length : p.length / 3;
  const ids = new Map();
  const vid = (i) => {
    const k = `${Math.round(p[3 * i] * 1e3)},${Math.round(p[3 * i + 1] * 1e3)},${Math.round(p[3 * i + 2] * 1e3)}`;
    let v = ids.get(k);
    if (v === undefined) { v = ids.size; ids.set(k, v); }
    return v;
  };
  const edges = new Map();
  for (let t = 0; t + 2 < n; t += 3) {
    const v = [0, 1, 2].map((k) => vid(idx ? idx[t + k] : t + k));
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  for (const c of edges.values()) if (c !== 2) return false;
  return edges.size > 0;
}

/**
 * Volume of one component, cm3, and where it came from.
 * @param {{id:string, committedCm3?:number|null}} c
 * @param {object} geo       the geometry the sim uses
 * @param {object} [pristine] the package geometry when `geo` was edited, else null
 */
export function componentVolume(c, geo, pristine = null) {
  const short = c.id.split('/').pop();
  const base = Number.isFinite(c.committedCm3) ? { cm3: c.committedCm3, basis: 'committed' }
    : OPEN_SHELL_CM3[short] != null ? { cm3: OPEN_SHELL_CM3[short], basis: 'voxel' }
      : null;
  if (!pristine || pristine === geo) {
    return base || { cm3: Math.abs(signedVolume(geo)) / 1000, basis: 'mesh' };
  }
  if (isWatertight(geo)) return { cm3: Math.abs(signedVolume(geo)) / 1000, basis: 'edited' };
  const s0 = Math.abs(signedVolume(pristine));
  const ref = base ? base.cm3 : s0 / 1000;
  return { cm3: s0 > 0 ? ref * Math.abs(signedVolume(geo)) / s0 : ref, basis: 'edited-ratio' };
}

/** {kg, fastenerKg, basis, cm3, printed} for one component. */
export function componentMass(c, geo, pristine = null) {
  const short = c.id.split('/').pop();
  const hw = hardwareKg(short);
  if (hw != null) return { kg: hw, fastenerKg: 0, basis: 'hardware', cm3: null, printed: false };
  const v = componentVolume(c, geo, pristine);
  const rho = /tpu/i.test(short) ? TPU_DENSITY : PLA_DENSITY;
  const kg = v.cm3 * 1e-6 * rho * PRINT_FILL;
  return { kg, fastenerKg: kg * FASTENER_MASS_FRAC, basis: v.basis, cm3: v.cm3, printed: true };
}
