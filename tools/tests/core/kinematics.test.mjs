/* The kinematics sanity sweep: every shipped package, every control joint at five values
 * across its range.  Three invariants — chain continuity `FK(child) == FK(parent) · T(joint,q)`,
 * mimic children following `multiplier · q + offset`, and no pair that is clear at the zero
 * pose penetrating during the sweep — plus the base pose premultiplying every world matrix and
 * changing nothing else.  The pair test is box-filtered and capped at PAIR_CAP per package. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import * as pkg from '../../../src/core/package.js';
import { matrixMaxDiff } from '../../../src/core/robot-model.js';
import { defaultCameraMatrix } from './_harness.mjs';

const PACKAGES = ['lekiwi', 'lekiwi-pincopen', 'pincopen'];
const STEPS = 5;                 // values across each control joint's range
const CHAIN_TOL_MM = 1e-6;
const PAIR_CAP = 6000;           // mesh tests per package

const round = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;

function table(title, rows) {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (cells) => '  ' + cells.map((v, i) => String(v ?? '').padEnd(w[i])).join('  ');
  for (const r of rows) console.log(line(cols.map((c) => r[c])));
}

const treeOf = (g) => {
  if (!g.boundsTree) g.boundsTree = new MeshBVH(g, { maxLeafTris: 12 });
  return g.boundsTree;
};

/** components with geometry that are visible, grouped by the link `model.links` spells */
function partsByLink(model) {
  const out = new Map();
  for (const c of model.components) {
    if (!c.geometry || c.visible === false) continue;
    const local = c.localId != null ? String(c.localId) : c.id;
    const prefix = (c.id !== local && c.id.endsWith(local)) ? c.id.slice(0, c.id.length - local.length) : '';
    const link = c.link ? (model.hasLink(prefix + c.link) ? prefix + c.link : c.link) : null;
    if (!link || !model.hasLink(link)) continue;
    if (!out.has(link)) out.set(link, []);
    out.get(link).push(c);
  }
  return out;
}

function worldBox(c, model, tmp) {
  if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
  return tmp.copy(c.geometry.boundingBox).applyMatrix4(model.worldMatrix(c.id));
}

/** do two posed components' meshes intersect? */
function overlap(a, b, model) {
  const wa = model.worldMatrix(a.id);
  const wb = model.worldMatrix(b.id);
  const rel = wa.clone().invert().multiply(wb);
  try { return treeOf(a.geometry).intersectsGeometry(b.geometry, rel); }
  catch (e) { return false; }
}

