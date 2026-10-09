/* Camera frustum maths: the FOV conversions, the class palette both ID passes share, and
   the pure spec -> ray / corners / ground footprint / image point conversions.
   Needs three (Vector3/Matrix4).  features/cameras.js reads the conversions, the palette and
   the fallbacks from here, never the other way: scene/ does not import upward. */

import * as THREE from 'three';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function hFovToV(hfov_deg, aspect) {
  return 2 * R2D * Math.atan(Math.tan(hfov_deg * D2R / 2) / (aspect || 4 / 3));
}
export function vFovToH(vfov_deg, aspect) {
  return 2 * R2D * Math.atan(Math.tan(vfov_deg * D2R / 2) * (aspect || 4 / 3));
}

/** Flat ID-pass colours, the one copy.  Widely separated so a pixel is classified by
    NEAREST palette entry — immune to the renderer's colour space and tone mapping, and
    two classes sharing a colour would make the later one unreportable. */
export const CLASS_COLORS = {
  background: [0, 0, 0],
  robot: [235, 60, 55],
  arm: [55, 205, 95],
  gripper: [70, 125, 245],
  mast: [245, 190, 45],
  upgrade: [30, 215, 210],
  floor: [125, 125, 125],
  deck: [200, 105, 200],
  target: [255, 255, 255]
};
/* never repeats a CLASS_COLORS entry — a spare that collided with a named class would make
   that class unreportable in exactly the same way */
const SPARE_COLORS = [
  [245, 130, 30], [175, 60, 235], [140, 190, 40],
  [235, 90, 150], [95, 95, 215], [215, 215, 90], [35, 140, 120],
  [190, 130, 95], [110, 210, 245], [160, 40, 90], [60, 90, 40]
];

/** What a spec that omits a field falls back to.  features/cameras.js publishes the same
    numbers as CAMERA_DEFAULTS, so the JS side has ONE answer to "the package said nothing". */
export const CAMERA_FALLBACK = { aspect: 4 / 3, near: 10, far: 9000, hfov_deg: 60 };

function specOf(spec) {
  const hfov = spec.hfov_deg ?? spec.hfov ?? CAMERA_FALLBACK.hfov_deg;
  const aspect = spec.aspect || CAMERA_FALLBACK.aspect;
  return {
    matrix: spec.matrix || spec.matrixRobot || new THREE.Matrix4(),
    hfov, aspect,
    vfov: spec.vfov_deg ?? hFovToV(hfov, aspect),
    near: spec.near ?? CAMERA_FALLBACK.near,
    far: spec.far ?? CAMERA_FALLBACK.far
  };
}

/**
 * The ray through image point (u, v), u right / v DOWN, both -1…+1 over the frame.
 * Returns { origin, dir } in the same frame as `matrix`. `dir` is unit length.
 */
export function imageRay(spec, u, v, out = {}) {
  const s = specOf(spec);
  const tx = Math.tan(s.hfov * D2R / 2);
  const ty = Math.tan(s.vfov * D2R / 2);
  const m = s.matrix.elements;
  const origin = out.origin || new THREE.Vector3();
  origin.set(m[12], m[13], m[14]);
  /* camera space: +X right, +Y up (= -v), -Z forward */
  const cx = u * tx, cy = -v * ty, cz = -1;
  const dir = out.dir || new THREE.Vector3();
  dir.set(
    m[0] * cx + m[4] * cy + m[8] * cz,
    m[1] * cx + m[5] * cy + m[9] * cz,
    m[2] * cx + m[6] * cy + m[10] * cz
  ).normalize();
  return { origin, dir };
}

/** The 8 frustum corners, near quad then far quad, each BL BR TR TL. */
export function frustumCorners(spec) {
  const s = specOf(spec);
  const tx = Math.tan(s.hfov * D2R / 2);
  const ty = Math.tan(s.vfov * D2R / 2);
  const out = [];
  for (const d of [s.near, s.far]) {
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      out.push(new THREE.Vector3(sx * tx * d, sy * ty * d, -d).applyMatrix4(s.matrix));
    }
  }
  return out;
}

