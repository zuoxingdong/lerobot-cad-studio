/* The baked lab in the Sim tab (built into site/vendor/baked-lab.js, loaded on first use): the
   lightmapped static set of ui/baked-lab.js split into cut-away zones per wall of lab.room, drawn
   without direct lights (the bake holds them); the bake's station movers (lids, gantry, head, hood,
   LEDs, bars) riding the room's animated nodes, which ui/sim-room.js applyInstruments poses and
   tints; the probe as the environment, and the key and fill for the robot. Room-local mm, the bake
   is metres. */
import * as THREE from 'three';
import { Looks, kelvinRgb } from './showcase-looks.js';
import { loadBaked, setLooks, labMaterial } from './baked-lab.js';
import { onWall } from './sim-room.js';
import { createCables } from './robot-cables.js';
import { fabric, coverPress, PRESS_EPS } from './robot-look.js';

const MM = 1000, WELD = 1e4;                        // positions welded at 0.1 mm
/* a floor decal (tape, seams, stencils: 0.05-0.4 mm up) gets a polygon offset: a part this thin and low,
   of less area than a floor tile run.  Raised thin plates do not: a mover's LED in front of one would sink into it. */
const DECAL_MM = 3, DECAL_MM2 = 1e6;
/* the robot's lights: the showcase key (manifest light.key, key_kelvin) and a faint fill; the probe does the rest */
const KEY = { pos: [900, -1100, 2600], at: [-100, 450, 0] }, FILL = 0.05;
/* the Sim has no bloom: the movers' LEDs, bars and glow at this share keep their hue through the tone curve */
const EMIT = 0.3;
/* the robot's dress in the bake's movers: every robot node but the package's own parts (`part`, the Design meshes):
   the Pi, the driver board, the camera modules, screws, the fingertip covers, the strap, the battery in its tray,
   the switch, stickers and pads; on a wheel body the whole omni wheel, which rides the Design wheel's spin */
const NOT_DRESSED = /^(puck|decor|world)/, WHEEL_BODY = /_wheel$/, DECAL = /^label/;

/* the four walls of lab.room, faces at its edges, as sim-room.js wallOf */
function roomWalls(r) {
  return [['y', 'x', 1, r.y[1]], ['y', 'x', -1, r.y[0]], ['x', 'y', 1, r.x[1]], ['x', 'y', -1, r.x[0]]]
    .map(([a, o, s, c]) => ({ a, o, s, c, lo: r[o][0], hi: r[o][1] }));
}

/* the node in room mm: positions, normals and the lightmap UV as floats, the index */
function flat(o) {
  const g = o.geometry, Mw = o.matrixWorld, Nm = new THREE.Matrix3().getNormalMatrix(Mw);
  const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv, v = new THREE.Vector3();
  const P = new Float32Array(3 * p.count), N = new Float32Array(3 * p.count), U = uv ? new Float32Array(2 * p.count) : null;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).applyMatrix4(Mw).multiplyScalar(MM).toArray(P, 3 * i);
    if (n) v.fromBufferAttribute(n, i).applyMatrix3(Nm).normalize().toArray(N, 3 * i);
    if (U) { U[2 * i] = uv.getX(i); U[2 * i + 1] = uv.getY(i); }
  }
  const I = g.index ? g.index.array : Uint32Array.from({ length: p.count }, (_, i) => i);
  return { P, N, U, I, n: p.count };
}