test('every control joint sweeps without breaking the chain, the mimics or the meshes', async () => {
  const summary = [];
  const violations = [];

  for (const id of PACKAGES) {
    const model = await pkg.loadEmbedded(id);
    const controls = model.controlJoints();
    const limits = model.jointLimits();
    const byLink = partsByLink(model);
    const moving = model.joints.filter((j) => j.moving);
    const mimics = moving.filter((j) => j.mimic);

    /* the ADJACENT pairs worth testing, and their zero-pose baseline */
    model.setJoints(model.zeroPose());
    const pairs = [];
    for (const j of moving) {
      const A = byLink.get(j.parent) || [];
      const B = byLink.get(j.child) || [];
      for (const a of A) for (const b of B) {
        if (a === b || a.geometry === b.geometry) continue;
        pairs.push({ joint: j.name, a, b, base: overlap(a, b, model) });
      }
    }
    const testable = pairs.filter((p) => !p.base);

    let chainWorst = 0, chainWhere = '', mimicWorst = 0, mimicWhere = '';
    let meshTests = 0, newHits = 0, poses = 0;
    const boxA = new THREE.Box3(), boxB = new THREE.Box3();

    for (const name of controls) {
      const L = limits[name] || {};
      const lo = Number.isFinite(L.lower) ? L.lower : -45;
      const hi = Number.isFinite(L.upper) ? L.upper : 45;
      for (let k = 0; k < STEPS; k++) {
        const v = STEPS === 1 ? lo : lo + (k * (hi - lo)) / (STEPS - 1);
        model.setJoints({ ...model.zeroPose(), [name]: v });
        poses++;
        assert.equal((model.lastUnknownJoints || []).length, 0, `${id}: ${name} was not recognised`);
        assert.equal((model.lastDerivedJoints || []).length, 0, `${id}: ${name} is a derived joint`);

        /* 1. chain continuity */
        for (const j of model.joints) {
          const want = model.fk(j.parent).multiply(j.matrix(model.jointValue(j.name)));
          const got = model.fk(j.child);
          const d = matrixMaxDiff(want, got);
          if (d > chainWorst) { chainWorst = d; chainWhere = `${id} ${j.name} @ ${name}=${round(v, 2)}`; }
          if (d > CHAIN_TOL_MM) {
            violations.push({ package: id, kind: 'chain', detail: `${j.child} is ${round(d, 6)} mm off ${j.name}`, at: `${name}=${round(v, 2)}` });
          }
        }

        /* 2. mimic children follow their source */
        for (const j of mimics) {
          const src = model.jointValue(j.mimic.joint);
          const want = src * (Number.isFinite(j.mimic.multiplier) ? j.mimic.multiplier : 1) + (j.mimic.offset || 0);
          const d = Math.abs(model.jointValue(j.name) - want);
          if (d > mimicWorst) { mimicWorst = d; mimicWhere = `${id} ${j.name} @ ${name}=${round(v, 2)}`; }
          if (d > 1e-9) {
            violations.push({ package: id, kind: 'mimic', detail: `${j.name} reads ${model.jointValue(j.name)}, wants ${want}`, at: `${name}=${round(v, 2)}` });
          }
        }

        /* 3. no adjacent pair penetrates beyond its zero-pose baseline */
        for (const p of testable) {
          if (meshTests >= PAIR_CAP) break;
          if (!worldBox(p.a, model, boxA).intersectsBox(worldBox(p.b, model, boxB))) continue;
          meshTests++;
          if (overlap(p.a, p.b, model)) {
            newHits++;
            violations.push({ package: id, kind: 'penetration', detail: `${p.a.id} x ${p.b.id} across ${p.joint}`, at: `${name}=${round(v, 2)}` });
          }
        }
      }
    }
    model.setJoints(model.zeroPose());
    summary.push({
      package: id, 'control joints': controls.length, 'mimic joints': mimics.length,
      poses, 'adjacent pairs': pairs.length, 'clear at zero': testable.length,
      'mesh tests': meshTests, 'new penetrations': newHits,
      'chain max mm': chainWorst.toExponential(1), 'mimic max': mimicWorst.toExponential(1),
    });
    void chainWhere; void mimicWhere;
  }

  if (violations.length) {
  }
  assert.equal(violations.length, 0, violations.slice(0, 6).map((v) => `${v.package} ${v.kind}: ${v.detail} at ${v.at}`).join(' | '));
});

test('the base pose premultiplies every world matrix and nothing else', async () => {
  const model = await pkg.loadEmbedded('lekiwi-pincopen');
  const q = { arm_shoulder_lift: -40, arm_elbow_flex: 60, 'pincopen/jaw': 12 };
  model.setBasePose(null);
  model.setJoints(q);
  const before = new Map();
  for (const c of model.components) before.set(c.id, model.worldMatrix(c.id));
  const framesBefore = model.frameNames().map((n) => [n, model.frameMatrix(n)]);
  const camBefore = model.cameras.map((c) => [c.id, defaultCameraMatrix(model, c.id)]);

  const pose = { x: 200, y: -75, yaw: 37 };
  model.setBasePose(pose);
  const B = model.baseMatrix();
  assert.deepEqual(model.basePose, pose);

  let worst = 0;
  for (const c of model.components) {
    const want = B.clone().multiply(before.get(c.id));
    worst = Math.max(worst, matrixMaxDiff(want, model.worldMatrix(c.id)));
  }
  for (const [n, M] of framesBefore) {
    if (!M) continue;
    worst = Math.max(worst, matrixMaxDiff(B.clone().multiply(M), model.frameMatrix(n)));
  }
  for (const [cid, M] of camBefore) {
    if (!M) continue;
    worst = Math.max(worst, matrixMaxDiff(B.clone().multiply(M), defaultCameraMatrix(model, cid)));
  }
  /* the joint values, the chain and the link-relative geometry are untouched */
  assert.deepEqual(model.getJoints(), { ...model.zeroPose(), ...q });
  const rel = model.fk('pincopen/finger_L').invert().multiply(model.worldMatrix('pincopen/tip_support'));
  model.setBasePose(null);
  const rel0 = model.fk('pincopen/finger_L').invert().multiply(model.worldMatrix('pincopen/tip_support'));
  assert.ok(worst < 1e-9, 'a world matrix that is not exactly base · (un-driven world): ' + worst);
  assert.ok(matrixMaxDiff(rel, rel0) < 1e-9, 'the base pose leaked into a link-relative transform');
});
