/* The lab's visual layer: assets/scenes/lab/decor.json (rps/decor@1) resolved against the sidecar's
   lab block (rps/lab@2) into world-mm placements, the props meshes, the animated nodes (`lab.anim`)
   and the decor as MJCF.  Every decor geom is group 1, contype 0, conaffinity 0, density 0; the
   scenery's own collision geoms move to group 3.  No imports: build.mjs also bundles this file
   into site/vendor/lab-scene.js. */

export const DECOR_GROUP = 1, SCENERY_COLLISION_GROUP = 3;
const SHAPES = ['box', 'cyl', 'bar', 'mesh'];
const ANIM_KINDS = ['hinge', 'led', 'bars', 'slide', 'loop'];

export const fmt = (x) => {
  const v = +x;
  if (!Number.isFinite(v)) throw new Error(`sim: not a number: ${x}`);
  return Math.abs(v) < 1e-12 ? '0' : String(+v.toPrecision(9));
};
export const v3 = (a) => Array.from(a, fmt).join(' ');

/** (x, y) turned by yaw degrees CCW; exact at multiples of 90. */
export function rotXY(yaw, [x, y]) {
  const a = yaw * Math.PI / 180, snap = (v) => (Math.abs(v - Math.round(v)) < 1e-12 ? Math.round(v) : v);
  const c = snap(Math.cos(a)), s = snap(Math.sin(a));
  return [x * c - y * s, x * s + y * c];
}

/** Station frames from the lab block: the centre of the plinth's front edge, local +Y into the station. */
export function stationFrames(lab) {
  return lab.stations.map((s) => {
    const [ux, uy] = rotXY(s.yaw, [0, 1]), R = s.plinth_rect;
    const depth = Math.abs(ux) * (R.x[1] - R.x[0]) + Math.abs(uy) * (R.y[1] - R.y[0]);
    const cx = (R.x[0] + R.x[1]) / 2 - ux * depth / 2, cy = (R.y[0] + R.y[1]) / 2 - uy * depth / 2;
    return { id: s.id, x: cx + 0, y: cy + 0, z: 0, yaw: s.yaw };
  });
}

/* frames an item can sit in: `world`, a station id, a prop id (rides that free body) */
function frames(lab) {
  const out = { world: [{ x: 0, y: 0, z: 0, yaw: 0 }] };
  for (const f of stationFrames(lab)) out[f.id] = [f];
  for (const p of lab.props) out[p.id] = [{ x: 0, y: 0, z: 0, yaw: 0, body: p.body }];
  return out;
}

/** A z value: mm above the frame origin, or "T", "T+n", "T-n" relative to the deck height T. */
export function zOf(v, top) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const m = typeof v === 'string' && /^T(?:([+-])(\d+(?:\.\d+)?))?$/.exec(v);
  if (!m) throw new Error(`decor: bad z "${v}"`);
  return top + (m[1] ? (m[1] === '-' ? -1 : 1) * +m[2] : 0);
}

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const isZ = (v) => num(v) || (typeof v === 'string' && /^T(?:[+-]\d+(?:\.\d+)?)?$/.test(v));
const vec = (v, n, ok = num) => Array.isArray(v) && v.length === n && v.every(ok);
const rgbaOk = (c) => vec(c, 4, (x) => num(x) && x >= 0 && x <= 1);

/** Schema problems of a decor document, [] when valid.  `meshes`: the prop names on hand;
 *  `lab`: the lab block, for the frame names (stations, props). */