/**
 * Where the frustum lands on the plane z = groundZ.
 *
 * corners      [BL, BR, TR, TL] (image order) or null where that ray misses the plane
 * corner_count 0…4
 * polygon      always a closed, drawable ring (4 * steps points) — above-horizon rays are
 *              clamped to maxRange IN THE POLYGON ONLY so the faint floor quad still draws
 * horizon      true if any border ray was above the horizon / past maxRange
 * near_mm/far_mm, near_point/far_point   distance of the ring from the base centre (0,0)
 */
export function groundFootprint(spec, groundZ = 0, { steps = 6, maxRange = 3000 } = {}) {
  const s = specOf(spec);
  const o = new THREE.Vector3().setFromMatrixPosition(s.matrix);
  const scratch = { origin: new THREE.Vector3(), dir: new THREE.Vector3() };

  function hit(u, v) {
    const { origin, dir } = imageRay(s, u, v, scratch);
    if (dir.z >= -1e-9) return null;                      // parallel to or above the plane
    const t = (groundZ - origin.z) / dir.z;
    if (!(t > 0) || !Number.isFinite(t)) return null;
    if (t > maxRange * 8) return null;                    // grazing, effectively the horizon
    return new THREE.Vector3(origin.x + dir.x * t, origin.y + dir.y * t, groundZ);
  }
  function clamped(u, v) {
    const p = hit(u, v);
    if (p) return { p, over: false };
    const { origin, dir } = imageRay(s, u, v, scratch);
    const h = new THREE.Vector2(dir.x, dir.y);
    if (h.lengthSq() < 1e-12) h.set(0, 1);
    h.normalize().multiplyScalar(maxRange);
    return { p: new THREE.Vector3(origin.x + h.x, origin.y + h.y, groundZ), over: true };
  }

  /* the four image corners, in image order BL BR TR TL (v is DOWN-positive) */
  const corners = [hit(-1, 1), hit(1, 1), hit(1, -1), hit(-1, -1)];
  const corner_count = corners.filter(Boolean).length;

  /* walk the image border for the drawable ring */
  const polygon = [];
  let horizon = false;
  const edges = [
    [-1, 1, 1, 1],     // bottom edge, left -> right
    [1, 1, 1, -1],     // right edge, bottom -> top
    [1, -1, -1, -1],   // top edge, right -> left
    [-1, -1, -1, 1]    // left edge, top -> bottom
  ];
  for (const [u0, v0, u1, v1] of edges) {
    for (let i = 0; i < steps; i++) {
      const k = i / steps;
      const r = clamped(u0 + (u1 - u0) * k, v0 + (v1 - v0) * k);
      if (r.over) horizon = true;
      polygon.push(r.p);
    }
  }

  let near_mm = Infinity, far_mm = 0, near_point = null, far_point = null;
  for (const p of polygon) {
    const d = Math.hypot(p.x, p.y);
    if (d < near_mm) { near_mm = d; near_point = p; }
    if (d > far_mm) { far_mm = d; far_point = p; }
  }
  return {
    corners, corner_count, polygon, horizon,
    near_mm: Number.isFinite(near_mm) ? near_mm : null, far_mm,
    near_point, far_point, groundZ, origin: o
  };
}

/** Project a robot-frame point through the camera. { in, u, v, ndc, dist, behind }. */
export function projectPoint(spec, point) {
  const s = specOf(spec);
  const inv = new THREE.Matrix4().copy(s.matrix).invert();
  const p = (point.isVector3 ? point.clone() : new THREE.Vector3().fromArray(point)).applyMatrix4(inv);
  const dist = p.length();
  const behind = p.z >= -1e-9;
  if (behind) return { in: false, u: 0, v: 0, ndc: [0, 0], dist, behind: true, z: -p.z };
  const tx = Math.tan(s.hfov * D2R / 2), ty = Math.tan(s.vfov * D2R / 2);
  const u = (p.x / -p.z) / tx;
  const vUp = (p.y / -p.z) / ty;
  return {
    in: Math.abs(u) <= 1 && Math.abs(vUp) <= 1 && -p.z >= s.near,
    u, v: -vUp, ndc: [u, vUp], dist, behind: false, z: -p.z
  };
}

export { SPARE_COLORS, specOf };
