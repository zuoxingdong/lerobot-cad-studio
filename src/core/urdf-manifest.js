/* urdf-loader output -> an rps/robot@1 manifest plus its geometry map.
   Needs three (Euler/Matrix4 only) and core/manifest.js. */

import * as THREE from 'three';
import { ROBOT_SCHEMA, RAD, MOVING, isFiniteNum } from './manifest.js';

/**
 * Turn urdf-loader output into an `rps/robot@1` manifest plus an in-memory geometry map
 * (mesh key → THREE.BufferGeometry).  One component per <visual>.
 *
 * Frames: world_mm = 1000 · world_m, so
 *   fk_mm(link) = S·FK_m·S⁻¹     (what `Joint.matrix` builds, xyz×1000)
 *   local_mm    = S·VisualOrigin_m·S⁻¹ · (S · MeshRelative_m)
 * With the usual `<mesh scale="0.001">` on a millimetre mesh, `S · MeshRelative` is the
 * identity and `local` is exactly the URDF visual origin in mm — the same number
 * `assets.js` v2 stores, which is why the two agree to 1e-14 mm.
 */
export function manifestFromURDF(urdfRobot, options = {}) {
  const geometries = new Map();
  const joints = [];
  const limits = {};
  const jointMap = urdfRobot.joints || {};
  for (const name of Object.keys(jointMap)) {
    const j = jointMap[name];
    const child = (j.children || []).find((c) => c.isURDFLink);
    const rpy = new THREE.Euler().setFromQuaternion(j.quaternion, 'ZYX');
    const type = j.jointType || j.type || 'fixed';
    const rec = {
      name,
      type,
      parent: j.parent ? j.parent.name : null,
      child: child ? child.name : null,
      xyz: [j.position.x, j.position.y, j.position.z],
      rpy: [rpy.x, rpy.y, rpy.z],
      axis: j.axis ? [j.axis.x, j.axis.y, j.axis.z] : [0, 0, 1]
    };
    if (j.mimicJoint) {
      /* `multiplier` is dimensionless and survives; `offset` is in the CHILD joint's URDF unit
         — radians, or metres for a prismatic — and every other number in this manifest is
         degrees / millimetres.  Passing it through raw made `<mimic offset="1.5708"/>` move
         the child 1.57° instead of 90°, and a prismatic offset 1000× too small. */
      rec.mimic = {
        joint: j.mimicJoint,
        multiplier: isFiniteNum(j.multiplier) ? j.multiplier : 1,
        offset: isFiniteNum(j.offset) ? j.offset * (type === 'prismatic' ? 1000 : RAD) : 0,
      };
    }
    const L = j.limit;
    if (L && MOVING.has(type) && type !== 'continuous' && isFiniteNum(L.lower) && isFiniteNum(L.upper) && (L.lower !== 0 || L.upper !== 0)) {
      limits[name] = type === 'prismatic'
        ? { lower: L.lower * 1000, upper: L.upper * 1000 }
        : { lower: L.lower * RAD, upper: L.upper * RAD };
      rec.limits = limits[name];
    }
    joints.push(rec);
  }

  /* the root link: the one no joint has as a child */
  const childSet = new Set(joints.map((j) => j.child));
  const linkNames = Object.keys(urdfRobot.links || {});
  const rootLink = options.root_link || linkNames.find((n) => !childSet.has(n)) || linkNames[0] || null;

  const S1000 = new THREE.Matrix4().makeScale(1000, 1000, 1000);
  const components = [];
  const seenGeom = new Map();      // BufferGeometry -> mesh key (instancing)
  let n = 0;

  urdfRobot.updateMatrixWorld(true);
  for (const linkName of linkNames) {
    const link = urdfRobot.links[linkName];
    const visuals = (link.children || []).filter((c) => c.isURDFVisual);
    visuals.forEach((visual, vi) => {
      /* S · VisualOrigin_m · S⁻¹ = the same rotation with the translation ×1000 */
      const vo = new THREE.Matrix4().compose(visual.position, visual.quaternion, visual.scale);
      vo.elements[12] *= 1000; vo.elements[13] *= 1000; vo.elements[14] *= 1000;
      const invVisual = new THREE.Matrix4().copy(visual.matrixWorld).invert();

      const meshes = [];
      visual.traverse((o) => { if (o.isMesh && o.geometry) meshes.push(o); });
      if (!meshes.length) return;

      meshes.forEach((mesh, mi) => {
        const rel = new THREE.Matrix4().multiplyMatrices(invVisual, mesh.matrixWorld);
        const local = new THREE.Matrix4().multiplyMatrices(vo, new THREE.Matrix4().multiplyMatrices(S1000, rel));

        let key = seenGeom.get(mesh.geometry);
        if (!key) {
          key = mesh.geometry.userData && mesh.geometry.userData.meshKey
            ? mesh.geometry.userData.meshKey
            : 'mesh/' + (n += 1);
          seenGeom.set(mesh.geometry, key);
          geometries.set(key, mesh.geometry);
        }
        const suffix = (visuals.length > 1 ? '#' + vi : '') + (meshes.length > 1 ? '.' + mi : '');
        const colorHex = mesh.material && mesh.material.color ? '#' + mesh.material.color.getHexString() : undefined;
        components.push({
          id: linkName + suffix,
          label: visual.name || linkName,
          link: linkName,
          group: options.group ? options.group(linkName) : 'imported',
          frame: 'link',                       // corrected to 'mesh' below for instanced geometry
          local: local.toArray(),
          mesh: key,
          color: options.color || colorHex || '#9aa3ad',
          /* A URDF visual mesh is the only mesh a URDF has, and the studio exists to print
             it: defaulting to `printable:false` gave every URDF import "0 printables" and
             no way to export anything.  The assumption is stated in the note. */
          printable: options.printable !== undefined ? !!options.printable : true,
          note: options.printable === undefined
            ? 'assumed printable — imported URDF visual mesh, not a declared print file' : null,
          source: 'urdf:' + linkName
        });
      });
    });
  }
  /* an instanced key (used by more than one component) is a "mesh"-frame component */
  const usage = new Map();
  for (const c of components) usage.set(c.mesh, (usage.get(c.mesh) || 0) + 1);
  for (const c of components) c.frame = usage.get(c.mesh) > 1 ? 'mesh' : 'link';

  const manifest = {
    schema: ROBOT_SCHEMA,
    id: options.id || slug(urdfRobot.robotName || 'imported-robot'),
    name: options.name || urdfRobot.robotName || 'Imported robot',
    version: options.version || null,
    source: options.source || { kind: 'urdf', name: urdfRobot.robotName || null },
    units: 'mm',
    up: 'z',
    frame: options.frame || { notes: 'generated from URDF; +Z up, mm' },
    kinematics: {
      urdf: options.urdf || null,
      root_link: rootLink,
      units: 'm',
      joints,
      joint_limits_deg: Object.keys(limits).length ? limits : undefined,
      joint_limits_source: Object.keys(limits).length ? 'URDF <limit> tags' : 'none in the URDF',
      joint_order: joints.filter((j) => MOVING.has(j.type)).map((j) => j.name)
    },
    components,
    frames: options.frames || {},
    cameras: options.cameras || []
  };
  return { manifest, geometries };
}

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'robot'; }