/* connected parts (welded by position): per vertex its part, per part its box and area */
function parts({ P, I, n }) {
  const up = Int32Array.from({ length: n }, (_, i) => i), at = new Map();
  const find = (i) => { while (up[i] !== i) { up[i] = up[up[i]]; i = up[i]; } return i; };
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) up[a] = b; };
  for (let i = 0; i < n; i++) {
    const k = (Math.round(P[3 * i] * WELD / MM) * 131072 + Math.round(P[3 * i + 1] * WELD / MM)) * 131072 + Math.round(P[3 * i + 2] * WELD / MM);
    if (at.has(k)) join(i, at.get(k)); else at.set(k, i);
  }
  for (let t = 0; t < I.length; t += 3) { join(I[t], I[t + 1]); join(I[t], I[t + 2]); }
  const root = new Int32Array(n), box = new Map(), area = new Map(), t = new THREE.Triangle();
  for (let i = 0; i < n; i++) {
    const r = root[i] = find(i);
    const b = box.get(r) || box.set(r, new THREE.Box3()).get(r);
    b.expandByPoint(new THREE.Vector3(P[3 * i], P[3 * i + 1], P[3 * i + 2]));
  }
  for (let k = 0; k < I.length; k += 3) {
    t.a.fromArray(P, 3 * I[k]); t.b.fromArray(P, 3 * I[k + 1]); t.c.fromArray(P, 3 * I[k + 2]);
    area.set(root[I[k]], (area.get(root[I[k]]) || 0) + t.getArea());
  }
  return { root, box, area };
}

/* the triangles of one (zone, decal) bucket as a compact geometry */
function subGeometry(f, tris) {
  const map = new Int32Array(f.n).fill(-1), idx = new Uint32Array(tris.length);
  let m = 0;
  tris.forEach((v, k) => { if (map[v] < 0) map[v] = m++; idx[k] = map[v]; });
  const P = new Float32Array(3 * m), N = new Float32Array(3 * m), U = f.U ? new Float32Array(2 * m) : null;
  for (let i = 0; i < f.n; i++) {
    const j = map[i];
    if (j < 0) continue;
    P.set(f.P.subarray(3 * i, 3 * i + 3), 3 * j);
    N.set(f.N.subarray(3 * i, 3 * i + 3), 3 * j);
    if (U) U.set(f.U.subarray(2 * i, 2 * i + 2), 2 * j);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  if (U) g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

/* the station movers of the bake by the capture geom they ride, without the robot, the puck and the liquids */
function stationMovers(scene, M) {
  const run = M.run || {}, bodyPoses = new Set(Object.values(run.bodies || {})), out = new Map();
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    const info = o.isMesh && M.movers.nodes[o.name], g = info && (run.geoms || {})[String(info.g)];
    if (!info || !g || g.shear !== undefined || bodyPoses.has(g.pose)) return;
    if (!out.has(info.g)) out.set(info.g, { box: new THREE.Box3(), nodes: [] });
    const e = out.get(info.g);
    e.nodes.push({ o, info });
    if (!info.prim) e.box.union(new THREE.Box3().setFromObject(o).applyMatrix4(new THREE.Matrix4().makeScale(MM, MM, MM)));
  });
  return out;
}

/* each mover group to the nearest animated mesh of the room (its rest pose is the capture's frame 0) */
function matchMovers(groups, animated) {
  const c = new THREE.Vector3(), d = new THREE.Vector3(), cand = [];
  for (const [g, e] of groups) {
    if (e.box.isEmpty()) {                                  // unit primitives (bars): matched by order below
      e.prim = true;
      continue;
    }
    e.box.getCenter(c);
    for (const [name, mesh] of animated) {
      const b = mesh.geometry.boundingBox;
      const dist = b.getCenter(d).distanceTo(c) / (b.getSize(d).length() + e.box.getSize(new THREE.Vector3()).length() + 10);
      if (dist < 0.5) cand.push({ g, name, dist });
    }
  }
  const pairs = new Map(), used = new Set();
  for (const x of cand.sort((a, b) => a.dist - b.dist)) {
    if (pairs.has(x.g) || used.has(x.name)) continue;
    pairs.set(x.g, x.name);
    used.add(x.name);
  }
  // bars: the capture geoms and the decor's bar items are both in decor order
  const bars = [...groups].filter(([, e]) => e.prim).map(([g]) => g).sort((a, b) => a - b);
  const slots = [...animated].filter(([n]) => /_bar_\d+$/.test(n) && !used.has(n)).map(([n]) => n);
  bars.forEach((g, k) => { if (slots[k]) pairs.set(g, slots[k]); });
  return pairs;
}