export function validateDecor(d, meshes = null, lab = null) {
  const err = [];
  if (!d || d.schema !== 'rps/decor@1') return ['schema is not rps/decor@1'];
  const M = d.materials || {};
  for (const [k, m] of Object.entries(M)) {
    if (!rgbaOk(m.rgba)) err.push(`material ${k}: rgba`);
    for (const f of ['rough', 'metal', 'emit']) if (m[f] != null && !(num(m[f]) && m[f] >= 0 && m[f] <= 1)) err.push(`material ${k}: ${f}`);
  }
  for (const k of ['top', 'bottom']) if (!vec(d.sky && d.sky[k], 3)) err.push(`sky.${k}`);
  const F = d.floor || {};
  if (!(num(F.tile) && F.tile > 0) || !vec(F.rgb1, 3) || !vec(F.rgb2, 3) || !vec(F.grout, 3)) err.push('floor');
  if (!vec(d.ambient, 3) || !vec(d.headlight, 3)) err.push('ambient / headlight');
  if (!Array.isArray(d.lights) || !d.lights.length) err.push('lights');
  for (const [i, l] of (d.lights || []).entries()) if (typeof l.name !== 'string' || !vec(l.pos, 3) || !vec(l.dir, 3) || !vec(l.diffuse, 3)) err.push(`light ${i}`);
  const A = d.anim || {};
  for (const [k, a] of Object.entries(A)) {
    if (!/^[a-z]+\.[a-z]+$/.test(k) || !ANIM_KINDS.includes(a.kind)) err.push(`anim ${k}: node name or kind`);
    for (const c of Object.values(a.colors || {})) if (!rgbaOk(c)) err.push(`anim ${k}: colors`);
  }
  const fr = lab ? frames(lab) : null, props = new Set(lab ? lab.props.map((p) => p.id) : []), names = new Set();
  if (!Array.isArray(d.items) || !d.items.length) err.push('items');
  for (const [i, it] of (d.items || []).entries()) {
    const at = it.at || 'world', s = SHAPES.filter((k) => k in it);
    const e = (w) => err.push(`item ${i}: ${w}`);
    if (s.length !== 1) { e('needs exactly one of box, cyl, bar, mesh'); continue; }
    if (fr && !fr[at]) e(`unknown frame "${at}"`);
    if (!M[it.mat]) e(`unknown material "${it.mat}"`);
    const zs = s[0] === 'box' || s[0] === 'cyl' ? it.z : s[0] === 'bar' ? [it.a && it.a[2], it.b && it.b[2]] : [it.xyz ? it.xyz[2] : 0];
    if (!Array.isArray(zs) || !zs.every(isZ) || (props.has(at) && zs.some((z) => typeof z === 'string'))) e('z');
    if (s[0] === 'box' && !(vec(it.box, 2) && vec(it.xy, 2) && vec(it.z, 2, isZ))) e('box needs box [w, d], xy, z [lo, hi]');
    if (s[0] === 'cyl' && !(num(it.cyl) && vec(it.xy, 2) && vec(it.z, 2, isZ))) e('cyl needs cyl r, xy, z [lo, hi]');
    if (s[0] === 'bar' && !(num(it.bar) && vec(it.a, 3, isZ) && vec(it.b, 3, isZ))) e('bar needs bar r, a, b');
    if (s[0] === 'mesh' && !(typeof it.mesh === 'string' && (it.xyz == null || vec(it.xyz, 3, isZ)))) e('mesh needs mesh, xyz');
    if (s[0] === 'mesh' && meshes && !meshes.has(it.mesh)) e(`no prop mesh "${it.mesh}"`);
    if (it.yaw != null && !num(it.yaw)) e('yaw');
    const nodes = it.anim == null ? [] : [it.anim].flat();
    for (const n of nodes) if (!A[n]) e(`unknown anim node "${n}"`);
    if (nodes.length && (!/^anim_[a-z]+_[a-z]+_\d+$/.test(it.name || '') || props.has(at))) e('an animated item needs a name anim_<station>_<part>_<k> and a world or station frame');
    if (it.name != null && (!/^[a-z][a-z0-9_]*$/.test(it.name) || names.has(it.name) || (!nodes.length && it.name.startsWith('anim_')))) e(`name "${it.name}": unique, [a-z0-9_], anim_ only on animated items`);
    if (it.name != null) names.add(it.name);
  }
  return err;
}

