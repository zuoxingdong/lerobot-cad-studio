/* The robot's cables on the page (the manifest's `cables`): each lead a tube through its
   knots, a clamped cubic B-spline as Blender's NURBS draws it; a knot rides its body, or the mean of two
   bodies across a joint, so a lead loops and straightens with its joint; each end's plug rides its body.
   Knots are frame-0 world metres; update(ride) takes ride(body, out) -> out = that body's motion from
   frame 0, in page units, or false.  Every lead and plug is one mesh (one draw call), coloured per vertex by
   its look (base, roughness, sheen): per lead its samples ((knots - 1) * PER_SPAN + 1 rings of ringSize(c)),
   then 24 corners per plug.  A `ribbon` lead (the servo bus) is a flat bonded ribbon of its wires, their plane
   starting on the start plug's wide axis and carried knot to knot without twist, as cables.ribbon: the
   B-spline is linear, so each wire's centreline is the film's wire.  The route is cables.py's. */
import * as THREE from 'three';

export const RADIAL = 6, PER_SPAN = 8;                  // tube sides; samples per knot span

/* the ribbon's section: [across in wire pitches, up in wire radii, normal across, normal up, wire]; a wire's edge
   is doubled so each wire keeps its own colour */
const RIBBON = [[-1.5, 0, -1, 0, 0], [-1, 1, -0.3, 1, 0], [-0.5, 0.82, 0, 1, 0], [-0.5, 0.82, 0, 1, 1], [0, 1, 0, 1, 1],
  [0.5, 0.82, 0, 1, 1], [0.5, 0.82, 0, 1, 2], [1, 1, 0.3, 1, 2], [1.5, 0, 1, 0, 2], [1, -1, 0.3, -1, 2],
  [0.5, -0.82, 0, -1, 2], [0.5, -0.82, 0, -1, 1], [0, -1, 0, -1, 1], [-0.5, -0.82, 0, -1, 1], [-0.5, -0.82, 0, -1, 0],
  [-1, -1, -0.3, -1, 0]];
const SEAMS = new Set([2, 5, 10, 13]);                   // section edges of zero width (a wire's edge)

const flat = (c) => !!(c.ribbon && (c.plugs || []).length);
/** vertices per ring of cable c */
export const ringSize = (c) => (flat(c) ? RIBBON.length : RADIAL);

/** the clamped uniform cubic B-spline through control points P ([n][3]) at `m` samples, into out (3m) */
export function bspline(P, m, out) {
  const n = P.length, p = Math.min(3, n - 1), span = n - p;
  const knot = (i) => Math.min(Math.max(i - p, 0), span);
  const d = new Float64Array(3 * (p + 1));
  for (let s = 0; s < m; s++) {
    const u = span * s / (m - 1);
    let k = Math.min(Math.floor(u) + p, n - 1);
    for (let j = 0; j <= p; j++) for (let c = 0; c < 3; c++) d[3 * j + c] = P[j + k - p][c];
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = j + k - p, a0 = knot(i), a1 = knot(i + p - r + 1);
        const a = a1 > a0 ? (u - a0) / (a1 - a0) : 0;
        for (let c = 0; c < 3; c++) d[3 * j + c] = (1 - a) * d[3 * (j - 1) + c] + a * d[3 * j + c];
      }
    }
    for (let c = 0; c < 3; c++) out[3 * s + c] = d[3 * p + c];
  }
  return out;
}

const _t = new THREE.Vector3(), _u = new THREE.Vector3(), _v = new THREE.Vector3(), _q = new THREE.Vector3();
const tangent = (C, s, n) => {
  const a = Math.max(0, s - 1), b = Math.min(n - 1, s + 1);
  return _q.set(C[3 * b] - C[3 * a], C[3 * b + 1] - C[3 * a + 1], C[3 * b + 2] - C[3 * a + 2]).normalize();
};

/* the tube's rings round the curve C (3n), radius r, the frames carried along (parallel transport), into P / N
   from vertex v0 */