/* the dress by body: meshes carried by MuJoCo's body (rel: body frame -> room mm, from the run's frame 0) */
function robotDress(scene, M, looks) {
  const run = M.run || {}, body0 = run.body0 || {}, byPose = new Map(), out = [];
  for (const [b, k] of Object.entries(run.bodies || {})) if (!NOT_DRESSED.test(b) && body0[b]) byPose.set(k, b);
  const S = new THREE.Matrix4().makeScale(MM, MM, MM), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    const info = o.isMesh && M.movers.nodes[o.name], g = info && (run.geoms || {})[String(info.g)];
    const body = g && byPose.get(g.pose), wheel = body && WHEEL_BODY.test(body);
    if (!body || info.part) return;
    const b0 = body0[body], inv = new THREE.Matrix4().compose(p.fromArray(b0, 0), q.set(b0[4], b0[5], b0[6], b0[3]), one).invert();
    const film = DECAL.test(info.mat);                      // a sticker film on a Design face: drawn over it
    const base = looks.get(info.mat, info.color, film), spec = looks.spec(info.mat);
    const own = !film && (spec.knit || spec.bump) && fabric(base.clone(), spec, inv.clone().multiply(o.matrixWorld));
    const mesh = new THREE.Mesh(o.geometry, own || base);
    mesh.userData.own = !!own;                              // the covers' faces: a material of its own
    if (film) Object.assign(mesh.material, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    mesh.userData.film = film;
    mesh.name = 'dress:' + o.name;
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;                                   // until its body is posed
    mesh.userData.rel = S.clone().multiply(inv).multiply(o.matrixWorld);
    mesh.userData.body = body;
    if (wheel) mesh.userData.wheel = body;
    mesh.renderOrder = mesh.material.transparent ? 2 : 0;
    out.push(mesh);
  });
  return out;
}

/**
 * The static set in room mm, split per node into buckets: [{name, info, zone ('' or wall indices),
 * walls, decal, geometry}].  A part (welded by position) joins the zone of each wall of lab.room it
 * stands along (sim-room.js onWall) unless it is on a plinth; floor decals are kept apart.
 */
export function splitSet(scene, M, lab) {
  const walls = roomWalls(lab.room), plinths = lab.stations.map((s) => s.plinth_rect);
  const onPlinth = (b) => plinths.some((r) => b.max.x > r.x[0] - 50 && b.min.x < r.x[1] + 50 && b.max.y > r.y[0] - 50 && b.min.y < r.y[1] + 50);
  const out = [], nodes = [];
  scene.updateMatrixWorld(true);
  scene.traverse((o) => { if (o.isMesh) nodes.push(o); });
  for (const o of nodes) {
    const info = M.lab.nodes[o.name] || { mat: o.material.name, color: null };
    const f = flat(o), { root, box, area } = parts(f), key = new Map(), buckets = new Map();
    for (const [r, b] of box) {
      const k = onPlinth(b) ? '' : walls.map((w, i) => (onWall(w, b) ? i : -1)).filter((i) => i >= 0).join(',');
      const e = b.getSize(new THREE.Vector3()).toArray().sort((x, y) => x - y);
      key.set(r, k + '|' + (e[0] <= DECAL_MM && b.max.z <= DECAL_MM && area.get(r) < DECAL_MM2 ? 'd' : ''));
    }
    for (let t = 0; t < f.I.length; t += 3) {
      const k = key.get(root[f.I[t]]);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(f.I[t], f.I[t + 1], f.I[t + 2]);
    }
    for (const [k, tris] of buckets) {
      const [zone, decal] = k.split('|');
      out.push({ name: o.name, info, zone, walls: zone ? zone.split(',').map((i) => walls[+i]) : [], decal: decal === 'd',
        geometry: subGeometry(f, tris) });
    }
  }
  return out;
}

