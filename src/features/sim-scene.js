/* The lab scene from assets/scenes/lab/scene.json (rps/scene@2): instrument stations on plinths,
   each with a square nest, and the free sample puck; plus the loader of its visual decor
   (sim-scene-decor.js).  World millimetres, floor z = 0, yaw CCW with 0 = +Y.  Every deck and
   nest floor sits at T, the robot's reach-table grasp height, so the heights follow the design. */

import { gunzipSync } from 'fflate';
import { robotSource } from '../core/embedded.js';
import { fmt, v3, zOf, rotXY, stationFrames } from './sim-scene-decor.js';
import { liquidSpec } from './sim-liquid.js';
import { versioned } from '../core/asset-version.js';

export { fmt, v3 };
export const LAB_SCRIPT = 'vendor/lab-scene.js';
/* measured on the robot (footprint below / above high_z) and the route margin the task keeps */
export const CLEARANCE = { r_low: 167, r_high: 240, high_z: 350, min: 80 };

/** A bundled scene document (assets/scenes/<id>/scene.json). */
export async function sceneDoc(id = 'lab') {
  const src = await robotSource();
  const s = src.SCENES && src.SCENES[id];
  if (!s) throw new Error(`sim: no scene "${id}" in the bundle`);
  return s.scene;
}

let _labScene = null;

/**
 * The lab's decor package, once per page: site/vendor/lab-scene.js (tools/build/build.mjs)
 * -> {decor, meshes: Map<name, {position, normal, index}>, lib: {decorXml, meshFiles, labAnim, createRoom}}.
 * The browser injects the script; node imports the same file.
 */
export function loadLabScene(url = LAB_SCRIPT) {
  if (!_labScene) {
    _labScene = (async () => {
      if (!globalThis.RPS_LAB_SCENE) {
        if (typeof document === 'undefined') {
          const at = new URL('../../site/' + url, import.meta.url);
          await import(at.href);
        } else {
          await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = versioned(url);
            s.onload = resolve;
            s.onerror = () => reject(new Error(`sim: could not load ${url}`));
            document.head.appendChild(s);
          });
        }
      }
      return unpackLabScene(globalThis.RPS_LAB_SCENE);
    })().catch((e) => { _labScene = null; throw e; });
  }
  return _labScene;
}

/* {decor, meshes: {name: [byteOffset, nVert, nIndex]}, bin: base64(gzip), lib} -> typed arrays */
function unpackLabScene(P) {
  if (!P || !P.decor || !P.bin || !P.lib) throw new Error(`sim: ${LAB_SCRIPT} did not define RPS_LAB_SCENE`);
  const raw = atob(P.bin), gz = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) gz[i] = raw.charCodeAt(i);
  const buf = gunzipSync(gz).buffer, meshes = new Map();
  for (const [name, [o, nv, ni]] of Object.entries(P.meshes)) {
    const io = o + 12 * nv + ((3 * nv + 3) & ~3);
    meshes.set(name, { position: new Float32Array(buf, o, 3 * nv), normal: new Int8Array(buf, o + 12 * nv, 3 * nv), index: new Uint32Array(buf, io, ni) });
  }
  return { decor: P.decor, meshes, lib: P.lib };
}

const r6 = (x) => +(+x).toFixed(6) + 0;
const span = (a) => [Math.min(...a), Math.max(...a)];

/**
 * The resolved sidecar `lab` block (rps/lab@2): world mm, yaw deg, every z absolute.
 * `T0` = the reach-table grasp height above the floor, kept to 0.01 mm.
 */
