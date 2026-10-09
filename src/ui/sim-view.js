/* The Sim tab's picture in the Design viewport: MuJoCo qpos -> RobotModel joints and base pose
   (the page's own meshes, FK and cameras), the lab room (ui/sim-room.js, its instruments posed
   from the session's snapshot) or else the scenery from geom poses, the props from body poses,
   the omni wheels spun from the base velocity, the orbit carried along with the base, and the
   walls behind the orbit eye cut away; the baked lab and its look (ui/sim-look.js) replace the
   room's static decor once loaded, and the robot wears its real finish (ui/sim-finish.js).  The
   Design furniture (ground, grid, studio lights) is taken out of the scene meanwhile, and the
   depth range fits the room.  World metres, floor z = 0 -> robot-frame mm. */

import * as THREE from 'three';
import { robotPose } from '../features/sim-engine.js';
import { createWheelSpin, wheelSpecs } from '../features/sim-wheels.js';
import { createLiquidView } from './sim-liquid-view.js';
import { createSimLook } from './sim-look.js';
import { createSimFinish } from './sim-finish.js';
import { sane } from '../features/sim-mjcf.js';

/* the Design parts the dress replaces (tools/render/models.json robot_dress, robot_kit and omniwheel `match`) */
const STAND_IN = /^vis_((corner_mast_printed|df200_arch)_df200|battery.*|lipo_battery_mount.*)$/i, HOUSING_MATS = /^(touchscreen|smoked_glass|polymer_black)$/;

/* what ui/sim-room.js builds with (a list, not the namespace, so three stays tree-shaken) */
const ROOM_THREE = { BoxGeometry: THREE.BoxGeometry, BufferAttribute: THREE.BufferAttribute, BufferGeometry: THREE.BufferGeometry,
  CanvasTexture: THREE.CanvasTexture, Color: THREE.Color, CylinderGeometry: THREE.CylinderGeometry,
  DirectionalLight: THREE.DirectionalLight, Group: THREE.Group, HemisphereLight: THREE.HemisphereLight, Matrix4: THREE.Matrix4, Mesh: THREE.Mesh,
  MeshBasicMaterial: THREE.MeshBasicMaterial, MeshStandardMaterial: THREE.MeshStandardMaterial,
  PlaneGeometry: THREE.PlaneGeometry, Quaternion: THREE.Quaternion, Vector3: THREE.Vector3,
  RepeatWrapping: THREE.RepeatWrapping, SRGBColorSpace: THREE.SRGBColorSpace };
const R2D = 180 / Math.PI;
/* Sim depth range, mm: the near plane follows the orbit distance (depth precision scales with
   it), so decals 1.2 mm above the floor stay separate out to the far end of the room. */
const NEAR_MIN = 10, NEAR_MAX = 100, NEAR_PER_MM = 0.01, FAR = 40000;
/* a robot camera's own module (cover glass, lens hood) and the end of its USB lead, as far as they stay this
   close to its lens, go on a layer of that camera's own that only its feed skips (the film's own_housing) */
const OWN_LAYER0 = 8, OWN_MM = 60;

/* contact shadows for n wheels: a small radial falloff, darkest at the patch, in room mm */
function wheelPads(n) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d'), grd = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grd.addColorStop(0, 'rgba(0,0,0,0.7)'); grd.addColorStop(0.35, 'rgba(0,0,0,0.35)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  const quad = new THREE.PlaneGeometry(1, 1), group = new THREE.Group(), p = new THREE.Vector3();
  group.name = 'sim:wheel-contact';
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(quad, mat);
    m.scale.set(95, 95, 1);
    m.renderOrder = 1;
    m.userData.pickable = false;
    group.add(m);
  }
  return {
    group,
    /** under each wheel's centre (its box centre, robot frame mm), just over the room's contact disc */
    place(wheels) {
      wheels.forEach((w, i) => {
        if (!w.geometry.boundingBox) w.geometry.computeBoundingBox();
        w.geometry.boundingBox.getCenter(p).applyMatrix4(w.matrix);
        group.children[i].position.set(p.x, p.y, 5.2);
      });
    },
    dispose() { group.removeFromParent(); quad.dispose(); mat.dispose(); tex.dispose(); },
  };
}

