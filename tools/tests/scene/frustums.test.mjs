/* scene/frustums.js.  Footprints are checked against an independent intersection: three's own
   camera unprojected and crossed with a THREE.Plane. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  groundFootprint, frustumCorners, imageRay, projectPoint, hFovToV, vFovToH
} from '../../../src/scene/frustums.js';

const D2R = Math.PI / 180;

/** A camera in the ROBOT frame: at `origin`, yawed, and tilted nose-DOWN by tilt_deg. */
function makeSpec({ origin = [0, 0, 500], tilt = 90, yaw = 0, hfov = 90, aspect = 1, near = 1, far = 5000 } = {}) {
  /* a THREE.Camera, not a bare Object3D: Object3D.lookAt() points +Z at the target,
     cameras point -Z at it, and -Z is the convention every camera matrix here uses. */
  const o = new THREE.Camera();
  const t = tilt * D2R, y = yaw * D2R;
  const dir = new THREE.Vector3(Math.sin(y) * Math.cos(t), Math.cos(y) * Math.cos(t), -Math.sin(t));
  /* robot Z is up, except looking straight down/up where that is degenerate */
  o.up.set(0, 0, 1);
  if (Math.abs(dir.z) > 0.9999) o.up.set(0, 1, 0);
  o.position.fromArray(origin);
  o.lookAt(o.position.clone().add(dir));
  o.updateMatrix();
  return { matrix: o.matrix.clone(), hfov_deg: hfov, aspect, near, far, _dir: dir };
}

/** The same four corner intersections, computed through three's projection pipeline. */
function analyticCorners(spec, groundZ) {
  const s = { hfov: spec.hfov_deg, aspect: spec.aspect, near: spec.near, far: spec.far };
  const cam = new THREE.PerspectiveCamera(hFovToV(s.hfov, s.aspect), s.aspect, s.near, s.far);
  cam.matrixAutoUpdate = false;
  cam.matrix.copy(spec.matrix);
  cam.matrix.decompose(cam.position, cam.quaternion, cam.scale);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -groundZ);
  const eye = new THREE.Vector3().setFromMatrixPosition(spec.matrix);
  /* image order BL BR TR TL == NDC (-1,-1) (1,-1) (1,1) (-1,1) */
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => {
    const far = new THREE.Vector3(x, y, 1).unproject(cam);
    const ray = new THREE.Ray(eye, far.sub(eye).normalize());
    const hit = new THREE.Vector3();
    return ray.intersectPlane(plane, hit) ? hit.clone() : null;
  });
}

function closeTo(a, b, eps = 1e-6, what = '') {
  assert.ok(Math.abs(a - b) <= eps, what + ' expected ' + b + ' got ' + a);
}

test('fov round-trip; straight down a 90° square camera sees a 2h square; 4:3 keeps its aspect; groundZ is honoured', () => {
  for (const [h, a] of [[90, 4 / 3], [62, 16 / 9], [120, 1], [35, 1.5]]) closeTo(vFovToH(hFovToV(h, a), a), h, 1e-9, 'hfov ' + h);
  const h = 500, gz = -32.9;
  const fp = groundFootprint(makeSpec({ origin: [0, 0, h], tilt: 90, hfov: 90, aspect: 1 }), 0);
  assert.equal(fp.corner_count, 4);
  for (const c of fp.corners) { closeTo(Math.abs(c.x), h, 1e-6); closeTo(Math.abs(c.y), h, 1e-6); }
  closeTo(fp.near_mm, h, 1e-6);
  closeTo(fp.far_mm, h * Math.SQRT2, 1e-6);
  const q = groundFootprint(makeSpec({ origin: [0, 0, 400], tilt: 90, hfov: 90, aspect: 4 / 3 }), 0).corners;
  closeTo(Math.abs(q[1].x - q[0].x) / Math.abs(q[3].y - q[0].y), 4 / 3, 1e-6);
  for (const c of groundFootprint(makeSpec({ origin: [0, 0, h], tilt: 90, hfov: 90, aspect: 1 }), gz).corners) {
    closeTo(c.z, gz, 1e-9);
    closeTo(Math.abs(c.x), h - gz, 1e-6);
  }
});

test('corners match three\'s own unproject+plane intersection', () => {
  const cases = [
    { origin: [0, 0, 500], tilt: 90, hfov: 90, aspect: 1 },
    { origin: [0, 93.5, 210], tilt: 10, hfov: 90, aspect: 4 / 3 },
    { origin: [0, 25, 387.1], tilt: 65, hfov: 62, aspect: 4 / 3 },
    { origin: [-40, 120, 300], tilt: 32, yaw: 25, hfov: 78, aspect: 16 / 9 },
    { origin: [60, -30, 450], tilt: 55, yaw: -140, hfov: 100, aspect: 1.2 }
  ];
  for (const c of cases) {
    const spec = makeSpec(c);
    const mine = groundFootprint(spec, -32.9).corners;
    const theirs = analyticCorners(spec, -32.9);
    for (let i = 0; i < 4; i++) {
      assert.equal(!!mine[i], !!theirs[i], JSON.stringify(c) + ' corner ' + i + ' presence');
      if (!mine[i]) continue;
      closeTo(mine[i].x, theirs[i].x, 5e-6, JSON.stringify(c) + ' corner ' + i + '.x');
      closeTo(mine[i].y, theirs[i].y, 5e-6, JSON.stringify(c) + ' corner ' + i + '.y');
      closeTo(mine[i].z, -32.9, 1e-9, 'corner ' + i + '.z');
    }
  }
});

