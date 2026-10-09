// Robot PACKAGES and PARTS: schema, provenance, and that every path one names actually exists.
// These run against assets/ on disk (a composition resolved as the page resolves it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROBOTS_DIR as ROBOTS, PARTS_DIR, ids, raw, load, PART_DOCS } from './_assets.mjs';

const GROUPS = new Set(['base', 'arm', 'wheels', 'electronics', 'camera', 'gripper', 'upgrade',
                        'body', 'linkage', 'finger', 'fingertip', 'hardware']);
const FRAMES = new Set(['mesh', 'link', 'robot', 'attachment']);
const isMat16 = (v) => Array.isArray(v) && v.length === 16 && v.every((n) => Number.isFinite(n));

/* a slot option of kind `parts` names the components its part resolves to */
const UPGRADE_PART_IDS = new Set(load('lekiwi-pincopen').components.filter((c) => c.part_of).map((c) => c.id));

test('the two robots and the PincOpen attachment package exist', () => {
  for (const want of ['lekiwi', 'pincopen', 'lekiwi-pincopen']) assert.ok(ids.includes(want), want);
  assert.deepEqual(ids.filter((id) => raw(id).kind !== 'attachment').sort(), ['lekiwi', 'lekiwi-pincopen']);
});

for (const id of ids) {
  test(`${id}: schema and identity`, () => {
    const d = load(id);
    assert.equal(raw(id).schema, d.composition ? 'rps/robot@2' : 'rps/robot@1');
    assert.equal(d.schema, 'rps/robot@1', 'resolved');
    assert.equal(d.id, id);
    assert.ok(d.name && d.version, 'name + version');
    assert.equal(d.units, 'mm');
    assert.equal(d.up, 'z');
  });

  test(`${id}: provenance`, () => {
    const d = load(id);
    if (d.composition) return;                       // a composition inherits its sources
    assert.ok(d.source, 'source block');
    assert.match(d.source.commit, /^[0-9a-f]{40}$/, 'full 40-char commit');
    assert.ok(d.source.repo.startsWith('https://'), 'repo url');
    assert.ok(d.source.license, 'licence');
    assert.match(d.source.fetched, /^\d{4}-\d{2}-\d{2}$/, 'fetched date');
    assert.ok(existsSync(join(ROBOTS, id, 'SOURCE.md')), 'SOURCE.md');
    assert.ok(existsSync(join(ROBOTS, id, 'LICENSE-upstream.txt')), 'LICENSE-upstream.txt');
    const src = readFileSync(join(ROBOTS, id, 'SOURCE.md'), 'utf8');
    assert.ok(src.includes(d.source.commit), 'SOURCE.md quotes the same commit');
  });

  test(`${id}: components are well formed and their meshes exist`, () => {
    const d = load(id);
    if (d.composition) return;
    assert.ok(d.components.length > 0);
    const seen = new Set();
    for (const c of d.components) {
      assert.ok(c.id, 'component id');
      assert.ok(!seen.has(c.id), `duplicate component id ${c.id}`);
      seen.add(c.id);
      assert.ok(GROUPS.has(c.group), `${c.id}: unknown group ${c.group}`);
      assert.ok(FRAMES.has(c.frame), `${c.id}: unknown frame ${c.frame}`);
      assert.ok(isMat16(c.local), `${c.id}: local must be 16 finite numbers`);
      assert.ok(existsSync(join(ROBOTS, id, c.mesh)), `${c.id}: missing ${c.mesh}`);
      if (c.print_file) assert.ok(existsSync(join(ROBOTS, id, c.print_file)),
                                  `${c.id}: missing ${c.print_file}`);
    }
  });

  test(`${id}: cameras carry an hFOV and a source`, () => {
    const d = load(id);
    for (const cam of d.cameras || []) {
      assert.ok(cam.id && cam.label, 'id + label');
      assert.ok(cam.hfov_deg > 10 && cam.hfov_deg < 180, `${cam.id}: hfov ${cam.hfov_deg}`);
      assert.ok(cam.source && cam.source.what, `${cam.id}: every hFOV must say where it came from`);
      if (cam.local) assert.ok(isMat16(cam.local), `${cam.id}: local`);
    }
  });

  test(`${id}: slots resolve`, () => {
    const d = load(id);
    const compIds = new Set((d.components || []).map((c) => c.id));
    for (const [sid, s] of Object.entries(d.slots || {})) {
      assert.ok(s.label, `${sid}: label`);
      assert.ok(Array.isArray(s.options) && s.options.length, `${sid}: options`);
      const optIds = s.options.map((o) => o.id);
      assert.ok(optIds.includes(s.default), `${sid}: default ${s.default} is not an option`);
      assert.equal(new Set(optIds).size, optIds.length, `${sid}: duplicate option ids`);
      for (const o of s.options) {
        assert.ok(o.label, `${sid}/${o.id}: label`);
        for (const c of o.show || []) {
          if (!d.composition) assert.ok(compIds.has(c), `${sid}/${o.id}: no component ${c}`);
        }
        for (const p of o.parts || []) assert.ok(UPGRADE_PART_IDS.has(p), `${sid}/${o.id}: no upgrade ${p}`);
        /* an option that publishes a camera says WHICH FRAME the matrix is in, or the studio
           has to guess: the option's own `frame` (in `part.json`), or
           the block's `carrier` when the mount hangs off something else entirely — the
           stock SO-101 bracket's camera rides the `Camera-Model-v3-1` link.
           `null` is a POSE TOO: it says this option carries no camera. */
        for (const [cid, cam] of Object.entries(o.cameras || {})) {
          if (cam === null) continue;
          assert.ok(['robot', 'slot_anchor', 'attachment'].includes(o.frame || 'robot')
                    || typeof cam.carrier === 'string',
                    `${sid}/${o.id}: camera ${cid} in unknown frame "${o.frame}"`);
          assert.ok(isMat16(cam.local), `${sid}/${o.id}: camera ${cid} local`);
          const dev = (d.cameras || []).find((c) => c.id === cid) || {};
          if (cam.hfov_deg !== undefined) {
            assert.equal(cam.hfov_deg, dev.hfov_deg,
              `${sid}/${o.id}: camera ${cid} may not change the lens`);
          }
        }
        if (o.kind === 'attachment') {
          assert.ok(ids.includes(o.package), `${sid}/${o.id}: no package ${o.package}`);
        }
      }
    }
  });
}