export function labLayout(scene, T0) {
  if (!scene || scene.schema !== 'rps/scene@2') throw new Error('sim: the lab scene is not rps/scene@2');
  const T = Math.round(T0 * 100) / 100, D = scene.defaults;
  const stations = scene.stations.map((s) => {
    const W = (x, y) => rotXY(s.yaw, [x, y]).map((v, i) => r6(s.origin[i] + v));
    const [w, d] = s.plinth, n = { ...D.nest, ...s.nest };
    const c = [[-w / 2, 0], [w / 2, 0], [w / 2, d], [-w / 2, d]].map((p) => W(...p));
    const lid = s.lid ? { hinge: [...W(s.lid.hinge[0], s.lid.hinge[1]), r6(zOf(s.lid.hinge[2], T))],
      axis: [...rotXY(s.yaw, s.lid.axis.slice(0, 2)).map(r6), r6(s.lid.axis[2])], closed_deg: s.lid.closed_deg } : null;
    const o = { id: s.id, kind: s.kind, body: `st_${s.id}`, yaw: s.yaw, park: [...W(0, -D.standoff), s.yaw],
      plinth_rect: { x: span(c.map((p) => p[0])), y: span(c.map((p) => p[1])) }, top_z: T,
      nest: { xy: W(...n.at), floor_z: T, inner: n.inner, wall: n.wall, collar_h: n.collar_h, lead: n.lead, top_z: r6(T + n.collar_h + n.lead) },
      lid, cycle: s.cycle ? { ...s.cycle } : null };
    if (s.start) o.start = s.start;
    if (s.result) o.result = s.result.slice();
    return o;
  });
  const props = scene.props.map((p) => {
    const st = stations.find((s) => s.id === p.at);
    return { id: p.id, kind: p.kind, body: p.id, joint: `${p.id}_free`, at: p.at, d: p.d, post_d: p.post[0],
      knob_top: p.h + p.post[1] + p.knob[1], grip_z: p.grip_z, mass_kg: r6(puckMassG(p) / 1000),
      start_bottom: [...st.nest.xy, st.nest.floor_z], liquid: liquidSpec(p) };
  });
  return { schema: 'rps/lab@2', T_mm: T, room: { x: scene.room.x.slice(), y: scene.room.y.slice() }, dock: scene.dock.slice(),
    clearance: { ...CLEARANCE }, stations, waypoints: scene.waypoints.map((w) => ({ ...w, pose: w.pose.slice() })), props, anim: [] };
}

const puckMassG = (p) => { const g = p.mass_g, n = p.wells.n; return g.foot + g.body + g.post + g.knob + n * (g.tube + g.cap); };

/** Scenery body names: never the robot. */
export function envBodies(L, decor = false) {
  return [...L.stations.map((s) => s.body), ...L.props.map((p) => p.body), ...(decor ? ['decor'] : []), 'world'].sort();
}

/** The free bodies a renderer draws from xpos/xquat: [{name, kind, ...}] */
export function propBodies(L) {
  return L.props.map((p) => ({ name: p.body, kind: p.kind, d_mm: p.d, post_d_mm: p.post_d, knob_top_mm: p.knob_top, grip_z_mm: p.grip_z }));
}

const F_PLINTH = 'condim="4" friction="0.8 0.01 0.001"';
/* the meniscus band: the wetted rim over the surface, 0.2 mm above it at the centre */
const MENISCUS_MM = 0.7;
/* the nest is a smooth chamfered pocket: its low friction wins the contact (priority), so a
   puck on the 45° lead-in slides instead of perching */
const F_NEST = 'priority="1" condim="3" friction="0.3 0.01 0.001"';

/* one station: plinth, coarse instrument body, a square collar with 45° lead-in plates (in mm, local) */
function stationXml(s, st, at, L, A) {
  const m = (a) => v3(a.map((x) => x / 1000)), T = L.T_mm;
  const box = (name, pos, half, rgba, extra = '', F = F_PLINTH) => A.push(`      <geom name="${st.body}_${name}" type="box" pos="${m(pos)}" size="${m(half)}"${extra} rgba="${rgba}" ${F}/>`);
  const f = stationFrames(L).find((x) => x.id === s.id);
  const q = f.yaw ? ` quat="${v3([Math.cos(f.yaw * Math.PI / 360), 0, 0, Math.sin(f.yaw * Math.PI / 360)])}"` : '';
  A.push(`    <body name="${st.body}" pos="${m([f.x, f.y, 0])}"${q}>`);
  const [w, d] = s.plinth, B = s.body;
  box('plinth', [0, d / 2, T / 2], [w / 2, d / 2, T / 2], '0.55 0.58 0.62 1');
  box('body', [(B.x[0] + B.x[1]) / 2, (B.y[0] + B.y[1]) / 2, T + B.h / 2], [(B.x[1] - B.x[0]) / 2, (B.y[1] - B.y[0]) / 2, B.h / 2], '0.9 0.91 0.92 1');
  const N = st.nest, [nx, ny] = at, ri = N.inner / 2, t = N.wall, ch = N.collar_h, lead = N.lead;
  const ro = ri + t, zc = T + ch / 2, top = T + ch, h = 1;           // h: half thickness of a lead-in plate
  /* +y, -y, +x, -x: a wall per side, and on its top a plate whose inner face runs 45° from the
     inner edge (ri, top) out to the mouth (ri + lead, top + lead) */
  [[0, 1], [0, -1], [1, 0], [-1, 0]].forEach(([ox, oy], i) => {
    const along = ox ? [t / 2, ri, ch / 2] : [ro, t / 2, ch / 2];
    box(`c${i + 1}`, [nx + ox * (ri + t / 2), ny + oy * (ri + t / 2), zc], along, '0.7 0.72 0.75 1', '', F_NEST);
    const r = ri + lead / 2 + h / Math.SQRT2, z = top + lead / 2 - h / Math.SQRT2;
    const tx = oy ? 1 : 0, ty = ox ? 1 : 0, sx = ox / Math.SQRT2, sy = oy / Math.SQRT2;
    box(`l${i + 1}`, [nx + ox * r, ny + oy * r, z], [ri + lead, lead / Math.SQRT2, h], '0.7 0.72 0.75 1',
      ` xyaxes="${v3([tx, ty, 0, sx, sy, Math.SQRT1_2])}"`, F_NEST);
  });
  A.push('    </body>');
}