test('the centre ray lands at h / tan(tilt); image v is down; the horizon drops far corners; steps set the ring', () => {
  const h = 300, tilt = 30;
  const { origin, dir } = imageRay(makeSpec({ origin: [0, 0, h], tilt, hfov: 60, aspect: 4 / 3 }), 0, 0);
  const p = origin.clone().addScaledVector(dir, -origin.z / dir.z);
  closeTo(p.y, h / Math.tan(tilt * D2R), 1e-6);
  closeTo(p.x, 0, 1e-9);
  const fp = groundFootprint(makeSpec({ origin: [0, 0, 300], tilt: 40, hfov: 70, aspect: 4 / 3 }), 0);
  assert.ok(fp.corners[0].y < fp.corners[3].y, 'the bottom of the image is the near ground');
  const up = groundFootprint(makeSpec({ origin: [0, 0, 200], tilt: -35, hfov: 60, aspect: 4 / 3 }), 0, { maxRange: 3000 });
  assert.ok(up.corner_count === 0 && up.horizon && up.polygon.length === 24);
  for (const q of up.polygon) assert.ok(q.z === 0 && Math.hypot(q.x, q.y) <= 3250, 'not clamped');
  const hz = groundFootprint(makeSpec({ origin: [0, 0, 250], tilt: 8, hfov: 90, aspect: 4 / 3 }), 0);
  assert.ok(hz.corner_count === 2 && hz.corners[0] && hz.corners[1] && !hz.corners[2] && !hz.corners[3] && hz.horizon);
  const spec = makeSpec({ origin: [0, 0, 500], tilt: 90 });
  assert.deepEqual([undefined, 2, 12].map((n) => groundFootprint(spec, 0, n ? { steps: n } : {}).polygon.length), [24, 8, 48]);
});

test('frustumCorners gives 8 points, near quad then far quad', () => {
  const spec = makeSpec({ origin: [0, 0, 0], tilt: 0, hfov: 90, aspect: 1, near: 10, far: 100 });
  const c = frustumCorners(spec);
  assert.equal(c.length, 8);
  const eye = new THREE.Vector3(0, 0, 0);
  for (let i = 0; i < 4; i++) {
    closeTo(c[i].distanceTo(eye), 10 * Math.sqrt(3), 1e-6, 'near corner ' + i);       // sqrt(1+1+1)*d
    closeTo(c[4 + i].distanceTo(eye), 100 * Math.sqrt(3), 1e-6, 'far corner ' + i);
  }
});

test('projectPoint agrees with THREE.PerspectiveCamera to 1e-9 NDC', () => {
  const spec = makeSpec({ origin: [0, 93.5, 210], tilt: 10, hfov: 90, aspect: 4 / 3, near: 12, far: 3000 });
  const cam = new THREE.PerspectiveCamera(hFovToV(90, 4 / 3), 4 / 3, 12, 3000);
  cam.matrixAutoUpdate = false;
  cam.matrix.copy(spec.matrix);
  cam.matrix.decompose(cam.position, cam.quaternion, cam.scale);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  for (const p of [[0, 300, 0], [120, 500, -32.9], [-200, 900, 150], [0, 150, 260]]) {
    const v = new THREE.Vector3(...p);
    const mine = projectPoint(spec, v);
    const ref = v.clone().project(cam);
    closeTo(mine.ndc[0], ref.x, 1e-9, 'ndc x at ' + p);
    closeTo(mine.ndc[1], ref.y, 1e-9, 'ndc y at ' + p);
    closeTo(mine.v, -ref.y, 1e-9, 'v is the negated NDC y');
  }
});

test('projectPoint flags a point behind the lens or inside the near plane', () => {
  const spec = makeSpec({ origin: [0, 0, 300], tilt: 90, hfov: 90, aspect: 1, near: 50 });
  const behind = projectPoint(spec, new THREE.Vector3(0, 0, 900));
  assert.ok(behind.behind && !behind.in);
  assert.equal(projectPoint(spec, new THREE.Vector3(0, 0, 280)).in, false);
  assert.equal(projectPoint(spec, new THREE.Vector3(0, 0, 100)).in, true);
});

