/* The tubes' liquid in the Sim tab: per tube a column and a concave meniscus on the puck's room
   body, sheared each sync so their top lies on the surface plane of features/sim-liquid.js (the
   sides stay on the bore).  The hit tube fluoresces while the reader excites it.  Needs the room (ui/sim-room.js); removed with it. */

import * as THREE from 'three';
import { createLiquid, glowLevel } from '../features/sim-liquid.js';

const NONE = { sync() {}, surfaces: () => [] };

/* a shallow bowl: the wetted rim `rise` mm over the centre, a skirt `drop` mm down the bore */
function meniscusGeometry(r, rise, drop) {
  const pts = [new THREE.Vector2(0, 0)];
  for (let i = 1; i <= 8; i++) { const u = i / 8; pts.push(new THREE.Vector2(r * u, rise * u ** 4)); }
  pts.push(new THREE.Vector2(r, -drop));
  return new THREE.LatheGeometry(pts, 32).rotateX(Math.PI / 2);
}

export function createLiquidView(room, session, sidecar) {
  const P = sidecar.lab && sidecar.lab.props && sidecar.lab.props[0];
  const body = room && P && P.liquid ? room.bodies.get(P.body) : null;
  if (!body) return NONE;
  const Q = P.liquid, liq = createLiquid(Q), m = session.sim.model, mj = session.mj;
  const b = mj.mj_name2id(m, mj.mjtObj.mjOBJ_BODY.value, P.body);
  if (b < 0) return NONE;

  const h = Q.z_rest_mm - Q.z_low_mm;
  const colGeo = new THREE.CylinderGeometry(Q.r_mm, Q.r_mm, h, 32).rotateX(Math.PI / 2).translate(0, 0, -h / 2);
  const menGeo = meniscusGeometry(Q.r_mm, 0.45, 0.3);
  const glow = new THREE.Color().setRGB(...Q.glow, THREE.SRGBColorSpace);
  const tubes = Q.wells.map(([x, y], k) => {
    const c = new THREE.Color().setRGB(...Q.tints[k], THREE.SRGBColorSpace);
    const col = new THREE.MeshStandardMaterial({ color: c, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.8, emissive: glow });
    const men = new THREE.MeshStandardMaterial({ color: c.clone().lerp(new THREE.Color(1, 1, 1), 0.5), roughness: 0.05, metalness: 0,
      transparent: true, opacity: 0.9, side: THREE.DoubleSide, emissive: glow });
    col.emissiveIntensity = men.emissiveIntensity = 0;
    const meshes = [new THREE.Mesh(colGeo, col), new THREE.Mesh(menGeo, men)];
    for (const o of meshes) {
      o.matrixAutoUpdate = false;
      o.renderOrder = 1;                          // before the tube wall (2), which blends over it
      o.userData.pickable = false;
      o.userData.camClass = null;
      body.add(o);
    }
    return { k, x, y, meshes, mats: [col, men] };
  });

  const S = new THREE.Matrix4();
  function sync() {
    const d = session.data, X = d.xpos, R = d.xmat;
    liq.sample(d.time, [X[3 * b], X[3 * b + 1], X[3 * b + 2]], R.subarray(9 * b, 9 * b + 9));
    const surf = liq.surfaces();
    const inst = session.instruments, rd = inst ? inst.snapshot().stations.reader : null, lvl = glowLevel(rd);
    for (const t of tubes) {
      const [sx, sy] = surf[t.k].slope;
      S.set(1, 0, 0, t.x, 0, 1, 0, t.y, sx, sy, 1, Q.z_rest_mm, 0, 0, 0, 1);
      for (const o of t.meshes) { o.matrix.copy(S); o.matrixWorldNeedsUpdate = true; }
      const e = t.k === Q.hit ? 1.4 * lvl : 0;
      for (const mt of t.mats) mt.emissiveIntensity = e;
    }
    return surf;
  }

  function dispose() {
    for (const t of tubes) { for (const o of t.meshes) o.removeFromParent(); for (const mt of t.mats) mt.dispose(); }
    colGeo.dispose();
    menGeo.dispose();
  }
  room.group.addEventListener('removed', dispose);
  return { sync, surfaces: () => liq.surfaces(), liquid: liq };
}
