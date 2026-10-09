/* The lab room in the Sim tab: the same decor plan as the MJCF (features/sim-scene-decor.js)
   drawn with three.js: static props merged per material, the prop visuals as posable groups, the
   animated instrument parts (lids, LEDs, bars, gantry, dashboard) posed from an instrument
   snapshot, a tiled floor, soft contact shadows and the room lights; walls cut away when the eye
   is behind them.  Decals (tape, labels, tags, screens) sit >= 1.2 mm off their surface in the
   decor and get a polygon offset here.  `useBaked` swaps the static decor for the baked lab
   (ui/sim-baked.js).  World mm, floor z = 0; the caller parents `group` in the robot frame.  THREE is
   passed in: build.mjs bundles this file into site/vendor/lab-scene.js, so it imports no three. */

import { decorPlan, labAnim, idleSnapshot } from '../features/sim-scene-decor.js';

/* a part this thin is a decal on some surface; the contact shadows lie above the floor decals */
const DECAL_MM = 3, SHADOW_Z = 4.8;
const thin = (b) => Math.min(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) <= DECAL_MM;
const rgb = (THREE, c) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);

function canvasTexture(THREE, size, draw) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  draw(cv.getContext('2d'), size);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* one indexed geometry from many (position + normal only) */
function merge(THREE, list) {
  let nv = 0, ni = 0;
  for (const g of list) { nv += g.attributes.position.count; ni += g.index.count; }
  const P = new Float32Array(3 * nv), N = new Float32Array(3 * nv), I = new Uint32Array(ni);
  let v = 0, i = 0;
  for (const g of list) {
    const p = g.attributes.position, n = g.attributes.normal, x = g.index;
    for (let k = 0; k < p.count; k++) {
      P.set([p.getX(k), p.getY(k), p.getZ(k)], 3 * (v + k));
      N.set([n.getX(k), n.getY(k), n.getZ(k)], 3 * (v + k));
    }
    for (let k = 0; k < x.count; k++) I[i + k] = x.getX(k) + v;
    v += p.count; i += x.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  out.setIndex(new THREE.BufferAttribute(I, 1));
  return out;
}

/* A wall is a tall thin box; its room face is the side nearer the origin. */
function wallOf(b) {
  const sx = b.max.x - b.min.x, sy = b.max.y - b.min.y;
  if (b.max.z - b.min.z < 2000 || Math.min(sx, sy) > 200 || Math.max(sx, sy) < 2000) return null;
  const a = sx < sy ? 'x' : 'y', o = a === 'x' ? 'y' : 'x', s = b.min[a] + b.max[a] > 0 ? 1 : -1;
  return { a, o, s, c: s > 0 ? b.min[a] : b.max[a], lo: b.min[o], hi: b.max[o] };
}
/* cut with a wall: all of it within 900 mm of the face (hood, perimeter bench, shelf, window),
   so nothing along it stands between the eye and the benches */
const BAND = 900;
export function onWall(w, b) {
  const reach = w.s > 0 ? w.c - b.min[w.a] : b.max[w.a] - w.c;
  return reach <= BAND && b.max[w.o] > w.lo && b.min[w.o] < w.hi;
}

/**
 * @param THREE the page's three.js
 * @param {{scene:{decor, meshes:Map}, lab:object}} o  the decor package and the sidecar's lab block
 * @returns {{group, bodies:Map<string, THREE.Object3D>, contact:THREE.Object3D, cutaway(eye),
 *   applyInstruments(snapshot), dispose()}}
 *   `bodies`: the prop visuals, posed by the caller in world mm; `contact`: a soft shadow disc
 *   the caller moves under the robot (x, y only); `cutaway(eye)` hides each wall the eye (room-local mm)
 *   is behind, with what hangs on it; `cutaway(null)` shows them all.  `applyInstruments(s)`
 *   poses the `sim-room:anim:<node>` groups from `{t, stations: {id: {state, closure, bars?}},
 *   loop?}` (null: the idle snapshot); each tinted mesh keeps its display [r, g, b, emission] in
 *   userData.rgbe.  `animated`: the anim meshes by geom name.  `zones()`: the cut-away groups.
 *   `useBaked({group, zones})` hides the static decor, floor and lights and cuts the baked zones.
 */
export function createRoom(THREE, { scene, lab }) {
  const d = scene.decor, group = new THREE.Group(), statics = new THREE.Group(), disposables = [];
  group.name = 'sim-room';
  statics.name = 'sim-room:decor';
  group.add(statics);
  const mats = new Map();
  const matOf = (k) => {
    if (!mats.has(k)) {
      const x = d.materials[k], color = rgb(THREE, x.rgba), a = x.rgba[3];
      const o = { color, roughness: x.rough ?? 0.6, metalness: x.metal ?? 0 };
      if (x.emit) { o.emissive = color; o.emissiveIntensity = 0.6 + x.emit; }
      if (a < 1) Object.assign(o, { transparent: true, opacity: a, depthWrite: false });
      mats.set(k, new THREE.MeshStandardMaterial(o));
    }
    return mats.get(k);
  };
  /* decals: pulled a little towards the eye on top of their 1.2 mm lift */
  const decalOf = (k) => {
    if (!mats.has('decal:' + k)) mats.set('decal:' + k, Object.assign(matOf(k).clone(), { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
    return mats.get('decal:' + k);
  };
  const Z = new THREE.Vector3(0, 0, 1), Y = new THREE.Vector3(0, 1, 0);
  function geometryOf(p) {
    let g;
    if (p.kind === 'box') g = new THREE.BoxGeometry(...p.size);
    else if (p.kind === 'cyl') g = new THREE.CylinderGeometry(p.r, p.r, p.h, 32).rotateX(Math.PI / 2);
    else if (p.kind === 'bar') {
      const a = new THREE.Vector3(...p.a), b = new THREE.Vector3(...p.b);
      g = new THREE.CylinderGeometry(p.r, p.r, a.distanceTo(b) + 2 * p.r, 16);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(Y, b.clone().sub(a).normalize()));
      return g.translate(...p.pos);
    } else {
      const m = scene.meshes.get(p.mesh);
      g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m.position), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(Float32Array.from(m.normal, (x) => x / 127), 3));
      g.setIndex(new THREE.BufferAttribute(m.index, 1));
    }
    return g.applyQuaternion(new THREE.Quaternion().setFromAxisAngle(Z, p.yaw * Math.PI / 180)).translate(...p.pos);
  }

  const buckets = new Map(), bodies = new Map(), shadows = [], plan = [], animated = new Map();
  for (const p of decorPlan(d, lab)) {
    if (p.anim) {                                      // its own mesh and material: posed and tinted
      const g = geometryOf(p);
      g.computeBoundingBox();
      const mesh = new THREE.Mesh(g, (thin(g.boundingBox) ? decalOf(p.mat) : matOf(p.mat)).clone());
      mesh.name = p.name;
      mesh.renderOrder = mesh.material.transparent ? 2 : 0;
      animated.set(p.name, mesh);
      disposables.push(mesh.geometry, mesh.material);
      continue;
    }
    if (p.body) {
      if (!bodies.has(p.body)) {
        const b = new THREE.Group();
        b.matrixAutoUpdate = false;
        b.name = 'sim-room:' + p.body;
        bodies.set(p.body, b);
        group.add(b);
      }
      const mesh = new THREE.Mesh(geometryOf(p), matOf(p.mat));
      mesh.renderOrder = matOf(p.mat).transparent ? 2 : 0;
      bodies.get(p.body).add(mesh);
      disposables.push(mesh.geometry);
      continue;
    }
    const g = geometryOf(p);
    g.computeBoundingBox();
    plan.push({ p, g, b: g.boundingBox });
  }
  /* each static world part goes to the zone of the walls it is on ('' = none); stations stay */
  const walls = plan.map((x) => wallOf(x.b)).filter(Boolean);
  const zones = new Map([['', { group: statics, walls: [] }]]);
  const zoneOf = (b) => {
    const on = walls.filter((w) => onWall(w, b));
    const k = on.map((w) => walls.indexOf(w)).join(',');
    if (!zones.has(k)) {
      const z = new THREE.Group();
      z.name = 'sim-room:wall' + k;
      statics.add(z);
      zones.set(k, { group: z, walls: on });
    }
    return k;
  };
  for (const { p, g, b } of plan) {
    const k = (p.at === 'world' ? zoneOf(b) : '') + '|' + (thin(b) ? 'decal:' : '') + p.mat;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(g);
    /* furniture standing on the floor gets a soft contact shadow */
    if (p.kind === 'box' && Math.abs(p.pos[2] - p.size[2] / 2) < 1 && p.size[0] * p.size[1] > 4e4 && p.size[2] > 30) shadows.push({ p, zone: p.at === 'world' ? zoneOf(b) : '' });
  }
  for (const [k, list] of [...buckets].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const [zone, mat] = k.split('|');
    const mesh = new THREE.Mesh(merge(THREE, list), mat.startsWith('decal:') ? decalOf(mat.slice(6)) : matOf(mat));
    mesh.name = 'sim-room:' + mat;
    mesh.matrixAutoUpdate = false;
    zones.get(zone).group.add(mesh);
    disposables.push(mesh.geometry);
  }

  /* floor: vinyl tiles with grout, one tile per texture repeat, a faint fixed speckle */
  const F = d.floor, css = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
  const tiles = canvasTexture(THREE, 256, (x, n) => {
    x.fillStyle = css(F.rgb1); x.fillRect(0, 0, n, n);
    x.fillStyle = css(F.rgb2);
    for (let i = 0, r = 7; i < 900; i++) { r = (r * 16807) % 2147483647; x.fillRect(r % n, (r >> 8) % n, 2, 2); }
    x.fillStyle = css(F.grout); x.fillRect(0, 0, n, 2); x.fillRect(0, 0, 2, n);
  });
  const span = 16000;
  tiles.wrapS = tiles.wrapT = THREE.RepeatWrapping;
  tiles.repeat.set(span / F.tile, span / F.tile);
  tiles.anisotropy = 8;
  const floorMat = new THREE.MeshStandardMaterial({ map: tiles, roughness: 0.55, metalness: 0 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(span, span), floorMat);
  floor.name = 'sim-room:floor';
  floor.position.set(0, 400, 0);
  floor.renderOrder = -1;
  statics.add(floor);
  disposables.push(floor.geometry, floorMat, tiles);

  /* contact shadows: a blurred rectangle under each floor-standing box, a disc under the robot */
  const soft = canvasTexture(THREE, 128, (x, n) => {
    const g = x.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(0.55, 'rgba(0,0,0,0.3)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, n, n);
  });
  const shadowMat = new THREE.MeshBasicMaterial({ map: soft, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  const quad = new THREE.PlaneGeometry(1, 1);
  for (const { p, zone } of shadows) {
    const s = new THREE.Mesh(quad, shadowMat);
    s.scale.set(p.size[0] + 220, p.size[1] + 220, 1);
    s.position.set(p.pos[0], p.pos[1], SHADOW_Z);
    s.rotation.z = p.yaw * Math.PI / 180;
    s.renderOrder = 1;
    zones.get(zone).group.add(s);
  }
  const contact = new THREE.Mesh(quad, shadowMat);
  contact.scale.set(520, 520, 1);
  contact.position.z = SHADOW_Z;
  contact.renderOrder = 1;
  group.add(contact);
  disposables.push(quad, shadowMat, soft);

  /* lights: sky/ground fill, the decor's key and fill directions; the Design studio set's levels */
  const hemi = new THREE.HemisphereLight(0xeef2f7, 0x8d9297, 1.0);
  hemi.position.set(0, 0, 1);
  statics.add(hemi);
  for (const l of d.lights) {
    const L = new THREE.DirectionalLight(rgb(THREE, l.diffuse.map((v) => Math.min(1, v / Math.max(...l.diffuse)))), l.shadow ? 1.5 : 0.6);
    L.position.set(...l.pos);
    L.target.position.set(l.pos[0] + l.dir[0] * 1000, l.pos[1] + l.dir[1] * 1000, l.pos[2] + l.dir[2] * 1000);
    statics.add(L, L.target);
  }
  const applyInstruments = instrumentPoser(THREE, group, lab, animated, d);
  group.traverse((o) => { o.userData.pickable = false; o.userData.camClass = null; });

  let cut = [...zones.values()].filter((z) => z.walls.length);
  return {
    group, bodies, contact, applyInstruments, animated,
    cutaway(eye) {
      for (const z of cut) z.group.visible = !eye || !z.walls.some((w) => w.s * (eye[w.a] - w.c) > 0);
    },
    zones: () => cut.map((z) => ({ name: z.group.name, walls: z.walls.map((w) => ({ a: w.a, s: w.s, c: w.c })), visible: z.group.visible })),
    useBaked(b) {
      statics.visible = !b;
      cut = b ? b.zones : [...zones.values()].filter((z) => z.walls.length);
    },
    dispose() {
      group.removeFromParent();
      for (const g of disposables) g.dispose();
      for (const m of mats.values()) m.dispose();
    },
  };
}

/* The animated nodes (lab.anim, else from the decor) as groups `sim-room:anim:<node>`: a mesh sits in
   the group of its first posed node (hinge, slide, bars), else of its first node; LED and loop
   nodes tint it.  Returns applyInstruments(snapshot). */
export const BAR_RGB = [[0.2, 0.45, 0.95], [1, 0.62, 0.1], [0.2, 0.85, 0.45], [0.95, 0.45, 0.7]], OFF_RGB = [0.25, 0.27, 0.3];
/* [colour scale, emission] of a design-build-test-learn light */
export const LOOP_LEVEL = { on: [1, 0.8], off: [1, 0] };
/** a tinted mesh's display [r, g, b, emission]: the film's rule, rgb x level and emission 0.9 x level */
export const rgbeOf = (rgba, k = 1, e = 0.9 * k) => [rgba[0] * k, rgba[1] * k, rgba[2] * k, e];
/** an LED node's level for station view `o` at t on mesh `geom`: a ring fills with the run, else the pulse
    (from the state's start), the blink or 1.  Twin: videopose.py led_colour and Poser.apply (test_instruments_parity.py) */
export function ledLevel(n, o, t, geom = '') {
  const s = o.state, blink = n.blink_hz && n.blink_hz[s], pulse = n.pulse_hz && n.pulse_hz[s];
  if (s === 'running' && geom.includes('ring')) return 0.3 + 0.7 * (o.progress || 0);
  if (pulse) return 0.55 + 0.45 * Math.cos(2 * Math.PI * pulse * (o.since || 0));
  return blink ? (Math.floor(t * 2 * blink) % 2 === 0 ? 1 : 0.25) : 1;
}
function instrumentPoser(THREE, group, lab, animated, d) {
  const nodes = (lab.anim && lab.anim.length ? lab.anim : labAnim(d, lab)).filter((n) => n.geoms.every((g) => animated.has(g)));
  const POSED = new Set(['hinge', 'slide', 'bars']), owner = new Map();
  for (const n of [...nodes.filter((x) => POSED.has(x.kind)), ...nodes]) for (const g of n.geoms) if (!owner.has(g)) owner.set(g, n.node);
  const groups = new Map();
  for (const [g, node] of owner) {
    if (!groups.has(node)) {
      const G = new THREE.Group();
      G.name = 'sim-room:anim:' + node;
      G.matrixAutoUpdate = false;
      group.add(G);
      groups.set(node, G);
    }
    const mesh = animated.get(g);
    mesh.matrixAutoUpdate = false;
    groups.get(node).add(mesh);
  }
  const resultSt = (lab.stations.find((s) => s.result) || {}).id;
  const M = new THREE.Matrix4(), A = new THREE.Matrix4(), Bm = new THREE.Matrix4(), axis = new THREE.Vector3(), c = new THREE.Color();
  let readDone = null;
  const tint = (mesh, rgba, k = 1, e = 0.9 * k) => {
    c.setRGB(rgba[0], rgba[1], rgba[2], THREE.SRGBColorSpace);
    mesh.material.color.copy(c);
    if (mesh.material.emissive) { mesh.material.emissive.copy(c); mesh.material.emissiveIntensity = (1.6 / 0.9) * e; }
    mesh.userData.rgbe = rgbeOf(rgba, k, e);
  };
  return function applyInstruments(snapshot) {
    const S = snapshot || idleSnapshot(lab), t = S.t || 0, st = (id) => (S.stations && S.stations[id]) || {};
    const r = st(resultSt).state;
    if (r === 'done' && readDone == null) readDone = t;
    if (r !== 'done') readDone = null;
    const loop = S.loop || [readDone != null && t - readDone >= 1.5, st('lh').state === 'done',
      ['closing', 'running', 'opening', 'done'].includes(st('inc').state) || ['armed', 'closing', 'running', 'opening'].includes(r), readDone != null];
    for (const n of nodes) {
      const s = st(n.station), G = groups.get(n.node);
      if (n.kind === 'hinge' && G) {
        const [hx, hy, hz] = n.hinge;
        A.makeTranslation(hx, hy, hz).multiply(M.makeRotationAxis(axis.set(...n.axis).normalize(), ((s.closure || 0) * n.closed_deg * Math.PI) / 180));
        G.matrix.copy(A.multiply(Bm.makeTranslation(-hx, -hy, -hz)));
      } else if (n.kind === 'slide' && G) {
        const [a, b] = n.travel, off = s.state === 'running' ? (a + b) / 2 + ((b - a) / 2) * Math.sin((2 * Math.PI * t) / n.period_s) : 0;
        G.matrix.makeTranslation(n.axis[0] * off, n.axis[1] * off, n.axis[2] * off);
      } else if (n.kind === 'bars') {
        const o = st(n.station || resultSt), v = o.bars || [];
        n.geoms.forEach((g, k) => {
          const mesh = animated.get(g), bb = mesh.geometry.boundingBox, h0 = bb.max.z - bb.min.z;
          const h = Math.max(1, (v[k] || 0) * n.max_h);
          mesh.matrix.makeTranslation(0, 0, n.base_z).multiply(M.makeScale(1, 1, h / h0)).multiply(Bm.makeTranslation(0, 0, -n.base_z));
          mesh.userData.rgbe = [...(v[k] > 0 ? BAR_RGB[k % 4] : OFF_RGB), k === 2 && o.state === 'done' ? 0.8 : 0.3];
        });
      } else if (n.kind === 'led' && n.colors) {
        const rgba = n.colors[s.state] || n.colors.idle || Object.values(n.colors)[0];
        for (const g of n.geoms) tint(animated.get(g), rgba, ledLevel(n, s, t, g));
      } else if (n.kind === 'loop' && n.colors) {
        n.geoms.forEach((g, k) => tint(animated.get(g), loop[k] ? n.colors.on : n.colors.off, ...LOOP_LEVEL[loop[k] ? 'on' : 'off']));
      }
    }
    for (const G of groups.values()) G.matrixWorldNeedsUpdate = true;
    for (const mesh of animated.values()) mesh.matrixWorldNeedsUpdate = true;
  };
}