/**
 * Every decor placement for a lab block, world mm, floor z = 0.
 * @returns {{kind:'box'|'cyl'|'bar'|'mesh', mat:string, body:string|null, at:string, pos:number[], yaw:number,
 *   size?:number[], r?:number, h?:number, a?:number[], b?:number[], mesh?:string, anim?:string[], name?:string}[]}
 *   With `body` set, pos/yaw/a/b are in that free body's frame.
 */
export function decorPlan(d, lab) {
  const top = lab.T_mm, fr = frames(lab), out = [];
  for (const it of d.items) {
    const kind = SHAPES.find((k) => k in it), at = it.at || 'world';
    const f = fr[at] && fr[at][0];
    if (!f) throw new Error(`decor: unknown frame "${at}"`);
    const P = (x, y, z) => { const [u, v] = rotXY(f.yaw, [x, y]); return [f.x + u, f.y + v, f.z + zOf(z, top)]; };
    const o = { kind, mat: it.mat, body: f.body || null, at, yaw: f.yaw + (it.yaw || 0) };
    if (it.name) o.name = it.name;
    if (it.anim) o.anim = [it.anim].flat();
    if (kind === 'box' || kind === 'cyl') {
      const z0 = zOf(it.z[0], top), z1 = zOf(it.z[1], top);
      o.pos = P(it.xy[0], it.xy[1], (z0 + z1) / 2);
      if (kind === 'box') o.size = [it.box[0], it.box[1], z1 - z0];
      else { o.r = it.cyl; o.h = z1 - z0; }
    } else if (kind === 'bar') {
      o.r = it.bar; o.a = P(...it.a); o.b = P(...it.b); o.pos = o.a.map((v, k) => (v + o.b[k]) / 2);
    } else {
      o.mesh = it.mesh; o.pos = P(...(it.xyz || [0, 0, 0]));
    }
    out.push(o);
  }
  return out;
}

/**
 * The animated nodes, the sidecar's `lab.anim`: one entry per decor.json `anim` node, its geoms in
 * item order, the pose data a renderer needs (world mm, absolute z).  Visual only.
 */
export function labAnim(d, lab) {
  const plan = decorPlan(d, lab), fr = Object.fromEntries(stationFrames(lab).map((f) => [f.id, f]));
  return Object.entries(d.anim || {}).map(([node, a]) => {
    const sid = node.split('.')[0], st = lab.stations.find((s) => s.id === sid) || null;
    const o = { node, station: st ? st.id : null, kind: a.kind, geoms: plan.filter((p) => p.anim && p.anim.includes(node)).map((p) => p.name) };
    if (a.kind === 'hinge') Object.assign(o, { hinge: st.lid.hinge.slice(), axis: st.lid.axis.slice(), closed_deg: st.lid.closed_deg });
    if (a.kind === 'bars') Object.assign(o, { base_z: +zOf(a.base_z, lab.T_mm).toFixed(6), max_h: a.max_h });
    if (a.kind === 'slide') {
      const [x, y] = rotXY(st ? fr[st.id].yaw : 0, a.axis);
      Object.assign(o, { axis: [x + 0, y + 0, a.axis[2]], travel: a.travel.slice(), period_s: a.period_s });
    }
    if (a.colors) o.colors = structuredClone(a.colors);
    for (const k of ['blink_hz', 'pulse_hz']) if (a[k]) o[k] = { ...a[k] };
    return o;
  });
}

/** The instrument snapshot before any instrument runs: lids open, `start` states, bars down. */
export function idleSnapshot(lab) {
  return { t: 0, stations: Object.fromEntries(lab.stations.map((s) => [s.id,
    { state: s.start || 'idle', closure: 0, progress: 0, ...(s.result ? { bars: s.result.map(() => 0) } : {}) }])) };
}

