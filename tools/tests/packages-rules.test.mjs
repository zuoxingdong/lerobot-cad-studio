// The rules the generator enforces, held against the packages ON DISK: camera-slot poses,
// plate names and bed poses, and which slot owns which part. A hand-edited robot.json cannot
// smuggle the old shape back in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ids, load, PARTS_DIR, PART_DOCS } from './_assets.mjs';

const isMat16 = (v) => Array.isArray(v) && v.length === 16 && v.every((n) => Number.isFinite(n));

/** the nose-DOWN angle of a published camera matrix, in the frame it is published in */
function tiltOfLocal(local) {
  const m = local;                       // column-major 16: col2 = (m[8], m[9], m[10])
  const d = [-m[8], -m[9], -m[10]];      // the camera looks down its own -Z
  const n = Math.hypot(d[0], d[1], d[2]);
  return -Math.asin(Math.max(-1, Math.min(1, d[2] / n))) * 180 / Math.PI;
}
const camSlots = (d) => Object.entries(d.slots || {}).flatMap(([sid, s]) =>
  (s.provides || []).filter((p) => p.startsWith('cameras.'))
    .map((p) => [sid, s, p.slice('cameras.'.length)]));

test('every option of a camera-providing slot publishes a pose or the literal null', () => {
  const rows = [];
  for (const id of ['lekiwi', 'lekiwi-pincopen']) {
    const d = load(id);
    assert.ok(camSlots(d).length, `${id}: no camera-providing slot`);
    for (const [sid, s, cid] of camSlots(d)) {
      for (const o of s.options) {
        if (o.kind === 'import') continue;             // the one exemption
        assert.ok(o.cameras && Object.prototype.hasOwnProperty.call(o.cameras, cid),
          `${id}/${sid}/${o.id}: publishes no cameras.${cid} — a pose, or null`);
        const block = o.cameras[cid];
        if (block === null) { rows.push([id, sid, o.id, cid, 'null']); continue; }
        assert.ok(isMat16(block.local), `${id}/${sid}/${o.id}: cameras.${cid}.local`);
        rows.push([id, sid, o.id, cid, 'pose']);
      }
      /* an option that shows nothing cannot carry a camera: there is no mount to put it on */
      for (const o of s.options) {
        if (o.kind !== 'none') continue;
        assert.equal(o.cameras[cid], null, `${id}/${sid}/${o.id}: "none" must disable ${cid}`);
      }
    }
  }
  assert.ok(rows.filter((r) => r[4] === 'null').length >= 5, 'the empty options say so');
});

test("a camera block's tilt_deg is the tilt of the matrix it publishes", () => {
  const rows = [];
  for (const id of ['lekiwi', 'lekiwi-pincopen']) {
    const d = load(id);
    for (const [sid, s, cid] of camSlots(d)) {
      for (const o of s.options) {
        const block = (o.cameras || {})[cid];
        if (!block) continue;
        assert.equal(typeof block.tilt_deg, 'number', `${id}/${sid}/${o.id}: tilt_deg`);
        const got = tiltOfLocal(block.local);
        assert.ok(Math.abs(got - block.tilt_deg) < 0.01,
          `${id}/${sid}/${o.id}: says tilt ${block.tilt_deg}, the matrix is ${got.toFixed(3)}`);
        const m = /(-?\d+(?:\.\d+)?)\s*(?:deg\b|°)/.exec(o.label);
        if (m) {
          const said = Number(m[1]);
          assert.ok(Math.abs(said - block.tilt_deg) < 0.51 || Math.abs(said - (block.tilt_deg - 25)) < 0.51,
            `${id}/${sid}/${o.id}: the label says ${said}°, the pose is ${block.tilt_deg}°`);
        }
        rows.push(`${id}/${sid}/${o.id} ${block.tilt_deg}°`);
      }
    }
  }
  assert.equal(rows.length, 6, rows.join(' · '));
});

test('both packages agree on the stock LeKiwi camera poses, to the byte', () => {
  const A = load('lekiwi');
  const B = load('lekiwi-pincopen');
  const of = (d, sid, oid, cid) =>
    ((d.slots[sid].options.find((o) => o.id === oid) || {}).cameras || {})[cid];
  for (const [sid, oidA, oidB, cid] of [
    ['front_camera', 'stock', 'stock', 'front'],
    ['wrist_camera_mount', 'stock_v11', 'stock', 'wrist']]) {
    const a = of(A, sid, oidA, cid), b = of(B, sid, oidB, cid);
    assert.ok(a && b, `${sid}: both packages carry the stock option's ${cid} camera`);
    assert.equal(a.carrier, b.carrier, `${sid}: same carrier`);
    assert.deepEqual(a.local, b.local, `${sid}: same pose, to the byte`);
    const dmm = Math.hypot(a.local[12] - b.local[12], a.local[13] - b.local[13], a.local[14] - b.local[14]);
    assert.ok(dmm < 0.1, `${sid}: sensors ${dmm.toFixed(4)} mm apart`);
  }
});