function sweep(P, N, v0, C, n, r) {
  for (let s = 0; s < n; s++) {
    const q = tangent(C, s, n);
    if (s === 0) {
      _t.copy(q);
      _u.set(0, 0, 1).cross(_t);
      if (_u.lengthSq() < 1e-6) _u.set(1, 0, 0).cross(_t);
      _u.normalize();
    } else {
      _u.addScaledVector(q, -_u.dot(q)).normalize();
      _t.copy(q);
    }
    _v.crossVectors(_t, _u);
    for (let k = 0; k < RADIAL; k++) {
      const ang = 2 * Math.PI * k / RADIAL, cx = Math.cos(ang), sy = Math.sin(ang), o = 3 * (v0 + s * RADIAL + k);
      const nx = _u.x * cx + _v.x * sy, ny = _u.y * cx + _v.y * sy, nz = _u.z * cx + _v.z * sy;
      N[o] = nx; N[o + 1] = ny; N[o + 2] = nz;
      P[o] = C[3 * s] + r * nx; P[o + 1] = C[3 * s + 1] + r * ny; P[o + 2] = C[3 * s + 2] + r * nz;
    }
  }
}

/* the ribbon's sections round the curve C along the side curve U (3n, one wire pitch per unit), wire radius r */
function sweepRibbon(P, N, v0, C, U, n, pitch, r) {
  const w = new THREE.Vector3(), a = new THREE.Vector3();
  for (let s = 0; s < n; s++) {
    const t = tangent(C, s, n);
    _u.set(U[3 * s], U[3 * s + 1], U[3 * s + 2]);
    w.crossVectors(t, _u).normalize();
    a.copy(_u).normalize();
    RIBBON.forEach(([x, y, nx, ny], k) => {
      const o = 3 * (v0 + s * RIBBON.length + k);
      _v.copy(a).multiplyScalar(nx).addScaledVector(w, ny).normalize();
      N[o] = _v.x; N[o + 1] = _v.y; N[o + 2] = _v.z;
      P[o] = C[3 * s] + x * pitch * _u.x + y * r * w.x;
      P[o + 1] = C[3 * s + 1] + x * pitch * _u.y + y * r * w.y;
      P[o + 2] = C[3 * s + 2] + x * pitch * _u.z + y * r * w.z;
    });
  }
}

/* a plug box's 24 corners (6 quads) in its own frame, metres, with their normals */
function boxCorners(h) {
  const V = [], Nr = [];
  for (let ax = 0; ax < 3; ax++) for (const sg of [-1, 1]) {
    const a1 = (ax + 1) % 3, a2 = (ax + 2) % 3;
    for (const [s1, s2] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const c = [0, 0, 0], n = [0, 0, 0];
      c[ax] = sg * h[ax]; c[a1] = s1 * h[a1] * sg; c[a2] = s2 * h[a2]; n[ax] = sg;
      V.push(c); Nr.push(n);
    }
  }
  return { V, N: Nr };
}

/* per-vertex look: linear base, roughness and sheen of spec key k (sheenColor = base) */
const lookOf = (looks, k) => {
  const s = (looks.spec && k && looks.spec(k)) || {};
  return { rgb: Array.isArray(s.base) ? s.base : [0.03, 0.03, 0.03], rough: Math.max(0.04, s.rough ?? 0.5), sheen: s.sheen || 0 };
};

/* the one material: the look's base, roughness and sheen per vertex (colour, rpsLook) */
function cableMaterial(looks, key) {
  const m = looks.make ? looks.make(key) : looks.get(key, null);
  if (!m.isMeshStandardMaterial) return m;
  m.color.setRGB(1, 1, 1);
  m.vertexColors = true;
  if (m.isMeshPhysicalMaterial) { m.sheen = 1; m.sheenRoughness = 0.45; m.sheenColor.setRGB(1, 1, 1); }
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = 'attribute vec2 rpsLook;\nvarying vec2 vRpsLook;\n' + sh.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRpsLook = rpsLook;');
    sh.fragmentShader = 'varying vec2 vRpsLook;\n' + sh.fragmentShader
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vRpsLook.x;')
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_SHEEN\nmaterial.sheenColor *= vColor.rgb * vRpsLook.y;\n#endif');
  };
  m.customProgramCacheKey = () => 'rps-cable';
  return m;
}

/**
 * All leads and plugs as ONE mesh (one draw call), rebuilt on update.
 * @param specs the manifest's cables  @param looks a Looks (the leads' and plugs' looks)
 * @param opts {scale: page units per metre}
 * @returns {{group, mesh, update(ride), dispose(), tris}}
 */