test('lekiwi: kinematics is complete and the URDF is there', () => {
  const d = load('lekiwi');
  const k = d.kinematics;
  assert.ok(existsSync(join(ROBOTS, 'lekiwi', k.urdf)));
  assert.equal(k.urdf_units, 'm');
  assert.equal(k.mesh_units, 'mm');
  assert.ok(k.joints.length > 30, 'every URDF joint is carried');
  assert.equal(k.arm_joint_order.length, 6);
  for (const j of k.arm_joint_order) {
    const lim = k.joint_limits_deg[j];
    assert.ok(Array.isArray(lim) && lim.length === 2 && lim[0] < lim[1], `${j}: limits`);
  }
  assert.ok(k.joint_limits_source.length > 200, 'the limits carry their derivation');
  assert.ok(d.frames.wrist_flange.link && isMat16(d.frames.wrist_flange.local));
});

test('pincopen: registration residuals are small; one control joint; the linkage parts ride their links', () => {
  const d = load('pincopen');
  assert.equal(d.kind, 'attachment');
  assert.equal(d.derivation.method, 'registration');
  for (const c of d.components) {
    if (c.group === 'hardware') {
      assert.ok(c.placement && c.placement.seats.length >= 3 && c.placement.seats.every((s) => s.residual_mm < 0.1), `${c.id}: placement`);
      continue;
    }
    assert.ok(c.registration && c.registration.rms_mm < 0.6, `${c.id}: registration`);
  }
  assert.equal(d.components.find((c) => c.id === 'cam').group, 'gripper', 'the cam disc is gripper drive, not a camera');
  assert.equal(d.kinematics.joints.filter((j) => j.control).length, 1);
  assert.deepEqual(d.kinematics.control_display.jaw, { ...d.kinematics.control_display.jaw, kind: 'fourbar_gap', unit: 'mm', range: [0, 40] });
  const JOINT_OF = Object.fromEntries(d.kinematics.joints.map((j) => [j.child, j.name]));
  const moving = d.components.filter((c) => c.linkage_role === 'coupler' || c.linkage_role === 'rotating_link');
  assert.equal(moving.length, 12);
  for (const c of moving) {
    assert.ok(c.frame === 'link' && c.moves_with === JOINT_OF[c.link], c.id);
    assert.match(c.link, c.side === 'y_pos' ? /_R$/ : /_L$/, `${c.id}: side ${c.side} -> ${c.link}`);
  }
  for (const c of d.components.filter((x) => !moving.includes(x))) assert.equal(c.frame, 'robot', `${c.id}: only the linkage moves`);
});