test('near_mm / far_mm are distances from the base centre (0, 0), not from the lens', () => {
  const fp = groundFootprint(makeSpec({ origin: [0, 400, 300], tilt: 45, hfov: 60, aspect: 4 / 3 }), 0);
  let lo = Infinity, hi = 0;
  for (const p of fp.polygon) { const d = Math.hypot(p.x, p.y); lo = Math.min(lo, d); hi = Math.max(hi, d); }
  closeTo(fp.near_mm, lo, 1e-9);
  closeTo(fp.far_mm, hi, 1e-9);
  closeTo(Math.hypot(fp.near_point.x, fp.near_point.y), fp.near_mm, 1e-9);
});

/* the live layer: scene-graph work, no GPU */
import { createFrustums, CLASS_COLORS } from '../../../src/scene/frustums.js';

function fakeViewport() {
  const root = new THREE.Group();
  const overlayRoot = new THREE.Group();
  const robotRoot = new THREE.Group();
  root.add(overlayRoot, robotRoot);
  return {
    renderer: { getRenderTarget: () => null }, scene: new THREE.Scene(),
    root, overlayRoot, robotRoot, groundZ: 0, width: 800, height: 600,
    tokens: { '--frustum': '#5b8fd6' }, pipHidden: new Set(),
    draws: 0, invalidate() { this.draws++; }
  };
}
const specAt = (tilt) => ({ ...makeSpec({ origin: [0, 0, 500], tilt }), hfov_deg: 90, aspect: 4 / 3, near: 10, far: 3000 });

test('update() rewrites the frustum in place — no dispose, no new buffers', () => {
  const vp = fakeViewport();
  const F = createFrustums(vp, { fill: true });
  const e0 = F.set('wrist', { ...specAt(90), color: '#ff0000', visible: true });
  const geo = e0.wire.geometry;
  const attr = geo.getAttribute('position');
  const before = Array.from(attr.array.slice(0, 12));

  const e1 = F.update('wrist', { ...specAt(45), color: '#ff0000', visible: true });
  assert.equal(e1.wire.geometry, geo, 'the geometry object was replaced');
  assert.equal(e1.wire.geometry.getAttribute('position'), attr, 'the position attribute was replaced');
  const after = Array.from(attr.array.slice(0, 12));
  assert.ok(after.some((v, i) => Math.abs(v - before[i]) > 1e-6), 'the pyramid did not move');
  assert.equal(attr.array.length, geo.getAttribute('position').array.length);
  F.dispose();
});

test('a hidden frustum defers its geometry but its camera keeps tracking', () => {
  const vp = fakeViewport();
  const F = createFrustums(vp, { fill: false });
  F.set('top', { ...specAt(90), visible: false });
  const geo = F.get('top').wire.geometry;
  const before = Array.from(geo.getAttribute('position').array.slice(0, 12));
  const camBefore = F.camera('top').matrix.elements.slice();

  F.update('top', { ...specAt(30), visible: false });
  const during = Array.from(geo.getAttribute('position').array.slice(0, 12));
  assert.deepEqual(during, before, 'a hidden frustum still rebuilt its pyramid');
  const camAfter = F.camera('top').matrix.elements.slice();
  assert.ok(camAfter.some((v, i) => Math.abs(v - camBefore[i]) > 1e-9),
    'the synthetic camera stopped tracking — the PiPs would freeze');

  F.setVisible('top', true);
  const shown = Array.from(geo.getAttribute('position').array.slice(0, 12));
  assert.ok(shown.some((v, i) => Math.abs(v - before[i]) > 1e-6), 'showing it did not flush the deferred pose');
  F.dispose();
});

test('remove() takes the synthetic camera with it', () => {
  const vp = fakeViewport();
  const F = createFrustums(vp, {});
  F.set('front', specAt(20));
  F.camera('front');
  assert.equal(vp.robotRoot.children.filter((o) => o.isCamera).length, 1);
  F.remove('front');
  assert.equal(vp.robotRoot.children.filter((o) => o.isCamera).length, 0, 'the camera was left in robotRoot');
  F.dispose();
});

test('a re-set frustum keeps its own palette slot (a theme change kept only one colour)', () => {
  const vp = fakeViewport();
  const F = createFrustums(vp, {});
  F.set('a', specAt(90));
  F.set('b', specAt(60));
  F.set('c', specAt(30));
  const before = ['a', 'b', 'c'].map((id) => F.get(id).color);
  assert.equal(new Set(before).size, 3, 'the palette handed out a duplicate: ' + before);
  F.setTheme();
  const after = ['a', 'b', 'c'].map((id) => F.get(id).color);
  assert.equal(new Set(after).size, 3, 'after a theme change every frustum is ' + after);
  assert.deepEqual(after.slice(1), before.slice(1), 'only the token-coloured first entry may move');
  F.dispose();
});

test('CLASS_COLORS names `upgrade` with a colour of its own', () => {
  assert.deepEqual(CLASS_COLORS.upgrade, [30, 215, 210]);
  const seen = new Map();
  for (const [k, v] of Object.entries(CLASS_COLORS)) {
    const key = v.join(',');
    assert.ok(!seen.has(key), `${k} shares ${key} with ${seen.get(key)} — one of them can never be reported`);
    seen.set(key, k);
  }
});
