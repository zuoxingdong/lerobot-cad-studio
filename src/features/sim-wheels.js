/* The omni wheels, visual only.  Each drive joint's axle, rim centre and radius are measured from the
   package (FK at the zero pose and the wheel mesh), and a wheel spins by no slip along its drive
   direction (perpendicular to the axle, in the ground plane); its rollers take the sideways slip.
   Robot frame, mm, +Y forward.  The MJCF carries no wheel joint: the renderers spin the meshes. */

import * as THREE from 'three';

/* the links that turn with a joint: its child and everything fixed below it */
function turningLinks(model, j) {
  const out = new Set([j.child]);
  for (let grew = true; grew;) {
    grew = false;
    for (const x of model.ownJoints) if (!x.moving && out.has(x.parent) && !out.has(x.child)) { out.add(x.child); grew = true; }
  }
  return out;
}

/**
 * [{joint, axis_local, pivot_mm, axle, rim_mm, radius_mm}] for the package's drive joints, in the
 * robot frame at the model's current pose (call it at the zero pose).  `axis_local` is the joint
 * axis in the child link frame; `rim_mm` is where the roller circle's plane meets the axle.
 */
export function wheelSpecs(model) {
  const names = (model.manifest.kinematics || {}).drive_joints || [];
  const inv = model.baseMatrix().invert(), out = [];
  for (const name of names) {
    const j = model.joint(name);
    if (!j || !j.moving) continue;
    const J = new THREE.Matrix4().multiplyMatrices(inv, model.fk(j.child));
    const o = new THREE.Vector3().setFromMatrixPosition(J);
    const a = new THREE.Vector3(...(j.axis || [0, 0, 1])).normalize().transformDirection(J);
    const links = turningLinks(model, j), v = new THREE.Vector3(), pts = [];
    let rmax = 0;
    for (const c of model.components) {
      if (!links.has(c.link) || !c.geometry) continue;
      const M = new THREE.Matrix4().multiplyMatrices(inv, model.worldMatrix(c.id)), P = c.geometry.attributes.position;
      for (let i = 0; i < P.count; i++) {
        v.fromBufferAttribute(P, i).applyMatrix4(M).sub(o);
        const t = v.dot(a), r = Math.sqrt(Math.max(0, v.lengthSq() - t * t));
        pts.push(t, r);
        if (r > rmax) rmax = r;
      }
    }
    if (!rmax) continue;
    let ts = 0, nt = 0;
    for (let i = 0; i < pts.length; i += 2) if (pts[i + 1] > rmax - 1) { ts += pts[i]; nt++; }
    const rim = o.clone().addScaledVector(a, ts / nt);
    const r3 = (x) => +x.toFixed(3) + 0, r6 = (x) => +x.toFixed(6) + 0;
    out.push({ joint: name, axis_local: (j.axis || [0, 0, 1]).map(r6), pivot_mm: o.toArray().map(r3), axle: a.toArray().map(r6),
      rim_mm: rim.toArray().map(r3), radius_mm: r3(rmax) });
  }
  return out;
}

/** Wheel rates, rad/s about each joint axis, from the robot-frame base velocity (m/s, rad/s). */
export function wheelRates(specs, vx, vy, wz) {
  return specs.map((w) => {
    const [ax, ay] = w.axle, rx = ax ** 2 + ay ** 2;         // roll = (a x z) / |a x z|^2
    if (rx < 1e-9) return 0;
    const ux = vx - wz * w.rim_mm[1] / 1000, uy = vy + wz * w.rim_mm[0] / 1000;
    return ((ux * ay - uy * ax) / rx) / (w.radius_mm / 1000);
  });
}

/**
 * Wheel angles integrated from the base's world velocity.  step(dt, [vx, vy, wz] world, yaw rad)
 * -> {joint: deg}.  Deterministic: the same steps give the same angles.
 */
export function createWheelSpin(specs, start = {}) {
  const ang = specs.map((w) => start[w.joint] || 0);
  return {
    specs,
    angles: () => Object.fromEntries(specs.map((w, i) => [w.joint, ang[i]])),
    step(dt, [bx, by, bw], yaw) {
      if (dt > 0) {
        const c = Math.cos(yaw), s = Math.sin(yaw);
        const rates = wheelRates(specs, c * bx + s * by, -s * bx + c * by, bw);
        for (let i = 0; i < ang.length; i++) ang[i] = (ang[i] + rates[i] * dt * 180 / Math.PI) % 360;
      }
      return this.angles();
    },
  };
}