test('lekiwi-pincopen is a composition BY REFERENCE: nothing of the base is copied', () => {
  const r = raw('lekiwi-pincopen');
  const base = raw(r.base);
  for (const k of ['components', 'kinematics', 'presets']) assert.equal(r[k], undefined, `a copied ${k}`);
  for (const f of Object.keys(r.frames)) assert.equal(base.frames[f], undefined, `frame ${f} is the base's`);
  const baseIds = new Set(base.components.map((c) => c.id));
  for (const h of r.hide) assert.ok(baseIds.has(h), `hide ${h} is not a base component`);
  for (const a of r.attach) assert.ok(ids.includes(a.robot), `attaches ${a.robot}`);
  for (const [sid, s] of Object.entries(r.slots)) {
    for (const o of s.options) {
      if (typeof o !== 'string') continue;
      const pid = o.includes(':') ? o.split(':')[1] : o;
      assert.ok(PART_DOCS[pid], `${sid}: option ${o} names no part`);
      assert.equal(PART_DOCS[pid].slot, sid, `${sid}: ${pid} is a part of slot ${PART_DOCS[pid].slot}`);
    }
  }
  for (const rule of r.rules) {
    const opts = load('lekiwi-pincopen').slots[rule.slot].options.map((o) => o.id);
    assert.ok(opts.includes(rule.option), `rule for ${rule.slot}/${rule.option}`);
  }
});

for (const [pid, p] of Object.entries(PART_DOCS)) {
  test(`part ${pid}: rps/part@1, and every file it names exists`, () => {
    assert.equal(p.schema, 'rps/part@1');
    assert.equal(p.id, pid);
    assert.ok(['robot', 'slot_anchor', 'attachment'].includes(p.frame));
    assert.ok(p.slot === null || load(p.robot).slots[p.slot], `${pid}: slot ${p.slot}`);
    const seen = new Set();
    for (const m of p.meshes) {
      assert.ok(!seen.has(m.id), `${pid}: mesh ${m.id} twice`);
      seen.add(m.id);
      assert.ok(m.file || m.print, `${pid}/${m.id}: no file`);
      if (m.file) assert.ok(existsSync(join(PARTS_DIR, pid, m.file)), `${pid}/${m.id}: ${m.file}`);
      if (m.print && m.print.startsWith('part:')) assert.ok(PART_DOCS[m.print.slice(5)], `${pid}/${m.id}: ${m.print}`);
      else if (m.print) assert.ok(existsSync(join(PARTS_DIR, pid, m.print)), `${pid}/${m.id}: ${m.print}`);
    }
    for (const d of p.docs || []) assert.ok(existsSync(join(PARTS_DIR, pid, d)), `${pid}: ${d}`);
    for (const [k, h] of Object.entries(p.params || {})) {
      if (h.kind !== 'hinge') continue;
      assert.ok(h.values.includes(h.value) && h.values.includes(h.design), `${pid}.${k}: value on a detent`);
      assert.ok(h.usable[0] >= h.values[0] && h.usable[1] <= h.values.at(-1), `${pid}.${k}: usable`);
      assert.ok(Math.abs(Math.hypot(...h.axis) - 1) < 1e-9, `${pid}.${k}: unit axis`);
      for (const mv of h.moves) assert.ok(seen.has(mv), `${pid}.${k}: moves ${mv}`);
      assert.ok(p.cameras[h.camera], `${pid}.${k}: camera ${h.camera}`);
    }
  });
}