/**
 * Loads the bake and builds it for `room` (ui/sim-room.js createRoom): {group, zones, env, paint(),
 * stats, dispose()}; `onBytes(n, total)` reports the download.  The robot's dress and cables are the
 * captured design's: only when `design` (the session's design hash) is that one, or not given.
 */
export async function buildBakedRoom({ manifest: M, renderer, room, lab, onBytes, cache, design = null }) {
  const src = await (cache.baked || (cache.baked = loadBaked(M, { renderer, onBytes }).catch((e) => { cache.baked = null; throw e; })));
  const group = new THREE.Group(), looks = setLooks(M), disposables = [];
  group.name = 'sim-room:baked';
  const pm = new THREE.PMREMGenerator(renderer), rt = pm.fromEquirectangular(src.probe);
  pm.dispose();
  src.probe.dispose();                                     // the GPU copy; the data stays for the next session
  const env = rt.texture;

  /* the static set, drawn without direct lights, in one group per cut-away zone */
  const zones = new Map();
  let lit = 0;
  const set = splitSet(src.lab, M, lab);
  for (const x of set) {
    if (!zones.has(x.zone)) {
      const z = new THREE.Group();
      z.name = x.zone ? 'sim-room:wall-baked' + x.zone : 'sim-room:baked-set';
      group.add(z);
      zones.set(x.zone, { group: z, walls: x.walls });
    }
    const m = labMaterial(looks, M, x.info, src.lightmaps, { env, normals: src.normals, unlit: true, decal: x.decal });
    const mesh = new THREE.Mesh(x.geometry, m);
    mesh.name = 'baked:' + x.name;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = m.transparent ? 2 : 0;
    zones.get(x.zone).group.add(mesh);
    disposables.push(x.geometry, m);
    if (m.lightMap) lit++;
  }

  /* the station movers on the animated meshes they replace (hidden, still posed) */
  const groups = stationMovers(src.movers, M), pairs = matchMovers(groups, room.animated), tinted = [];
  const S = new THREE.Matrix4().makeScale(MM, MM, MM), c = new THREE.Vector3(), h = new THREE.Vector3();
  for (const [g, name] of pairs) {
    const P = room.animated.get(name);
    P.material.visible = false;
    for (const { o, info } of groups.get(g).nodes) {
      const own = !!info.tint;
      const m = looks.get(info.mat, info.color, own), mesh = new THREE.Mesh(o.geometry, m);
      if (info.prim) {                                       // a unit box [-1, 1]^3 fitted to the bar
        P.geometry.boundingBox.getCenter(c);
        P.geometry.boundingBox.getSize(h).multiplyScalar(0.5);
        mesh.matrix.makeTranslation(c.x, c.y, c.z).multiply(new THREE.Matrix4().makeScale(h.x, h.y, h.z));
      } else mesh.matrix.multiplyMatrices(S, o.matrixWorld);
      mesh.matrixAutoUpdate = false;
      mesh.name = 'baked:' + o.name;
      mesh.renderOrder = m.transparent ? 2 : 0;
      P.add(mesh);
      disposables.push(o.geometry);
      if (own) { tinted.push({ m, P }); disposables.push(m); }
    }
  }

  const dressed = !design || (M.run || {}).design_hash === design;
  const dress = dressed ? robotDress(src.movers, M, looks) : [];
  const press = coverPress(dress.filter((d) => d.userData.own).map((d) => ({ mesh: d, key: d.userData.body })), PRESS_EPS);
  for (const d of dress) { group.add(d); disposables.push(d.geometry, ...(d.userData.film || d.userData.own ? [d.material] : [])); }
  const cables = createCables(dressed ? M.cables : [], looks, { scale: MM });
  group.add(cables.group);
  cables.group.visible = false;                              // until the bodies are posed
  /* frame-0 world m -> room mm now: the body's pose (room mm) x S x its frame-0 pose^-1 */
  const from0 = new Map();
  for (const [b, v] of Object.entries((M.run || {}).body0 || {})) {
    from0.set(b, new THREE.Matrix4().makeScale(MM, MM, MM).multiply(new THREE.Matrix4()
      .compose(new THREE.Vector3(v[0], v[1], v[2]), new THREE.Quaternion(v[4], v[5], v[6], v[3]), new THREE.Vector3(1, 1, 1)).invert()));
  }

  /* the robot's lights: the showcase key and a soft fill; the probe does the rest */
  const L = M.light || {}, kc = kelvinRgb(L.key_kelvin || 4000), col = new THREE.Color().setRGB(kc[0], kc[1], kc[2], THREE.LinearSRGBColorSpace);
  const key = new THREE.DirectionalLight(col, L.key ?? 0.1);
  key.position.set(...KEY.pos);
  key.target.position.set(...KEY.at);
  const fill = new THREE.HemisphereLight(col, col.clone().multiplyScalar(0.5), FILL);
  fill.position.set(0, 0, 1);
  group.add(key, key.target, fill);
  group.traverse((o) => { o.userData.pickable = false; o.userData.camClass = null; });

  const paint = () => {
    for (const { m, P } of tinted) if (P.userData.rgbe) Looks.paint(m, P.userData.rgbe, P.userData.rgbe[3] * EMIT, m.userData.tint);
  };
  paint();
  const _b = new THREE.Matrix4();
  return {
    group, env, paint,
    dress, cables,
    /** the dress on its bodies: body(name, out) fills out with MuJoCo's body pose in room mm, or returns false */
    poseDress(body) {
      cables.update((b, out) => (from0.has(b) && body(b, out) ? !!out.multiply(from0.get(b)) : false));
      cables.group.visible = true;
      for (const d of dress) {
        if (d.userData.wheel || !body(d.userData.body, _b)) continue;
        d.matrix.multiplyMatrices(_b, d.userData.rel);
        d.matrixWorldNeedsUpdate = true;
        d.visible = true;
      }
      if (press) press();
    },
    /** the omni wheels on the Design wheel meshes (wheelOf(body) -> Mesh, posed now), held where MuJoCo's
        wheel body put them on the first call; body() as poseDress */
    poseWheels(body, wheelOf) {
      for (const d of dress) {
        const w = d.userData.wheel && wheelOf(d.userData.wheel);
        if (!w) continue;
        w.updateWorldMatrix(true, false);
        d.parent.updateWorldMatrix(true, false);
        if (!d.userData.onWheel) {
          if (!body(d.userData.wheel, _b)) continue;
          d.userData.onWheel = w.matrixWorld.clone().invert().multiply(d.parent.matrixWorld).multiply(_b).multiply(d.userData.rel);
        }
        d.matrix.copy(d.parent.matrixWorld).invert().multiply(w.matrixWorld).multiply(d.userData.onWheel);
        d.matrixWorldNeedsUpdate = true;
        d.visible = true;
      }
    },
    zones: [...zones.values()].filter((z) => z.walls.length),
    stats: { nodes: new Set(set.map((x) => x.name)).size, meshes: set.length, lightmapped: lit,
      zones: zones.size - (zones.has('') ? 1 : 0), movers: pairs.size, dress: dress.length, cables: dressed ? (M.cables || []).length : 0,
      cable_tris: cables.tris,
      dress_tris: dress.reduce((n, d) => n + (d.geometry.index ? d.geometry.index.count : d.geometry.attributes.position.count) / 3, 0) },
    dispose() {
      cables.dispose();
      group.removeFromParent();
      for (const [, name] of pairs) {
        const P = room.animated.get(name);
        P.material.visible = true;
        P.clear();
      }
      for (const x of [...disposables, ...looks.cache.values()]) x.dispose();
      for (const t of [...src.lightmaps, ...(src.normals || [])]) if (t) t.dispose();
      rt.dispose();
    },
  };
}