/** One OBJ as make_lab.py writes it (`f a//a`) -> {position f32, normal i8 (x127), index u32}. */
export function parseObj(text) {
  const v = [], n = [], idx = [];
  for (const line of text.split('\n')) {
    const t = line.split(' ');
    if (t[0] === 'v') v.push(+t[1], +t[2], +t[3]);
    else if (t[0] === 'vn') n.push(Math.round(+t[1] * 127), Math.round(+t[2] * 127), Math.round(+t[3] * 127));
    else if (t[0] === 'f') for (const c of t.slice(1)) {
      const [a, , b] = c.split('/');
      if (a !== b) throw new Error('decor: an OBJ with split vertex / normal indices');
      idx.push(+a - 1);
    }
  }
  return { position: new Float32Array(v), normal: new Int8Array(n), index: new Uint32Array(idx) };
}

/** The props a plan uses as MuJoCo .msh files (vertices, normals, faces): Map<file, bytes>. */
export function meshFiles(scene, lab) {
  const used = [...new Set(decorPlan(scene.decor, lab).filter((p) => p.kind === 'mesh').map((p) => p.mesh))].sort();
  const out = new Map();
  for (const name of used) {
    const g = scene.meshes.get(name);
    if (!g) throw new Error(`decor: no props mesh "${name}"`);
    const nv = g.position.length / 3, nf = g.index.length / 3;
    const b = new ArrayBuffer(16 + 24 * nv + 12 * nf), h = new Int32Array(b, 0, 4);
    h[0] = nv; h[1] = nv; h[3] = nf;
    new Float32Array(b, 16, 3 * nv).set(g.position);
    new Float32Array(b, 16 + 12 * nv, 3 * nv).set(Array.from(g.normal, (x) => x / 127));
    new Int32Array(b, 16 + 24 * nv, 3 * nf).set(g.index);
    out.set(`decor_${name}.msh`, new Uint8Array(b));
  }
  return out;
}

const m = (a) => a.map((x) => x / 1000);
const quatYaw = (deg) => { const h = deg * Math.PI / 360; return Math.abs(Math.sin(h)) < 1e-12 ? '' : ` quat="${v3([Math.cos(h), 0, 0, Math.sin(h)])}"`; };

function materialXml(name, x) {
  const rough = x.rough ?? 0.6, metal = x.metal ?? 0;
  const spec = Math.min(1, 0.08 + 0.5 * (1 - rough) + 0.3 * metal), shine = Math.min(1, 0.05 + 0.9 * (1 - rough));
  return `    <material name="dm_${name}" rgba="${v3(x.rgba)}" specular="${fmt(spec)}" shininess="${fmt(shine)}"${x.emit ? ` emission="${fmt(x.emit)}"` : ''}/>`;
}

function geomXml(p, ind) {
  const mat = `${p.name ? ` name="${p.name}"` : ''} material="dm_${p.mat}"`;
  if (p.kind === 'box') return `${ind}<geom class="decor"${mat} type="box" size="${v3(m(p.size).map((x) => x / 2))}" pos="${v3(m(p.pos))}"${quatYaw(p.yaw)}/>`;
  if (p.kind === 'cyl') return `${ind}<geom class="decor"${mat} type="cylinder" size="${v3(m([p.r, p.h / 2]))}" pos="${v3(m(p.pos))}"/>`;
  if (p.kind === 'bar') return `${ind}<geom class="decor"${mat} type="capsule" size="${fmt(p.r / 1000)}" fromto="${v3(m([...p.a, ...p.b]))}"/>`;
  return `${ind}<geom class="decor"${mat} type="mesh" mesh="decor_${p.mesh}" pos="${v3(m(p.pos))}"${quatYaw(p.yaw)}/>`;
}

/**
 * The decor added to a model's MJCF text (sim-mjcf.js emitXml, which already lists meshFiles()
 * as mesh assets): sky, tiled floor, room lights, materials, a static `decor` body last in the
 * worldbody (no body or geom index before it moves) and the prop visuals inside the prop
 * bodies.  `env`: the scenery bodies.
 */