test('every printable with an upstream PLATE states the bed pose it is printed in', () => {
  for (const id of ids) {
    const d = load(id);
    for (const c of d.components) {
      if (!c.printable || !c.print_file) continue;
      const plateIsTheMesh = c.mesh && c.print_file.split('/').pop() === c.mesh.split('/').pop();
      if (plateIsTheMesh) {
        assert.equal(c.print_transform ?? null, null,
          `${id}/${c.id}: print_file is its own mesh — it states no bed pose`);
        assert.match(c.print_fit_note || '', /IS the display mesh/,
          `${id}/${c.id}: states no bed pose and does not say why`);
        continue;
      }
      if (c.print_fit_note) continue;                 // the package says why it states none
      assert.ok(Array.isArray(c.print_transform) && c.print_transform.length === 16,
        `${id}/${c.id}: names the plate ${c.print_file} but states no print_transform`);
      const worst = c.print_fit_worst_mm;
      if (worst !== undefined) {
        assert.ok(worst < 0.05,
          `${id}/${c.id}: the plate fit is ${worst} mm — too far to be the same part`);
      }
    }
  }
});

test('a stated bed pose puts the part ON the bed (Z min 0, XY centred)', () => {
  for (const id of ids) {
    const d = load(id);
    for (const c of d.components) {
      if (!Array.isArray(c.print_transform)) continue;
      const M = c.print_transform;                    // column-major 16
      assert.ok(M.every(Number.isFinite), `${id}/${c.id}: 16 finite numbers`);
      /* the rotation block is orthonormal — a plate is the part MOVED, never rescaled */
      const col = (i) => [M[i * 4], M[i * 4 + 1], M[i * 4 + 2]];
      for (let i = 0; i < 3; i++) {
        const v = col(i);
        assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-6, `${id}/${c.id}: column ${i} is not a unit axis`);
      }
    }
  }
});

/* D2 — ONE NAME, ONE PART.  `head_PRINT.stl` (the overhead mast's camera head) and
   `head_PRINT.stl` (the wrist arch's) both landed in the same zip, so the export invented
   `head_PRINT-2.stl` — and WHICH of the two got the `-2` depended on the design. */
test('no two components of a package export the same plate name', () => {
  for (const id of ids) {
    const d = load(id);
    const seen = new Map();
    for (const c of d.components) {
      if (!c.print_name) continue;
      assert.equal(seen.has(c.print_name), false,
        `${id}: ${seen.get(c.print_name)} and ${c.id} both export as ${c.print_name}`);
      seen.set(c.print_name, c.id);
    }
  }
});

test('a plate exported by a part is named for the part it belongs to', () => {
  const d = load('lekiwi-pincopen');
  let checked = 0;
  for (const c of d.components) {
    if (!c.print_name || !c.part_of || !PART_DOCS[c.part_of]) continue;
    assert.ok(c.print_name.startsWith(c.part_of + '_'),
      `${c.id}: exports as ${c.print_name}, which does not name its set ${c.part_of}`);
    checked++;
  }
  assert.equal(checked, 5, `${checked} set plates checked`);
  /* the two heads are the same geometry on two different mounts — and now say so */
  const heads = d.components.filter((c) => (c.print_name || '').endsWith('_head_PRINT.stl'));
  assert.equal(heads.length, 2, 'both shipped mounts ship a camera head');
  assert.equal(new Set(heads.map((c) => c.print_name)).size, 2, 'two distinct export names');
});

/* E1 — A PART A SLOT OWNS IS FILED UNDER THAT SLOT.  `STS3215_03a-v1-4` is the stock jaw
   servo; the URDF calls it an arm link, so choosing "stock jaw" grew an ARM group holding
   one gripper part labelled with its raw mesh id. */
test('no slot owns a part filed under the stock arm', () => {
  for (const id of ids) {
    const d = load(id);
    const comp = Object.fromEntries(d.components.map((c) => [c.id, c]));
    for (const [sid, s] of Object.entries(d.slots || {})) {
      const owned = new Set(s.covers || []);
      for (const o of s.options || []) {
        for (const k of ['show', 'hide', 'parts']) for (const x of o[k] || []) owned.add(x);
      }
      for (const cid of owned) {
        const c = comp[cid];                           // `attachment:<pkg>` has no component here
        if (!c) continue;
        assert.notEqual(c.group, 'arm', `${id}/${sid} owns ${cid}, filed under group "arm"`);
        assert.notEqual(c.label, cid.replace(/[_-]+/g, ' '),
          `${id}/${sid} owns ${cid}, whose label is its own mesh id`);
      }
    }
  }
});

test('the stock jaw servo and the fixed jaw read the same in both packages', () => {
  for (const id of ['lekiwi', 'lekiwi-pincopen']) {
    const comp = Object.fromEntries(load(id).components.map((c) => [c.id, c]));
    assert.equal(comp['Wrist_Roll_08c-v1'].group, 'gripper', `${id}: fixed jaw group`);
    assert.equal(comp['Wrist_Roll_08c-v1'].label, 'Stock SO-101 fixed jaw (Wrist Roll 08c)', id);
    assert.equal(comp['STS3215_03a-v1-4'].group, 'gripper', `${id}: jaw servo group`);
    assert.equal(comp['STS3215_03a-v1-4'].label, 'Stock jaw servo (STS3215)', id);
  }
});