test('arm presets are present, legal and IK-corrected', () => {
  for (const id of ['lekiwi', 'lekiwi-pincopen']) {
    const d = load(id);
    assert.ok(Array.isArray(d.presets) && d.presets.length === 4, `${id}: four presets`);
    const byId = Object.fromEntries(d.presets.map((p) => [p.id, p.q]));
    assert.deepEqual(Object.keys(byId).sort(),
                     ['raised_max', 'reach_floor', 'reach_table', 'stowed']);
    assert.equal(byId.reach_floor.arm_wrist_flex, 170.5, '171 is 0.5 deg past the limit');
    assert.deepEqual(byId.stowed, Object.fromEntries(
      d.kinematics.arm_joint_order.map((j) => [j, 0])), 'stowed is the URDF zero pose');
    const lim = d.kinematics.joint_limits_deg;
    for (const p of d.presets) {
      for (const [j, v] of Object.entries(p.q)) {
        assert.ok(v >= lim[j][0] && v <= lim[j][1],
                  `${id}/${p.id}: ${j} = ${v} is outside ${lim[j]}`);
      }
    }
    assert.ok(d.presets_source.length > 100, `${id}: presets carry their derivation`);
  }
});

test('slots cover every part their options draw; every rule names real options', () => {
  const WHOLE = ['Wrist_Roll_08c-v1', 'Moving_Jaw_08d-v1', 'STS3215_03a-v1-4'];
  for (const id of ['lekiwi', 'lekiwi-pincopen']) {
    const g = load(id).slots.gripper;
    for (const part of WHOLE) assert.ok(g.covers.includes(part) && g.options.find((o) => o.id === 'stock_jaw').show.includes(part), `${id}: ${part}`);
  }
  const d = load('lekiwi-pincopen');
  const opt = (sid, o) => d.slots[sid].options.find((x) => x.id === o);
  for (const [sid, s] of Object.entries(d.slots)) {
    for (const o of s.options) {
      for (const id of o.show || []) assert.ok(s.covers.includes(id), `${sid}/${o.id}: ${id} is not covered`);
      for (const [other, rule] of Object.entries(o.requires || {})) {
        const ids = d.slots[other].options.map((x) => x.id);
        for (const a of rule.any) assert.ok(ids.includes(a), `${sid}/${o.id} -> ${other}: ${a}`);
        assert.ok(ids.includes(rule.else), `${sid}/${o.id} -> ${other}: else ${rule.else}`);
      }
    }
  }
  for (const c of d.components) if (c.slot) assert.ok(d.slots[c.slot] && d.slots[c.slot].covers.includes(c.id), `${c.id}: slot ${c.slot}`);
  assert.ok(d.slots.gripper.covers.includes('attachment:pincopen'));
  assert.equal(d.frames.wrist_flange.link, 'Wrist_Roll_08c-v1', 'hiding the fixed jaw keeps its link and frame');
  assert.deepEqual(opt('wrist_camera_mount', 'pincopen_holder').cameras, { wrist: null }, 'an option with no camera says null');
});

test('bare lekiwi offers no gripper it cannot attach', () => {
  const d = load('lekiwi');
  assert.ok(!d.attachments, 'the bare package attaches nothing');
  const ids = d.slots.gripper.options.map((o) => o.id);
  assert.ok(!ids.includes('pincopen'), 'a pincopen option here would resolve to nothing');
  for (const o of d.slots.gripper.options) {
    assert.notEqual(o.kind, 'attachment', `${o.id}: no attachment options without attachments`);
  }
});

test('every camera is the DF200 device; the fitted option poses it', () => {
  for (const p of ['lekiwi', 'lekiwi-pincopen']) {
    for (const cam of load(p).cameras) {
      assert.ok(cam.hfov_deg === 87.3 && cam.vfov_deg === 71.1, `${p}/${cam.id}: lens`);
      assert.match(cam.source.what, /user-confirmed DF200 100° diagonal/);
      assert.equal(cam.local, undefined, `${p}/${cam.id}: the device carries no mount pose`);
    }
  }
});

test('no camera declares an as-installed calibration', () => {
  for (const cam of load('lekiwi-pincopen').cameras) {
    const v = cam.verified;
    if (!v) continue;
    assert.equal(v.droop_deg, null, `${cam.id}: droop must be null until it is measured`);
    assert.equal(v.verified_tilt_deg, null, `${cam.id}: verified_tilt_deg`);
    assert.ok(v.droop_note, `${cam.id}: says why it is unmeasured`);
  }
});