export function createCables(specs, looks, { scale = 1 } = {}) {
  const group = new THREE.Group();
  group.name = 'robot-cables';
  const leads = [], plugs = [], idx = [], col = [], rs = [];
  let nv = 0;
  const paint = (k, count) => {
    const L = lookOf(looks, k);
    for (let i = 0; i < count; i++) { col.push(...L.rgb); rs.push(L.rough, L.sheen); }
  };
  for (const c of specs || []) {
    const n = (c.knots.length - 1) * PER_SPAN + 1, R = ringSize(c), i0 = idx.length;
    for (let s = 0; s + 1 < n; s++) for (let r = 0; r < R; r++) {
      if (flat(c) && SEAMS.has(r)) continue;
      const a = nv + s * R + r, b = nv + s * R + (r + 1) % R;
      idx.push(a, a + R, b, b, a + R, b + R);
    }
    for (let s = 0; s < n; s++) {
      if (flat(c)) RIBBON.forEach((x) => paint(c.ribbon.keys[x[4]], 1)); else paint(c.key, R);
    }
    const rb = flat(c) && { pitch: c.ribbon.d_mm * 0.001 * scale, r: c.ribbon.d_mm * 0.0005 * scale, U: c.knots.map(() => [0, 0, 0]),
      Cu: new Float32Array(3 * n), side: new THREE.Vector3(...c.plugs[0].axes[1]) };
    const L = { c, n, R, v0: nv, i0, tpr: (idx.length - i0) / 3 / Math.max(n - 1, 1), K: c.knots.map(() => [0, 0, 0]),
      C: new Float32Array(3 * n), r: c.d_mm * 0.0005 * scale, ends: [], rb };
    leads.push(L);
    nv += n * R;
    for (const pl of c.plugs || []) {
      const [d, u, w] = pl.axes;
      const rest = new THREE.Matrix4().set(d[0], u[0], w[0], pl.c[0], d[1], u[1], w[1], pl.c[1], d[2], u[2], w[2], pl.c[2], 0, 0, 0, 1);
      L.ends.push(idx.length);
      for (let f = 0; f < 6; f++) { const a = nv + 4 * f; idx.push(a, a + 1, a + 2, a, a + 2, a + 3); }
      plugs.push({ rest, body: pl.body, v0: nv, box: boxCorners(pl.half) });
      paint(c.plug || c.key, 24);
      nv += 24;
    }
  }
  const g = new THREE.BufferGeometry();
  const P = new Float32Array(3 * nv), N = new Float32Array(3 * nv);
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('rpsLook', new THREE.Float32BufferAttribute(rs, 2));
  g.setIndex(idx);
  const key = (specs && specs[0] && specs[0].key) || 'cable';
  const mesh = new THREE.Mesh(g, cableMaterial(looks, key));
  mesh.name = 'cables:' + key;
  mesh.frustumCulled = false;
  if (nv) group.add(mesh);
  const M = new THREE.Matrix4(), M2 = new THREE.Matrix4(), R3 = new THREE.Matrix3();
  const p = new THREE.Vector3(), p2 = new THREE.Vector3(), t = new THREE.Vector3(), sd = new THREE.Vector3();
  const cut = new Uint8Array(idx.length / 3), tails = [];
  const near = (L, s, at) => Math.hypot(L.C[3 * s] - at.x, L.C[3 * s + 1] - at.y, L.C[3 * s + 2] - at.z);
  /* the ribbon's side per knot: the start plug's wide axis on its body, square to each knot's tangent in turn */
  const sides = (L, ride) => {
    const { K } = L, { U } = L.rb, n = K.length;
    if (!ride(L.c.plugs[0].body, M)) return false;
    sd.copy(L.rb.side).applyMatrix3(R3.setFromMatrix4(M)).normalize();
    for (let j = 0; j < n; j++) {
      const a = K[Math.max(j - 1, 0)], b = K[Math.min(j + 1, n - 1)];
      t.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
      sd.addScaledVector(t, -sd.dot(t)).normalize();
      U[j][0] = sd.x; U[j][1] = sd.y; U[j][2] = sd.z;
    }
    return true;
  };
  return {
    group, mesh, tris: idx.length / 3,
    /** the lead whose far end is within r of `at` (this group's frame, after an update): its end as far as it
     *  stays within r, and that end's plug, moved to a mesh of their own on the same attributes; or null */
    tail(at, r) {
      let L = null;
      for (const x of leads) if (!tails.includes(x) && near(x, x.n - 1, at) < r && (!L || near(x, x.n - 1, at) < near(L, L.n - 1, at))) L = x;
      if (!L) return null;
      tails.push(L);
      let s0 = L.n - 1;
      while (s0 > 0 && near(L, s0 - 1, at) < r) s0--;
      const own = [], t0 = L.i0 / 3 + (s0 > 0 ? (s0 - 1) * L.tpr : 0), t1 = L.i0 / 3 + (L.n - 1) * L.tpr;
      const e = L.ends.length ? L.ends[L.ends.length - 1] / 3 : -1;
      for (let k = 0; k < cut.length; k++) if ((k >= t0 && k < t1) || (e >= 0 && k >= e && k < e + 12)) { cut[k] = 1; own.push(idx[3 * k], idx[3 * k + 1], idx[3 * k + 2]); }
      g.setIndex(idx.filter((_, i) => !cut[(i / 3) | 0]));
      const tg = new THREE.BufferGeometry();
      for (const a of ['position', 'normal', 'color', 'rpsLook']) tg.setAttribute(a, g.attributes[a]);
      tg.setIndex(own);
      const m = new THREE.Mesh(tg, mesh.material);
      m.name = mesh.name + ':tail';
      m.frustumCulled = false;
      group.add(m);
      return m;
    },
    /** ride(body, out): out = the body's motion since frame 0 (frame-0 metres -> page units), or false */
    update(rideBody) {
      const seen = new Map();
      const ride = (b, out) => {                             // once per body per update
        if (!seen.has(b)) { const m = new THREE.Matrix4(); seen.set(b, rideBody(b, m) ? m : null); }
        const m = seen.get(b);
        if (m) out.copy(m);
        return !!m;
      };
      for (const L of leads) {
        let ok = true;
        L.c.knots.forEach((k, j) => {
          const [b0, b1] = L.c.bodies[j];
          if (!ride(b0, M)) { ok = false; return; }
          p.fromArray(k).applyMatrix4(M);
          if (b1 !== b0 && ride(b1, M2)) p.add(p2.fromArray(k).applyMatrix4(M2)).multiplyScalar(0.5);
          L.K[j][0] = p.x; L.K[j][1] = p.y; L.K[j][2] = p.z;
        });
        if (!ok) continue;
        bspline(L.K, L.n, L.C);
        if (L.rb && sides(L, ride)) {
          bspline(L.rb.U, L.n, L.rb.Cu);
          sweepRibbon(P, N, L.v0, L.C, L.rb.Cu, L.n, L.rb.pitch, L.rb.r);
        } else if (!L.rb) sweep(P, N, L.v0, L.C, L.n, L.r);
      }
      for (const pl of plugs) {
        if (!ride(pl.body, M)) continue;
        M.multiply(pl.rest);                                 // the box is in metres; M carries it to page units
        R3.setFromMatrix4(M);
        for (let i = 0; i < 24; i++) {
          p.fromArray(pl.box.V[i]).applyMatrix4(M).toArray(P, 3 * (pl.v0 + i));
          p.fromArray(pl.box.N[i]).applyMatrix3(R3).normalize().toArray(N, 3 * (pl.v0 + i));
        }
      }
      g.attributes.position.needsUpdate = true;
      g.attributes.normal.needsUpdate = true;
    },
    /** the wire centrelines of ribbon lead i now: [[n][3] per wire] (page units) */
    wires(i) {
      const L = leads[i];
      if (!L || !L.rb) return null;
      const U = L.rb.U, k = L.c.ribbon.keys.length, mid = (k - 1) / 2;
      return L.c.ribbon.keys.map((_, w) => L.K.map((q, j) => q.map((v, c) => v + U[j][c] * (w - mid) * L.rb.pitch)));
    },
    dispose() { g.dispose(); mesh.material.dispose(); for (const o of group.children) if (o !== mesh) o.geometry.dispose(); group.removeFromParent(); },
  };
}