export function decorXml(xml, lab, d, env) {
  const plan = decorPlan(d, lab), F = d.floor, S = d.sky, L = xml.split('\n');
  const scenery = new Set(env.filter((b) => b !== 'world' && b !== 'decor'));
  const onBody = new Map();
  for (const p of plan) if (p.body) onBody.set(p.body, [...(onBody.get(p.body) || []), p]);
  const last = new Map();                              // body -> line of its last geom (flat scenery bodies)
  let body = null;
  L.forEach((line, i) => {
    const b = /^\s*<body name="([^"]+)"/.exec(line);
    if (b) body = b[1];
    else if (/^\s*<\/body>/.test(line)) body = null;
    else if (body && /^\s*<geom /.test(line)) last.set(body, i);
  });
  const out = [];
  body = null;
  for (const [i, line0] of L.entries()) {
    let line = line0;
    const b = /^\s*<body name="([^"]+)"/.exec(line);
    if (b) body = b[1];
    if (line === '  </default>') {
      out.push('    <default class="decor">', `      <geom group="${DECOR_GROUP}" contype="0" conaffinity="0" density="0"/>`, '    </default>');
    } else if (/^\s*<texture name="grid"/.test(line)) {
      out.push(`    <texture name="sky" type="skybox" builtin="gradient" rgb1="${v3(S.top)}" rgb2="${v3(S.bottom)}" width="512" height="3072"/>`);
      line = `    <texture name="grid" type="2d" builtin="flat" rgb1="${v3(F.rgb1)}" mark="edge" markrgb="${v3(F.grout)}" width="256" height="256"/>`;
    } else if (/^\s*<material name="floor"/.test(line)) {        // a plane texture repeats per 2 m
      line = `    <material name="floor" texture="grid" texrepeat="${fmt(2000 / F.tile)} ${fmt(2000 / F.tile)}" texuniform="true" reflectance="${fmt(F.reflect || 0)}"/>`;
      for (const k of [...new Set(plan.map((p) => p.mat))].sort()) out.push(materialXml(k, d.materials[k]));
    } else if (/^\s*<mesh name="decor_/.test(line)) {
      line = line.replace(/ inertia="\w+"/, ' inertia="shell"');         // visual only: no hull
    } else if (/^\s*<light name="key"/.test(line)) {
      line = d.lights.map((l) => `    <light name="${l.name}" pos="${v3(m(l.pos))}" dir="${v3(l.dir)}" directional="true" diffuse="${v3(l.diffuse)}" specular="0.2 0.2 0.2" castshadow="${l.shadow ? 'true' : 'false'}"/>`).join('\n');
    } else if (/^\s*<visual>/.test(line) && !/<headlight/.test(line)) {
      const q = d.shadow || {};
      line = line.replace('</visual>', `<headlight ambient="${v3(d.ambient)}" diffuse="${v3(d.headlight)}" specular="0.05 0.05 0.05"/>`
        + `<quality shadowsize="${q.size || 4096}"/></visual>`);
      if (q.clip) line = line.replace(/<map ([^/]*)\/>/, (s, a) => `<map ${a} shadowclip="${fmt(q.clip)}"/>`);
    } else if (body && scenery.has(body) && /^\s*<geom /.test(line) && !/ group="/.test(line)) {
      line = line.replace('<geom ', `<geom group="${SCENERY_COLLISION_GROUP}" `);
    } else if (line === '  </worldbody>') {
      out.push('    <body name="decor">', ...plan.filter((p) => !p.body).map((p) => geomXml(p, '      ')), '    </body>');
    }
    out.push(line);
    if (body && last.get(body) === i && onBody.has(body)) out.push(...onBody.get(body).map((p) => geomXml(p, /^(\s*)/.exec(line)[1])));
    if (/^\s*<\/body>/.test(line)) body = null;
  }
  return out.join('\n');
}