/* one puck: foot, body, handle post and knob, and the 4 capped tubes in their wells (mm, body frame) */
function puckXml(p, lp, A) {
  const m = (x) => fmt(x / 1000), g = p.mass_g, fb = p.friction.body, fp = p.friction.post;
  const FB = `condim="4" friction="${v3(fb)}"`, FP = `condim="6" friction="${v3(fp)}" solref="0.008 1" solimp="0.95 0.99 0.001"`;
  const cyl = (name, d, h, z, kg, rgba, F, x = 0, y = 0) =>
    A.push(`      <geom name="${p.id}_${name}" type="cylinder" pos="${v3([x / 1000, y / 1000, z / 1000])}" size="${m(d / 2)} ${m(h / 2)}" mass="${fmt(kg / 1000)}" rgba="${rgba}" ${F}/>`);
  const [fx, fy, fz] = lp.start_bottom;
  A.push(`    <body name="${p.id}" pos="${v3([fx / 1000, fy / 1000, fz / 1000])}">`);
  A.push(`      <freejoint name="${lp.joint}"/>`);
  const [fd, fh] = p.foot, bh = p.h - fh, [pd, ph] = p.post, [kd, kh] = p.knob;
  cyl('foot', fd, fh, fh / 2, g.foot, '0.2 0.22 0.25 1', FB);
  cyl('body', p.d, bh, fh + bh / 2, g.body, '0.93 0.94 0.95 1', FB);
  cyl('post', pd, ph, p.h + ph / 2, g.post, '0.93 0.94 0.95 1', FP);
  cyl('knob', kd, kh, p.h + ph + kh / 2, g.knob, '0.2 0.22 0.25 1', FP);
  const W = p.wells, [td, th] = W.tube, [cd, chh] = W.cap, tz0 = p.h - W.depth;
  const caps = ['0.2 0.45 0.95 1', '1 0.62 0.1 1', '0.2 0.85 0.45 1', '0.95 0.45 0.7 1'];
  for (let k = 0; k < W.n; k++) {
    const a = (W.phase_deg + k * 360 / W.n) * Math.PI / 180, x = W.r * Math.cos(a), y = W.r * Math.sin(a);
    cyl(`tube_${k + 1}`, td, th, tz0 + th / 2, g.tube, '0.9 0.93 0.96 1', FB, x, y);
    cyl(`cap_${k + 1}`, cd, chh, tz0 + th + chh / 2, g.cap, caps[k % caps.length], FB, x, y);
  }
  A.push('    </body>');
}

/**
 * The tubes' liquid for the video model (export --visual): per tube a column and a meniscus band on
 * the puck body, visual only (group 1, no contact, no mass); video.py tilts their tops from
 * sim-liquid.js.  {after: the geom they follow, lines}; null without a puck.
 */
export function liquidXml(L) {
  const lp = L && L.props && L.props[0], Q = lp && lp.liquid;
  if (!Q) return null;
  const m = (x) => fmt(x / 1000), z1 = Q.z_rest_mm, z0 = Q.z_low_mm, VIS = 'group="1" contype="0" conaffinity="0" mass="0"';
  const cyl = (name, h, z, rgba, [x, y]) => `      <geom name="${lp.id}_${name}" type="cylinder" pos="${v3([x / 1000, y / 1000, z / 1000])}" size="${m(Q.r_mm)} ${m(h / 2)}" rgba="${v3(rgba)}" ${VIS}/>`;
  const lines = Q.wells.flatMap((w, k) => [
    cyl(`liquid_${k + 1}`, z1 - z0, (z0 + z1) / 2, [...Q.tints[k], 0.82], w),
    cyl(`meniscus_${k + 1}`, MENISCUS_MM, z1 - MENISCUS_MM / 2 + 0.2, [...Q.tints[k].map((c) => 0.5 + 0.5 * c), 0.9], w)]);
  return { after: `${lp.id}_cap_${Q.wells.length}`, lines };
}

/** MJCF lines for the lab, indented for <worldbody>: the stations, then the props. */
export function labXml(scene, L) {
  const A = [], D = scene.defaults;
  for (const s of scene.stations) stationXml(s, L.stations.find((x) => x.id === s.id), { ...D.nest, ...s.nest }.at, L, A);
  for (const p of scene.props) puckXml(p, L.props.find((x) => x.id === p.id), A);
  return A;
}
