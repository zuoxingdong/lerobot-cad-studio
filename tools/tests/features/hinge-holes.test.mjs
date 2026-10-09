/* The printed hinges as the page draws them: at every detent of both camera mounts the head's
   hinge bore stays on the cheeks' bore, one of the head's blind index seats sits on a fan hole
   on the same side, and the camera it carries looks the detent's angle below the horizontal.
   Packed meshes, the page's own hinge turn, holes found by slicing across the hinge axis. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Vector3 } from 'three';
import { studio, table, round } from './_harness.mjs';
import { hingesOf, hingeTransforms, hingedCameraLocal } from '../../../src/features/hinge.js';

const TOL = 0.1;                           // mm, centre to centre
const BORE_D = 3.4, PIN_D = 3.2;           // hinge bolt and index pin clearance

const MOUNTS = [
  { part: 'corner_mast_printed', fixed: 'corner_mast_printed_spar_upper', head: 'corner_mast_printed_head' },
  { part: 'df200_arch', fixed: 'df200_arch_arch', head: 'df200_arch_head' },
];

/* hinge frame: e1 along the axis, e0 / e2 across it */
function hingeFrame(origin, axis) {
  const a = new Vector3().fromArray(axis).normalize();
  const t = Math.abs(a.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0);
  const x = new Vector3().crossVectors(a, t).normalize();
  const z = new Vector3().crossVectors(x, a);
  const o = new Vector3().fromArray(origin);
  return (p) => { const d = p.clone().sub(o); return [d.dot(x), d.dot(a), d.dot(z)]; };
}

/* triangles of a component's geometry, through M, in the hinge frame */
function triangles(geometry, M, toH) {
  const pos = geometry.attributes.position.array;
  const idx = geometry.index ? geometry.index.array : null;
  const n = idx ? idx.length : pos.length / 3;
  const P = [];
  for (let i = 0; i < n; i++) {
    const k = idx ? idx[i] : i;
    P.push(toH(new Vector3(pos[3 * k], pos[3 * k + 1], pos[3 * k + 2]).applyMatrix4(M)));
  }
  const tris = [];
  for (let i = 0; i + 2 < P.length; i += 3) tris.push([P[i], P[i + 1], P[i + 2]]);
  return tris;
}

/* the section at axial s, chained into loops; the round ones as {c:[u, w], d} */
function circles(tris, s) {
  const segs = [];
  for (const t of tris) {
    const pts = [];
    for (let i = 0; i < 3; i++) {
      const a = t[i], b = t[(i + 1) % 3];
      const da = a[1] - s, db = b[1] - s;
      if ((da < 0) === (db < 0) || da === db) continue;
      const f = da / (da - db);
      pts.push([a[0] + f * (b[0] - a[0]), a[2] + f * (b[2] - a[2])]);
    }
    if (pts.length === 2) segs.push(pts);
  }
  const key = (p) => `${Math.round(p[0] * 1e3)},${Math.round(p[1] * 1e3)}`;
  const nbr = new Map();
  segs.forEach((sg, i) => { for (const p of sg) { const k = key(p); if (!nbr.has(k)) nbr.set(k, []); nbr.get(k).push(i); } });
  const used = new Uint8Array(segs.length), out = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const loop = [segs[i][0]];
    let cur = segs[i][1];
    for (let guard = 0; guard < segs.length; guard++) {
      loop.push(cur);
      const j = (nbr.get(key(cur)) || []).find((x) => !used[x]);
      if (j === undefined) break;
      used[j] = 1;
      cur = key(segs[j][0]) === key(cur) ? segs[j][1] : segs[j][0];
    }
    if (loop.length < 8) continue;
    const c = [0, 1].map((k) => loop.reduce((acc, p) => acc + p[k], 0) / loop.length);
    const r = loop.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1]));
    const rm = r.reduce((a, b) => a + b, 0) / r.length;
    if (rm < 2.5 && Math.max(...r) - Math.min(...r) < 0.3) out.push({ c, d: 2 * rm, s });
  }
  return out;
}

/* round holes of one diameter across the mesh's axial extent */
function holes(tris, d, lo, hi) {
  const out = [];
  for (let k = 0; k <= 16; k++) out.push(...circles(tris, lo + ((hi - lo) * k) / 16).filter((h) => Math.abs(h.d - d) < 0.15));
  return out;
}
const axial = (tris) => { let lo = Infinity, hi = -Infinity; for (const t of tris) for (const p of t) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); } return [lo + 0.3, hi - 0.3]; };
const dist = (a, b) => Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1]);

for (const m of MOUNTS) {
  test(`${m.part}: hinge bore and index pin concentric at every detent`, async () => {
    const { model, design } = await studio();
    await model.loadGeometries();
    const [{ key, def }] = hingesOf(model, m.part);
    const toH = hingeFrame(def.origin, def.axis);
    const Wf = model.worldMatrix(m.fixed);
    const inv = Wf.clone().invert();
    const fixed = triangles(model.component(m.fixed).geometry, new Matrix4(), toH);
    const [flo, fhi] = axial(fixed);
    const bores = holes(fixed, BORE_D, flo, fhi), fan = holes(fixed, PIN_D, flo, fhi);
    assert.ok(bores.length >= 2 && fan.length >= def.values.length, `${m.part}: ${bores.length} bore / ${fan.length} fan sections`);
    const rows = [];
    for (const v of def.values) {
      const d2 = { ...design, parts: { ...(design.parts || {}), [m.part]: { params: { [key]: v } } } };
      const H = hingeTransforms(model, d2, (pid) => pid === m.part).get(m.head) || new Matrix4();
      const rel = inv.clone().multiply(model.worldMatrix(m.head)).multiply(H);
      const head = triangles(model.component(m.head).geometry, rel, toH);
      const [hlo, hhi] = axial(head);
      const hb = holes(head, BORE_D, hlo, hhi), seats = holes(head, PIN_D, hlo, hhi);
      assert.ok(hb.length && seats.length, `${m.part} ${v}°: no head bore / seat found`);
      const bore = Math.max(...hb.map((h) => Math.min(...bores.map((b) => dist(h, b)))));
      let pin = Infinity;
      for (const sft of seats) for (const f of fan) if (Math.sign(sft.s) === Math.sign(f.s)) pin = Math.min(pin, dist(sft, f));
      const cam = hingedCameraLocal(model, d2, m.part, def.camera, model.manifest.parts[m.part].cameras[def.camera].local);
      const tilt = (Math.asin(Math.min(1, cam[10] / Math.hypot(cam[8], cam[9], cam[10]))) * 180) / Math.PI;
      rows.push({ detent: v, bore_mm: round(bore, 3), pin_mm: round(pin, 3), camera_tilt: round(tilt, 3) });
      assert.ok(Math.abs(tilt - v) < 1e-6, `${m.part} ${v}°: the camera looks ${tilt.toFixed(3)}° down`);
      assert.ok(bore <= TOL, `${m.part} ${v}°: head bore ${bore.toFixed(3)} mm off the cheek bore`);
      assert.ok(pin <= TOL, `${m.part} ${v}°: nearest seat ${pin.toFixed(3)} mm off a fan hole`);
    }
    table(`${m.part}: head vs cheek hole centres (mm)`, rows);
  });
}