test('lekiwi-pincopen: composition points at packages and parts that exist', () => {
  const d = load('lekiwi-pincopen');
  assert.ok(ids.includes(d.composition.base));
  const base = load(d.composition.base);
  const baseIds = new Set(base.components.map((c) => c.id));
  for (const h of d.composition.hide) assert.ok(baseIds.has(h), `hide: no component ${h}`);
  for (const att of d.attachments) {
    assert.ok(ids.includes(att.package));
    assert.ok(base.frames[att.at], `no frame ${att.at} on ${base.id}`);
    assert.ok(isMat16(att.local));
  }
  for (const pid of Object.keys(d.parts)) {
    assert.ok(existsSync(join(PARTS_DIR, pid, 'part.json')), `no part ${pid}`);
  }
  const slotIds = new Set(Object.keys(d.slots));
  for (const [s, o] of Object.entries(d.default_design)) {
    assert.ok(slotIds.has(s), `default_design names unknown slot ${s}`);
    assert.ok(d.slots[s].options.some((x) => x.id === o), `${s}: no option ${o}`);
  }
});

test('assets/parts: the parts this project ships, and every plate states its bed pose', () => {
  assert.deepEqual(Object.keys(PART_DOCS).sort(),
    ['cam_retainer', 'camera_shims', 'corner_mast_printed', 'df200_arch', 'pi_case_vertical']);
  const d = load('lekiwi-pincopen');
  for (const c of d.components.filter((x) => x.part_of)) {
    if (!c.printable) {
      assert.equal(c.print_file, null, `${c.id}: not printable, so it ships no plate of its own`);
      continue;
    }
    assert.ok(isMat16(c.print_transform), `${c.id}: print_transform`);
    assert.ok(c.print_fit_rmse_mm < 1e-3, `${c.id}: the plate is not this mesh moved (rmse ${c.print_fit_rmse_mm})`);
  }
  /* the print-only kit plates: a part with no slot and no drawn mesh */
  for (const pid of ['cam_retainer', 'camera_shims']) {
    const p = PART_DOCS[pid];
    assert.equal(p.slot, null);
    assert.ok(p.meshes.every((m) => !m.file && m.print), `${pid}: print only`);
    assert.ok(d.parts[pid], `${pid} rides along in the resolved package`);
  }
});

test('lekiwi-pincopen: every part with a slot is a first-class slot option', () => {
  const d = load('lekiwi-pincopen');
  const compIds = new Set(d.components.map((c) => c.id));
  const placed = Object.values(PART_DOCS).filter((p) => p.slot);
  assert.equal(placed.length, 3, 'the two camera mounts and the Pi case');
  for (const p of placed) {
    const slot = d.slots[p.slot];
    const opt = slot.options.find((o) => o.part === p.id);
    assert.ok(opt, `${p.id} is not an option of ${p.slot}`);
    assert.equal(opt.kind, 'parts');
    /* a part in the ROBOT frame stands on the deck and needs nothing of any other slot; one
       in the ATTACHMENT's frame rides it, so it requires it (the arch bolts to PincOpen) */
    if (p.frame === 'robot') assert.ok(!opt.requires, `${p.id}: a deck-mounted part needs nothing`);
    else assert.ok(opt.requires && opt.requires.gripper, `${p.id}: must require its attachment`);
    for (const [cid, block] of Object.entries(p.cameras || {})) {
      assert.equal(JSON.stringify(opt.cameras[cid].local), JSON.stringify(block.local), `${p.id}: ${cid} local`);
      assert.equal(typeof opt.cameras[cid].tilt_deg, 'number', `${p.id}: ${cid} tilt_deg`);
    }
    const fitted = d.default_design[p.slot] === opt.id;
    assert.equal(opt.parts.length, p.meshes.filter((m) => m.file).length, `${p.id}: one component per mesh`);
    for (const id of opt.parts) {
      assert.ok(compIds.has(id), `${p.id}: option part ${id} is not a component`);
      assert.ok(slot.covers.includes(id), `${p.id}: ${id} is not covered by ${p.slot}`);
      const c = d.components.find((x) => x.id === id);
      assert.equal(c.hidden_by_default, !fitted, `${id} must be ${fitted ? 'on' : 'off'} at startup`);
      assert.equal(c.part_of, p.id, `${id}: part_of`);
    }
  }
});