export function createSimView({ viewport, model, meshes, session, frustums, camIds }) {
  const { mj, sidecar, ix } = session;
  const m = session.sim.model;
  const gz = sidecar.ground_z_mm || 0;
  const group = new THREE.Group();
  group.name = 'sim';
  group.userData.pickable = false;
  viewport.root.add(group);

  /* the room, when the session has the lab scene; it replaces every scenery primitive */
  const S = session.labScene && sidecar.lab ? session.labScene : null;
  const room = S ? S.lib.createRoom(ROOM_THREE, { scene: S, lab: sidecar.lab }) : null;
  const liquid = createLiquidView(room, session, sidecar);          // the tubes' liquid, visual only
  const look = createSimLook({ viewport, room, lab: sidecar.lab, design: session.hash, onReady: () => sync(0) });
  const finish = createSimFinish(meshes);
  viewport.materials.setPalette('real', finish.map);
  /* the Design ground and grid lie on the room floor: detached, not hidden, so no Design
     toggle (the grid button re-shows the grid on any store change) can bring them back */
  const parked = [];
  let backdropPip = null;
  if (room) {
    room.group.position.z = gz;
    viewport.root.add(room.group);
    for (const o of [viewport.ground, viewport.gridGroup, viewport.axes, viewport.horizon, viewport.lights]) if (o && o.parent) { parked.push([o, o.parent]); o.parent.remove(o); }
    if (viewport.backdrop) { backdropPip = viewport.backdrop.userData.pipVisible; viewport.backdrop.userData.pipVisible = false; }
  }
  const cam = viewport.camera, depth0 = [cam.near, cam.far];
  function fitDepth() {
    const n = Math.min(NEAR_MAX, Math.max(NEAR_MIN, NEAR_PER_MM * cam.position.distanceTo(viewport.controls.target)));
    if (Math.abs(n - cam.near) < 0.5 && cam.far === FAR) return;
    cam.near = n; cam.far = FAR;
    cam.updateProjectionMatrix();
  }
  const OBJ_BODY_ID = mj.mjtObj.mjOBJ_BODY.value;
  /* the robot's dress (ui/sim-baked.js) rides MuJoCo's bodies; the DF200 stand-in boxes make way for its modules */
  /* a tight dark contact under each omni wheel, over the room's soft disc under the base */
  const wheelMeshes = [...finish.keys].filter(([, k]) => k === 'wheel').map(([id]) => meshes.get(id)).filter(Boolean);
  const pads = room ? wheelPads(wheelMeshes.length) : null;
  if (pads) room.group.add(pads.group);
  const bodyIds = new Map(), standIns = [...meshes].filter(([id]) => STAND_IN.test('vis_' + sane(id))).map(([, x]) => x);
  function bodyMm(name, out) {
    if (!bodyIds.has(name)) bodyIds.set(name, mj.mj_name2id(m, OBJ_BODY_ID, name));
    const b = bodyIds.get(name), P = session.data.xpos, Q = session.data.xmat;
    if (b < 0) return false;
    out.set(Q[9 * b], Q[9 * b + 1], Q[9 * b + 2], P[3 * b] * 1000, Q[9 * b + 3], Q[9 * b + 4], Q[9 * b + 5], P[3 * b + 1] * 1000,
      Q[9 * b + 6], Q[9 * b + 7], Q[9 * b + 8], P[3 * b + 2] * 1000, 0, 0, 0, 1);
    return true;
  }
  /* the Design wheel nearest each MuJoCo wheel body, found once */
  const wheelBody = new Map(), _wm = new THREE.Matrix4(), _wc = new THREE.Vector3();
  function wheelOf(body) {
    if (!wheelBody.has(body)) {
      if (!bodyMm(body, _wm)) return null;
      const at = new THREE.Vector3().setFromMatrixPosition(_wm);
      let best = null, d = Infinity;
      for (const w of wheelMeshes) {
        if (!w.geometry.boundingBox) w.geometry.computeBoundingBox();
        const r = w.geometry.boundingBox.getCenter(_wc).applyMatrix4(w.matrix).setZ(at.z).distanceTo(at);
        if (r < d) { d = r; best = w; }
      }
      wheelBody.set(body, best);
    }
    return wheelBody.get(body);
  }
  const posed = room ? [...room.bodies].map(([name, obj]) => ({ b: mj.mj_name2id(m, OBJ_BODY_ID, name), obj })).filter((x) => x.b >= 0) : [];

  /* scenery and props: every non-plane geom on an environment body */
  const env = new Set(room ? [] : (sidecar.env_bodies || []).filter((b) => b !== 'decor'));
  const dyn = new Set(ix.props.map((p) => p.body));
  const G = mj.mjtGeom, OBJ_BODY = mj.mjtObj.mjOBJ_BODY.value;
  const geos = [], mats = new Map(), items = [];
  const type = m.geom_type, size = m.geom_size, rgba = m.geom_rgba, gb = m.geom_bodyid;
  for (let g = 0; g < m.ngeom; g++) {
    const b = gb[g];
    if (!env.has(mj.mj_id2name(m, OBJ_BODY, b))) continue;
    const s = [0, 1, 2].map((k) => size[3 * g + k] * 1000), t = type[g];
    let geo = null;
    if (t === G.mjGEOM_BOX.value) geo = new THREE.BoxGeometry(2 * s[0], 2 * s[1], 2 * s[2]);
    else if (t === G.mjGEOM_CYLINDER.value) geo = new THREE.CylinderGeometry(s[0], s[0], 2 * s[1], 28).rotateX(Math.PI / 2);
    else if (t === G.mjGEOM_SPHERE.value) geo = new THREE.SphereGeometry(s[0], 20, 14);
    else if (t === G.mjGEOM_CAPSULE.value) geo = new THREE.CapsuleGeometry(s[0], 2 * s[1], 6, 16).rotateX(Math.PI / 2);
    if (!geo) continue;
    geos.push(geo);
    const c = [0, 1, 2, 3].map((k) => rgba[4 * g + k]);
    const key = c.map((v) => v.toFixed(3)).join(',');
    if (!mats.has(key)) {
      mats.set(key, new THREE.MeshStandardMaterial({ color: new THREE.Color(c[0], c[1], c[2]).convertSRGBToLinear(),
        roughness: 0.7, metalness: 0.05, transparent: c[3] < 1, opacity: c[3], depthWrite: c[3] >= 1 }));
    }
    const mesh = new THREE.Mesh(geo, mats.get(key));
    mesh.matrixAutoUpdate = false;
    mesh.userData.pickable = false;
    mesh.userData.camClass = null;
    mesh.name = 'sim:' + g;
    group.add(mesh);
    items.push({ g, mesh, dyn: dyn.has(b) });
  }

  /* the omni wheels: spun about their axles from the base velocity (features/sim-wheels.js) */
  const wheelSpec = sidecar.wheels || wheelSpecs(model);
  const wheels = createWheelSpin(wheelSpec, Object.fromEntries(wheelSpec.map((w) => [w.joint, model.jointValue(w.joint) || 0])));

  function place(all) {
    const d = session.data, X = d.geom_xpos, R = d.geom_xmat;
    for (const { b, obj } of posed) {
      const P = d.xpos, Q = d.xmat;
      obj.matrix.set(Q[9 * b], Q[9 * b + 1], Q[9 * b + 2], P[3 * b] * 1000, Q[9 * b + 3], Q[9 * b + 4], Q[9 * b + 5], P[3 * b + 1] * 1000,
        Q[9 * b + 6], Q[9 * b + 7], Q[9 * b + 8], P[3 * b + 2] * 1000, 0, 0, 0, 1);
      obj.matrixWorldNeedsUpdate = true;
    }
    for (const it of items) {
      if (!all && !it.dyn) continue;
      const g = it.g;
      it.mesh.matrix.set(
        R[9 * g], R[9 * g + 1], R[9 * g + 2], X[3 * g] * 1000,
        R[9 * g + 3], R[9 * g + 4], R[9 * g + 5], X[3 * g + 1] * 1000,
        R[9 * g + 6], R[9 * g + 7], R[9 * g + 8], X[3 * g + 2] * 1000 + gz,
        0, 0, 0, 1);
      it.mesh.matrixWorldNeedsUpdate = true;
    }
  }

  function spin(dt, yaw) {
    if (!wheelSpec.length || !dt) return {};
    const v = session.data.qvel;
    return wheels.step(dt, ix.base.map((x) => v[x.v]), yaw);
  }

  /* the orbit rides with the base; undone on dispose */
  const qRoot = viewport.qRoot, drift = new THREE.Vector3();
  let last = null;
  function follow(base) {
    if (last && (base.x !== last.x || base.y !== last.y)) {
      const d = new THREE.Vector3(base.x - last.x, base.y - last.y, 0).applyQuaternion(qRoot);
      viewport.camera.position.add(d);
      viewport.controls.target.add(d);
      drift.add(d);
    }
    last = { x: base.x, y: base.y };
  }

  /** qpos -> the page's robot; `dt` = sim seconds since the last sync (wheel spin) */
  function sync(dt = 0) {
    const { base, joints } = robotPose(session.data, ix);
    follow(base);
    fitDepth();
    if (room) {
      room.contact.position.x = base.x;
      room.contact.position.y = base.y;
      if (pads) pads.place(wheelMeshes);
      const inst = session.instruments;                      // lids, LEDs, bars: visual only
      room.applyInstruments(inst ? inst.snapshot() : null);
      look.paint();
      const baked = look.baked;
      if (baked && baked.dress && baked.dress.length) {
        baked.poseDress(bodyMm);
        for (const x of [...standIns, ...(baked.dress.some((d) => d.userData.wheel) ? wheelMeshes : [])]) {
          if (x.userData.simShown === undefined) x.userData.simShown = x.visible;
          x.visible = false;
        }
      }
    }
    model.setBasePose(base);
    model.setJoints({ ...joints, ...spin(dt, base.yaw / R2D) });
    for (const [id, mesh] of meshes) {
      const M = model.worldMatrix(id);
      if (!M) continue;
      mesh.matrix.copy(M);
      mesh.matrixWorldNeedsUpdate = true;
    }
    if (room && look.baked && look.baked.poseWheels) look.baked.poseWheels(bodyMm, wheelOf);
    place(false);
    liquid.sync();
    viewport.invalidate();
  }
  place(true);

  /* each robot camera's own parts on its layer (OWN_MM); once, with the cameras and the dress posed */
  const owned = {}, masks = new Map(), box = new THREE.Box3();
  function claimOwn() {
    const baked = look.baked;
    if (masks.size || !frustums || !baked || !baked.dress || !baked.dress.some((d) => d.visible)) return;
    const cams = camIds().map((id, i) => {
      const c = frustums.camera(id);
      c.updateMatrixWorld(true);
      return { id, c, layer: OWN_LAYER0 + i, p: new THREE.Vector3().setFromMatrixPosition(c.matrixWorld) };
    }).filter((k) => k.layer < 32);
    const put = (k, o) => { o.layers.set(k.layer); (owned[k.id] = owned[k.id] || []).push(o); };
    for (const d of baked.dress) {
      if (!HOUSING_MATS.test(d.material.name)) continue;
      if (!d.geometry.boundingBox) d.geometry.computeBoundingBox();
      d.updateMatrixWorld(true);
      box.copy(d.geometry.boundingBox).applyMatrix4(d.matrixWorld);
      let k = null, best = OWN_MM;
      for (const x of cams) { const r = box.distanceToPoint(x.p); if (r < best) { best = r; k = x; } }
      if (k) put(k, d);
    }
    const cm = baked.cables.mesh;
    cm.updateWorldMatrix(true, false);
    for (const k of cams) { const t = baked.cables.tail(cm.worldToLocal(k.p.clone()), OWN_MM); if (t) put(k, t); }
    masks.set(cam, cam.layers.mask);
    for (const k of cams) { cam.layers.enable(k.layer); masks.set(k.c, k.c.layers.mask); }
    for (const k of cams) for (const j of cams) if (j !== k) k.c.layers.enable(j.layer);
  }

  /* the walls between the orbit eye and the room; `false` shows them all (robot cameras) */
  const eye = new THREE.Vector3();
  function cut(on = true) {
    if (!room) return;
    if (!on) { room.cutaway(null); return; }
    room.group.updateWorldMatrix(true, false);
    room.cutaway(room.group.worldToLocal(eye.copy(viewport.camera.position)));
  }

  return {
    group, sync, place, room, cut, liquid, look, finish, standIns, claimOwn, owned,
    wheelAngles: () => wheels.angles(),
    /** the triangles of the Design meshes the dress hides now (its stand-ins, the wheels) */
    replacedTris: () => [...standIns, ...wheelMeshes].filter((x) => x.userData.simShown !== undefined)
      .reduce((n, x) => n + (x.geometry.index ? x.geometry.index.count : x.geometry.attributes.position.count) / 3, 0),
    dispose() {
      viewport.camera.position.sub(drift);
      viewport.controls.target.sub(drift);
      viewport.root.remove(group);
      for (const [c, m] of masks) c.layers.mask = m;
      look.dispose();
      for (const x of [...standIns, ...wheelMeshes]) if (x.userData.simShown !== undefined) { x.visible = x.userData.simShown; delete x.userData.simShown; }
      viewport.materials.setPalette('design');
      finish.dispose();
      if (pads) pads.dispose();
      if (room) room.dispose();
      for (const [o, parent] of parked) parent.add(o);
      if (backdropPip != null) viewport.backdrop.userData.pipVisible = backdropPip;
      [cam.near, cam.far] = depth0;
      cam.updateProjectionMatrix();
      for (const g of geos) g.dispose();
      for (const x of mats.values()) x.dispose();
      viewport.invalidate();
    },
  };
}
