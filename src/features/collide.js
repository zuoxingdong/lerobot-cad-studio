/* Kinematic plausibility for the arm: real joint limits and collision-blocked motion.
   Not a dynamics engine — it answers three questions fast enough for every slider tick:
   is a joint value inside its travel, does a pose put two bodies through each other, and
   how far along a move can we go first.  Robot frame, mm.  Needs three, three-mesh-bvh. */

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/* The tuning numbers, named once.  Each is a physical claim or a cost ceiling, not a
   preference: the skin is the contact tolerance in mm, the leaf size is what makes a BVH
   build cheap enough for a slider tick, and the caps bound the work per check. */
const SKIN_MM = 0.5;                // contact tolerance
const BVH_LEAF_TRIS = 12;           // three-mesh-bvh maxLeafTris, every build
const MAX_HITS = 24;                // hits collected per check before it stops looking
const TRI_COUNT_CAP = 16;           // triangles counted per hit pair, for the report
const LINK_WALK_GUARD = 64;         // a malformed chain must not walk for ever
const DRIVING_SWING_MIN_MM = 0.5;   // below this a joint is not the one that opens the jaw

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const pairKey = (a, b) => (a < b ? a + '::' + b : b + '::' + a);
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/**
 * Build the collision world once, then call `checkPose` / `clampJoint` per frame.
 *
 * @param {object} o
 * @param {import('../core/robot-model.js').RobotModel} o.model
 * @param {string[]} [o.active]      component ids that participate; default = every
 *                                   component that has geometry and is `visible`
 * @param {string[]} [o.armJoints]   joints that start a new rigid body; default =
 *                                   `kinematics.arm_joint_order`, else every moving joint.
 *                                   `world.armJoints` reports only the SETTABLE ones (a
 *                                   mimic joint moves a body but is not a DOF)
 * @param {object}   [o.limits]      `{joint:[lo,hi]}` degrees; default = the model's
 * @param {number}   [o.skin_mm]     contact tolerance, default SKIN_MM
 */
export function createCollisionWorld(o) {
  const model = o.model;
  if (!model) throw new Error('collide: createCollisionWorld({model}) needs a RobotModel');
  const K = (model.manifest && model.manifest.kinematics) || {};
  const SKIN = o.skin_mm == null ? SKIN_MM : o.skin_mm;
  const movingJoints = model.joints.filter((j) => j.moving).map((j) => j.name);
  /* A MIMIC joint is derived — `q_child = k·q_source + offset` — so it is not a degree of
     freedom: nothing may set it, `clampJoint` must never bisect on it and IK must never
     solve for it.  It still MOVES its child link, so it still starts a rigid body.  The
     two lists are therefore different, and conflating them is what let `clampJoint` be
     asked to move `jaw_finger_L` (a joint the model refuses) on any package that declares
     no `arm_joint_order`.  An explicit order that names a mimic joint is filtered too. */
  const settableJoints = model.joints.filter((j) => j.settable).map((j) => j.name);
  const BODY_JOINTS = (o.armJoints || K.arm_joint_order || movingJoints).filter((n) => movingJoints.includes(n));
  const ARM = BODY_JOINTS.filter((n) => settableJoints.includes(n));

  /* ---- rigid bodies: every fixed joint collapses; each ARM joint starts one -- */
  const bodyOf = Object.create(null);
  const jointOfBody = Object.create(null);
  const rootByPrefix = new Map();    // 'pincopen/' -> 'pincopen/body', for frame:"robot" parts
  {
    const info = new Map();          // link -> parentJoint
    for (const j of model.joints) info.set(j.child, j);
    /* An ATTACHMENT is bolted to the frame it hangs on, so its root link is rigidly part of
       that frame's link — nothing joins them, which is why the walk below would otherwise
       stop at the attachment's root and put the whole gripper in body 0, the world.  The
       arm then reads its own gripper as an obstacle: `Wrist_Roll × pincopen/tip_support`
       fires the moment the jaw opens, and the pick routine refuses to reach. */
    const bolted = new Map();        // attached root link -> the host link it is bolted to
    (function walk(m, prefix) {
      for (const a of (m && m.attachments) || []) {
        if (!a || !a.model) continue;
        const p = prefix + a.id + '/';
        rootByPrefix.set(p, p + a.model.rootLink);
        const slash = String(a.frame || '').indexOf('/');
        const host = slash < 0 ? m : ((m.attachments.find((x) => x.id === a.frame.slice(0, slash)) || {}).model);
        const fname = slash < 0 ? a.frame : a.frame.slice(slash + 1);
        const spec = (((host && host.manifest && host.manifest.frames) || {})[fname]) || {};
        if (spec.link) {
          bolted.set(p + a.model.rootLink,
                     prefix + (slash < 0 ? spec.link : a.frame.slice(0, slash) + '/' + spec.link));
        }
        walk(a.model, p);
      }
    })(model, '');
    const bodyFor = (link, guard = 0) => {
      if (link == null || guard > LINK_WALK_GUARD) return 0;
      if (bodyOf[link] !== undefined) return bodyOf[link];
      const j = info.get(link);
      if (!j) {
        const host = bolted.get(link);
        return (bodyOf[link] = host ? bodyFor(host, guard + 1) : 0);
      }
      const k = BODY_JOINTS.indexOf(j.name);
      const b = k >= 0 ? k + 1 : bodyFor(j.parent, guard + 1);
      if (k >= 0) jointOfBody[k + 1] = j.name;
      return (bodyOf[link] = b);
    };
    for (const l of model.links) bodyFor(l);
  }

  /* parts */
  const parts = new Map();
  const bvhCache = new Map();       // geometry uuid -> {bvh, geom, box, tris}

  function bvhFor(geometry) {
    const key = geometry.uuid;
    let e = bvhCache.get(key);
    if (!e) {
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      if (!geometry.boundsTree) geometry.boundsTree = new MeshBVH(geometry, { maxLeafTris: BVH_LEAF_TRIS });
      const n = geometry.index ? geometry.index.count : geometry.attributes.position.count;
      e = { bvh: geometry.boundsTree, geom: geometry, box: geometry.boundingBox.clone(), tris: n / 3 };
      bvhCache.set(key, e);
    }
    return e;
  }

  /**
   * The link name as `model.links` spells it.
   *
   * `_flatten()` prefixes an attached component's `id` but deliberately NOT its `link` —
   * `worldMatrix` resolves that one through the owner — so an attached gripper's parts say
   * `finger_L` while the flattened chain says `pincopen/finger_L`.  Looking the raw name up
   * in `bodyOf` silently missed, every attached part fell into body 0 (the world), and the
   * arm collided with its own gripper the moment the jaw moved.
   */
  function linkKey(c) {
    const local = c.localId != null ? String(c.localId) : c.id;
    const prefix = (c.id !== local && c.id.endsWith(local)) ? c.id.slice(0, c.id.length - local.length) : '';
    /* frame:"robot" inside an attached package means "baked in THAT package's robot frame",
       which is its root link — not the host robot's world. */
    if (!c.link) return prefix ? (rootByPrefix.get(prefix) || null) : null;
    const qualified = prefix + c.link;
    return bodyOf[qualified] !== undefined ? qualified : c.link;
  }

  function addComponent(c) {
    const link = linkKey(c);
    const body = link != null && bodyOf[link] !== undefined ? bodyOf[link] : 0;
    const rec = {
      id: c.id, kind: body >= 1 ? 'arm' : 'static', source: 'component',
      link, body, component: c,
      world: new THREE.Matrix4(), inv: new THREE.Matrix4(), box: new THREE.Box3(),
      geom: null, bvh: null, localBox: null, tris: 0,
      label: c.label || c.id, group: c.group, active: false,
    };
    parts.set(c.id, rec);
    return rec;
  }
  for (const c of model.components) if (c.geometry) addComponent(c);

  function ensureGeom(rec) {
    if (rec.bvh) return rec;
    const e = rec.source === 'component' ? bvhFor(rec.component.geometry) : rec._e;
    rec.bvh = e.bvh; rec.geom = e.geom; rec.localBox = e.box; rec.tris = e.tris;
    return rec;
  }

  const DEFAULT_ACTIVE = model.components.filter((c) => c.geometry && c.visible !== false).map((c) => c.id);

  let armList = [], staticList = [], dirtyIndex = true;
  function rebuildIndex() { dirtyIndex = true; lastKey = null; }
  function setActive(ids) {
    for (const r of parts.values()) if (r.source === 'component') r.active = false;
    for (const id of ids || []) { const r = parts.get(id); if (r) r.active = true; }
    rebuildIndex();
  }
  function index() {
    if (!dirtyIndex) return;
    armList = []; staticList = [];
    for (const r of parts.values()) {
      if (!r.active) continue;
      ensureGeom(r);
      (r.kind === 'arm' ? armList : staticList).push(r);
    }
    dirtyIndex = false;
  }

  /* extra pairs that adjacency hides but that physically matter */
  const extraPairs = [];
  {
    /* the last arm body against every body two or more steps up the chain that a
       gripper closes onto: adjacency would skip parent/child, but the closing
       jaw really can hit its own bracket */
    const jawJoint = BODY_JOINTS[BODY_JOINTS.length - 1];
    const jawBody = BODY_JOINTS.length;
    const jawParts = [...parts.values()].filter((r) => r.body === jawBody);
    const braceParts = [...parts.values()].filter((r) => r.body === jawBody - 1);
    for (const a of jawParts) for (const b of braceParts) extraPairs.push([a.id, b.id, jawJoint]);
  }

  /* ---- ignore list: whatever already touches at the zero pose is an artifact */
  let baseline = null;
  function baselinePairs() {
    if (baseline) return baseline;
    /* It is built LAZILY, from inside `testPairs`, which `rawCheck` reaches only AFTER it
       has posed the world — and building it poses everything at the zero pose.  Without
       putting the caller's pose back, the very first mesh test on a fresh world is
       silently answered at the ZERO POSE instead of the one that was asked for. */
    const keep = lastPose;
    baseline = new Set();
    const r = rawCheck(model.zeroPose(), { ignoreBaseline: false, count: false, maxHits: 1e6 });
    for (const h of r.hits) baseline.add(pairKey(h.a, h.b));
    if (keep) applyPose(keep);
    return baseline;
  }

  /* joint limits */
  const modelLimits = model.jointLimits();
  const limits = Object.create(null);
  for (const [name, L] of Object.entries(modelLimits)) {
    if (L && Number.isFinite(L.lower) && Number.isFinite(L.upper)) limits[name] = [L.lower, L.upper];
  }
  Object.assign(limits, o.limits || {});
  function limitsOf(joint) { return limits[joint] || null; }
  function clampToLimits(qDeg) {
    const out = Object.assign({}, qDeg);
    for (const j of Object.keys(out)) { const L = limits[j]; if (L) out[j] = clamp(out[j], L[0], L[1]); }
    return out;
  }
  function outOfLimits(qDeg) {
    const bad = [];
    for (const j of Object.keys(qDeg || {})) {
      const L = limits[j], v = qDeg[j];
      if (L && v != null && (v < L[0] - 1e-9 || v > L[1] + 1e-9)) bad.push({ joint: j, value: v, limit: L });
    }
    return bad;
  }

  /* posing */
  let lastKey = null;
  let lastPose = null;               // the qDeg the part matrices currently stand for
  const keepPose = () => model.getJoints();
  function poseKey(qDeg) {
    /* the base pose and every part's `local` (Move placements, hinge turns) are part of the
       pose too, or a moved part would be measured where it stood before */
    let s = (model.baseStamp || 0) + '|' + localSig() + '|';
    for (const j of movingJoints) s += (qDeg[j] || 0).toFixed(4) + ',';
    return s;
  }
  function localSig() {
    let h = 0;
    for (const r of [...armList, ...staticList]) {
      const L = r.source === 'component' && r.component && r.component.local;
      if (!L) continue;
      const e = L.elements;
      for (let i = 0; i < 16; i++) h = (h * 1.0000031 + e[i] * (i + 1)) % 1e12;
    }
    return h.toFixed(6);
  }
  function applyPose(qDeg) {
    const q = Object.assign({}, model.zeroPose(), qDeg || {});
    const key = poseKey(q);
    if (key === lastKey) return;
    lastKey = key;
    lastPose = q;
    index();
    const keep = keepPose();
    model.setJoints(q);
    for (const r of [...armList, ...staticList]) {
      if (r.source === 'dynamic') dynamicWorld(r);
      else r.world.copy(model.worldMatrix(r.id));
      r.inv.copy(r.world).invert();
      r.box.copy(r.localBox).applyMatrix4(r.world);
    }
    model.setJoints(keep);
  }

  /**
   * Where a dynamic part sits at the pose the model is CURRENTLY set to.
   *
   * With a link, `base` is the part's transform IN THAT LINK'S FRAME and the world matrix
   * is `FK(link) · base`; without one, `base` IS the world matrix, as before.
   */
  function dynamicWorld(r) {
    if (r.link && model.hasLink && model.hasLink(r.link)) {
      try { r.world.multiplyMatrices(model.fk(r.link), r.base); }
      catch (e) { r.world.copy(r.base); }
    } else if (r.frame === 'robot') {
      /* bolted to the robot, in the ROBOT frame — it drives away with it */
      try { r.world.multiplyMatrices(model.baseMatrix(), r.base); }
      catch (e) { r.world.copy(r.base); }
    } else {
      /* a free body: `base` IS the world matrix, and it stays where it was put while the
         robot drives past it (a ball on the floor) */
      r.world.copy(r.base);
    }
    r.inv.copy(r.world).invert();
    if (r.localBox) r.box.copy(r.localBox).applyMatrix4(r.world);
    return r.world;
  }

  /* narrow phase */
  const _rel = new THREE.Matrix4();
  function relMatrix(a, b) { return _rel.multiplyMatrices(a.inv, b.world); }

  function triCount(a, b, cap) {
    let n = 0;
    try {
      a.bvh.bvhcast(b.bvh, relMatrix(a, b), { intersectsTriangles() { n++; return n >= cap; } });
    } catch (e) { n = n || 1; }
    return n;
  }

  function pairHit(a, b, opt) {
    const skin = opt.skin == null ? SKIN : opt.skin;
    const ea = skin * 0.5;
    if (a.box.max.x + ea < b.box.min.x - ea || b.box.max.x + ea < a.box.min.x - ea) return null;
    if (a.box.max.y + ea < b.box.min.y - ea || b.box.max.y + ea < a.box.min.y - ea) return null;
    if (a.box.max.z + ea < b.box.min.z - ea || b.box.max.z + ea < a.box.min.z - ea) return null;
    if (a.bvh.intersectsGeometry(b.geom, relMatrix(a, b))) {
      return { a: a.id, b: b.id, count: opt.count ? triCount(a, b, opt.cap || TRI_COUNT_CAP) : 1, gap: 0 };
    }
    if (skin > 0 && opt.clearance) {
      const t1 = {}, t2 = {};
      a.bvh.closestPointToGeometry(b.geom, relMatrix(a, b), t1, t2, 0, skin);
      if (t1.distance != null && t1.distance <= skin) return { a: a.id, b: b.id, count: 0, gap: t1.distance };
    }
    return null;
  }

  function testPairs(opt, hits) {
    const skipBase = opt.ignoreBaseline === false ? null : baselinePairs();
    const maxHits = opt.firstOnly ? 1 : (opt.maxHits == null ? MAX_HITS : opt.maxHits);
    const skipId = opt.ignore && opt.ignore.length ? new Set(opt.ignore) : null;
    for (const A of armList) {
      if (skipId && skipId.has(A.id)) continue;
      for (const B of staticList) {
        if (skipId && skipId.has(B.id)) continue;
        if (Math.abs(A.body - B.body) <= 1) continue;
        if (skipBase && skipBase.has(pairKey(A.id, B.id))) continue;
        const h = pairHit(A, B, opt);
        if (h) { hits.push(h); if (hits.length >= maxHits) return hits; }
      }
    }
    for (let i = 0; i < armList.length; i++) {
      for (let j = i + 1; j < armList.length; j++) {
        const A = armList[i], B = armList[j];
        if (skipId && (skipId.has(A.id) || skipId.has(B.id))) continue;
        if (Math.abs(A.body - B.body) <= 1) continue;
        if (skipBase && skipBase.has(pairKey(A.id, B.id))) continue;
        const h = pairHit(A, B, opt);
        if (h) { hits.push(h); if (hits.length >= maxHits) return hits; }
      }
    }
    for (const [ia, ib] of extraPairs) {
      const A = parts.get(ia), B = parts.get(ib);
      if (!A || !B || !A.active || !B.active) continue;
      if (skipId && (skipId.has(A.id) || skipId.has(B.id))) continue;
      if (skipBase && skipBase.has(pairKey(A.id, B.id))) continue;
      const h = pairHit(A, B, opt);
      if (h) { hits.push(h); if (hits.length >= maxHits) return hits; }
    }
    return hits;
  }

  function rawCheck(qDeg, opt) {
    index();
    applyPose(qDeg || {});
    const hits = [];
    testPairs(opt || {}, hits);
    return { hits };
  }

  /* public API */

  /**
   * Test one pose.
   * @param {Object<string,number>} qDeg joint name -> degrees (missing = zero pose)
   * @param {object} [opt] firstOnly · count · maxHits (MAX_HITS) · skin · clearance ·
   *                       ignore:[ids] · limits:false · ignoreBaseline:false
   * @returns {{ok, hits:[{a,b,count,gap}], limitHits, ms}}
   */
  function checkPose(qDeg, opt) {
    opt = opt || {};
    const t0 = now();
    const r = rawCheck(qDeg, opt);
    const limitHits = opt.limits === false ? [] : outOfLimits(qDeg || {});
    return { ok: r.hits.length === 0 && limitHits.length === 0, hits: r.hits, limitHits, ms: now() - t0 };
  }

  /**
   * Largest motion of one joint towards `target` that stays legal: limits first,
   * then a bisection on the collision test.
   * `opt.steps` (default 6) bisection probes -> a resolution of |target-cur|/2^6;
   * `opt.names:false` skips the extra pass that names every offender.
   * @returns {{q, blockedBy, limited, blocked, steps}}
   */
  function clampJoint(qDeg, jointName, target, opt) {
    opt = opt || {};
    const steps = opt.steps == null ? 6 : opt.steps;
    const probe = Object.assign({}, qDeg);
    const cur = probe[jointName] || 0;
    const L = limits[jointName];
    let limited = false;
    let want = target;
    if (L) { const c = clamp(want, L[0], L[1]); limited = Math.abs(c - want) > 1e-9; want = c; }
    if (opt.physics === false) return { q: want, blockedBy: [], limited, blocked: false, steps: 0 };

    const test = (v) => { probe[jointName] = v; return rawCheck(probe, { firstOnly: true, count: false, skin: opt.skin }); };
    let r = test(want);
    if (r.hits.length === 0) return { q: want, blockedBy: [], limited, blocked: false, steps: 1 };

    const r0 = test(cur);
    if (r0.hits.length) return { q: cur, blockedBy: r0.hits, limited, blocked: true, steps: 2 };

    let lo = cur, hi = want, blockedBy = r.hits, n = 2;
    for (let i = 0; i < steps; i++) {
      const mid = (lo + hi) / 2;
      const m = test(mid); n++;
      if (m.hits.length) { hi = mid; blockedBy = m.hits; } else lo = mid;
    }
    if (opt.names === false) return { q: lo, blockedBy, limited, blocked: true, steps: n };
    /* one more pass at the blocked side so the hint can name every offender
       (~4 ms); pass `{names:false}` to skip it while jogging */
    probe[jointName] = hi;
    const full = rawCheck(probe, { count: false, maxHits: 4 });
    return { q: lo, blockedBy: full.hits.length ? full.hits : blockedBy, limited, blocked: true, steps: n + 1 };
  }

  /** Where a joint first becomes blocked when swept from `from` to `to`. */
  function sweepJoint(qDeg, jointName, from, to, step) {
    const probe = Object.assign({}, qDeg);
    const dir = to >= from ? 1 : -1;
    const dq = Math.abs(step || 1) * dir;
    let n = 0;
    for (let v = from; dir > 0 ? v <= to + 1e-9 : v >= to - 1e-9; v += dq) {
      probe[jointName] = v; n++;
      const r = rawCheck(probe, { firstOnly: true, count: false });
      if (r.hits.length) {
        const full = rawCheck(probe, { count: true });
        return { blockedAt: v, hits: full.hits, scanned: n };
      }
    }
    return { blockedAt: null, hits: [], scanned: n };
  }

  /**
   * One part at an arbitrary world matrix — gizmo drags, imported meshes,
   * placement helpers.  `features/placement.js` wraps this.
   *
   * `opt.pose` is the joint map THE REST OF THE ROBOT should stand in while the test
   * runs, and the world's previous pose is restored afterwards.  WITHOUT it the answer
   * is measured against whatever pose was applied last — before the first `checkPose`
   * every `part.world` is the identity and a part that really touches four others
   * reports "clear"; after `physicsOf()` has run its preset loop it is measured against
   * the last preset instead of the design.  Always pass `{pose: design.joints}`.
   */
  function checkTransform(partId, matrix, others, opt) {
    opt = opt || {};
    index();
    const A = parts.get(partId);
    if (!A) return { ok: true, hits: [] };

    const restore = opt.pose ? lastPose : null;
    if (opt.pose) applyPose(opt.pose);
    else if (lastKey === null) applyPose(model.getJoints());   // never measure against identity

    ensureGeom(A);
    const keepW = A.world.clone(), keepI = A.inv.clone(), keepB = A.box.clone();
    A.world.copy(matrix); A.inv.copy(matrix).invert(); A.box.copy(A.localBox).applyMatrix4(A.world);
    const list = others && others.length ? others.map((id) => parts.get(id)).filter(Boolean)
      : [...armList, ...staticList].filter((r) => r !== A);
    const hits = [];
    try {
      for (const B of list) {
        if (B === A) continue;
        ensureGeom(B);
        const h = pairHit(A, B, opt);
        if (h) { hits.push(h); if (opt.firstOnly) break; }
      }
    } finally {
      A.world.copy(keepW); A.inv.copy(keepI); A.box.copy(keepB);
      if (restore) applyPose(restore);
    }
    return { ok: hits.length === 0, hits };
  }

  /**
   * THE ROBOT AGAINST THE FREE BODIES IN THE WORLD — the question a base move has to ask.
   *
   * `checkPose` only ever tests the ARM: a pair of static parts never moves relative to
   * each other, so testing them is wasted work.  A prop on the floor is static too, and
   * the chassis is static, so driving the base into a ball was invisible to every check
   * the studio had.  With the base pose inside the model (`setBasePose`) the chassis DOES
   * move, and this is the test that sees it: every active part of the robot against every
   * dynamic body that is not parented to a link (props, unparented imports).
   *
   * @param {object} [qDeg] the joint pose to stand in (default: the current one)
   * @param {object} [opt] `firstOnly` · `skin` · `ignore:[ids]`
   * @returns {{ok, hits:[{a,b,count,gap}]}}
   */
  function checkWorld(qDeg, opt) {
    opt = opt || {};
    index();
    applyPose(qDeg || lastPose || model.getJoints());
    const free = [...parts.values()].filter((r) => r.active && r.source === 'dynamic' && !r.link);
    const hits = [];
    if (!free.length) return { ok: true, hits };
    const skipId = opt.ignore && opt.ignore.length ? new Set(opt.ignore) : null;
    for (const F of free) {
      if (skipId && skipId.has(F.id)) continue;
      ensureGeom(F);
      for (const R of [...armList, ...staticList]) {
        if (R === F || R.source === 'dynamic') continue;
        if (skipId && skipId.has(R.id)) continue;
        ensureGeom(R);
        const h = pairHit(R, F, opt);
        if (h) { hits.push(h); if (opt.firstOnly) return { ok: false, hits }; }
      }
    }
    return { ok: hits.length === 0, hits };
  }

  /**
   * Register an imported STL, a parametric preview mesh, or a prop.
   * @param {object} [meta] `{kind:'static'|'arm', link, frame, label, group}` —
   *                        `link` makes it ride that link; `frame:'robot'` (with no link)
   *                        makes it ride the DRIVEN BASE, which is what a `frame:"robot"`
   *                        component means.  The default, `'world'`, is a free body.
   */
  function addDynamic(id, geometry, matrix, meta) {
    meta = meta || {};
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundsTree) geometry.boundsTree = new MeshBVH(geometry, { maxLeafTris: BVH_LEAF_TRIS });
    const link = meta.link || null;
    const body = link != null && bodyOf[link] !== undefined ? bodyOf[link] : -1;
    const rec = {
      id, kind: meta.kind || (body >= 1 ? 'arm' : 'static'), source: 'dynamic',
      link, body, frame: meta.frame === 'robot' ? 'robot' : 'world',
      base: matrix ? matrix.clone() : new THREE.Matrix4(),
      world: new THREE.Matrix4(), inv: new THREE.Matrix4(), box: new THREE.Box3(),
      label: meta.label || id, group: meta.group || 'dynamic', active: true,
      _e: { bvh: geometry.boundsTree, geom: geometry, box: geometry.boundingBox.clone(),
            tris: (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3 },
    };
    ensureGeom(rec);
    dynamicWorld(rec);
    parts.set(id, rec);
    lastKey = null;
    rebuildIndex();
    return rec;
  }
  /**
   * Move a dynamic part.  `matrix` is in the part's PARENT frame — the link's when it has
   * one, the robot frame otherwise.  Pass `meta.link` to reparent it in the same call
   * (`null` detaches it back to the robot frame); the body index follows.
   */
  function setDynamicMatrix(id, matrix, meta) {
    const r = parts.get(id);
    if (!r) return false;
    if (meta && 'frame' in meta) r.frame = meta.frame === 'robot' ? 'robot' : 'world';
    if (meta && 'link' in meta) {
      r.link = meta.link || null;
      r.body = r.link != null && bodyOf[r.link] !== undefined ? bodyOf[r.link] : -1;
      r.kind = (meta.kind || (r.body >= 1 ? 'arm' : 'static'));
      rebuildIndex();
    }
    if (matrix) r.base.copy(matrix);
    dynamicWorld(r);
    lastKey = null;
    return true;
  }

  /**
   * Point a part at a NEW BufferGeometry — a parametric rebuild, a tweaked mesh, a
   * re-imported STL.  The BVH is cached by `geometry.uuid` and `ensureGeom` early-returns
   * once `rec.bvh` is set, so without this the collision world keeps testing the
   * PRE-TWEAK silhouette for ever however far the slider is dragged.
   *
   * Call it straight after `component.geometry = …`.  With `geometry` omitted it re-reads
   * whatever the component now carries (`refreshGeometry(id)` is that spelling).
   *
   * @param {string} id
   * @param {object} [geometry] THREE.BufferGeometry
   * @returns {boolean} false when `id` is not a part of this world
   */
  function updateDynamic(id, geometry) {
    const rec = parts.get(id);
    if (!rec) return false;
    const next = geometry || (rec.source === 'component' ? rec.component && rec.component.geometry : (rec._e && rec._e.geom));

    /* forget the old entry, or `bvhFor` hands the stale tree straight back */
    if (rec.geom && rec.geom !== next) bvhCache.delete(rec.geom.uuid);
    rec.bvh = null; rec.geom = null; rec.localBox = null; rec.tris = 0;

    if (next) {
      if (!next.boundingBox) next.computeBoundingBox();
      if (!next.boundsTree) next.boundsTree = new MeshBVH(next, { maxLeafTris: BVH_LEAF_TRIS });
      const e = {
        bvh: next.boundsTree, geom: next, box: next.boundingBox.clone(),
        tris: (next.index ? next.index.count : next.attributes.position.count) / 3,
      };
      if (rec.source === 'component') { bvhCache.set(next.uuid, e); rec.component.geometry = next; }
      else rec._e = e;
      ensureGeom(rec);
      if (rec.source === 'dynamic') dynamicWorld(rec);
      else rec.box.copy(rec.localBox).applyMatrix4(rec.world);
    } else if (rec.source === 'dynamic') {
      rec._e = null;
    }

    /* the silhouette changed, so the pose cache, the index and the zero-pose ignore list
       are all stale */
    lastKey = null; lastPose = null;
    if (_tips && (_tips.jawId === id || _tips.fixId === id)) _tips = null;
    baseline = null;
    rebuildIndex();
    return true;
  }

  /** `updateDynamic(id)` — re-read the component's current geometry. */
  function refreshGeometry(id) { return updateDynamic(id); }

  function remove(id) { const ok = parts.delete(id); rebuildIndex(); return ok; }

  function worldMatrix(id) { index(); const r = parts.get(id); return r ? r.world.clone() : null; }
  function worldBox(id) { index(); const r = parts.get(id); return r ? r.box.clone() : null; }

  /** every (a, b) pair `checkPose` really tests, after adjacency and the ignore list. */
  function testedPairs(opt) {
    index();
    const skipBase = (opt && opt.ignoreBaseline === false) ? null : baselinePairs();
    const out = [];
    const push = (A, B, why) => {
      if (skipBase && skipBase.has(pairKey(A.id, B.id))) return;
      out.push([A.id, B.id, why]);
    };
    for (const A of armList) for (const B of staticList) {
      if (Math.abs(A.body - B.body) <= 1) continue;
      push(A, B, 'arm-static');
    }
    for (let i = 0; i < armList.length; i++) for (let j = i + 1; j < armList.length; j++) {
      if (Math.abs(armList[i].body - armList[j].body) <= 1) continue;
      push(armList[i], armList[j], 'arm-arm');
    }
    for (const [ia, ib] of extraPairs) {
      const A = parts.get(ia), B = parts.get(ib);
      if (A && B && A.active && B.active) push(A, B, 'jaw');
    }
    return out;
  }

  function stats() {
    index();
    let tris = 0;
    for (const e of bvhCache.values()) tris += e.tris;
    return {
      parts: parts.size, active: armList.length + staticList.length,
      arm: armList.length, static: staticList.length,
      meshes: bvhCache.size, storedTriangles: Math.round(tris),
      bodies: Math.max(0, ...Object.values(bodyOf)) + 1,
      pairs: testedPairs().length,
    };
  }

  /* ---- gripper opening
     THE TWO PADS, FROM THE PACKAGE.  The fingertip slot names the components that carry
     the contact pads and its `anchor` frame IS the contact point, so at the CLOSED pose
     the two pads coincide and the opening reads 0.  Carrying ONE closed-pose world point
     on BOTH links is what makes that true for a single-sided jaw as well (the stock
     SO-101 `Moving_Jaw_08d-v1` against the fixed finger on `Wrist_Roll_08c-v1`): whatever
     the meshes do near the hinge, the opening AT THE CONTACT POINT is exactly the relative
     motion of the two links there.

     The rule this replaces took the two deepest bodies and, in each, the vertex farthest
     from the other's origin — a CHORD across the whole gripper.  With the stock jaw SHUT
     it read 91.6 mm, and the grasp test therefore never believed anything was held.

     A mesh test still cannot find the closing STOP of a jaw that pivots inside its own
     bracket; that stop is the joint limit.  This is the gap, which is what a grasp test
     needs.                                                                             */
  let _tips = null;

  /** Slots that could name the fingertip pads — this package's, then every attachment's. */
  function padSlots() {
    const out = [];
    (function walk(m, prefix) {
      const sl = (m.manifest && m.manifest.slots) || {};
      for (const [id, sp] of Object.entries(sl)) {
        if (!sp || !Array.isArray(sp.covers) || !sp.covers.length || !sp.anchor) continue;
        const score = (sp.mirrored ? 2 : 0) + (/finger|tip|jaw|grip/i.test(id) ? 1 : 0);
        if (score > 0) out.push({ id, spec: sp, prefix, score });
      }
      for (const a of (m.attachments || [])) walk(a.model, prefix + a.id + '/');
    })(model, '');
    return out.sort((a, b) => b.score - a.score);
  }

  /** The active parts a slot covers, grouped by link — the mirror pair, when there is one. */
  function padPartsOf(sel) {
    const byLink = new Map();
    for (const id of sel.spec.covers) {
      const r = parts.get(sel.prefix + id) || parts.get(id);
      if (!r || !r.active || !r.link) continue;
      if (!byLink.has(r.link)) byLink.set(r.link, r);
    }
    return [...byLink.values()];
  }

  /**
   * The joint that really opens this pair, and the end of its travel that SHUTS it.
   * Measured, not assumed: the joint whose two limits move the two parts' centres apart
   * the most is the one that opens them.  An arm joint moves BOTH equally, so it scores 0.
   */
  function drivingJoint(A, B) {
    ensureGeom(A); ensureGeom(B);
    const centre = (r) => new THREE.Vector3(
      (r.box.min.x + r.box.max.x) / 2, (r.box.min.y + r.box.max.y) / 2, (r.box.min.z + r.box.max.z) / 2);
    const keep = lastPose ? { ...lastPose } : model.getJoints();
    let best = null;
    for (const name of settableJoints) {
      const L = limits[name];
      if (!L || !Number.isFinite(L[0]) || !Number.isFinite(L[1]) || L[1] - L[0] < 1e-9) continue;
      const sep = [];
      for (const v of L) { applyPose({ ...keep, [name]: v }); sep.push(centre(A).distanceTo(centre(B))); }
      const swing = Math.abs(sep[1] - sep[0]);
      if (!best || swing > best.swing) best = { name, swing, closed: sep[0] <= sep[1] ? L[0] : L[1] };
    }
    applyPose(keep);
    return best && best.swing > DRIVING_SWING_MIN_MM ? best : null;
  }

  /** the vertex of `rec` farthest from the hinge AXIS of `jointName` (the fingertip) */
  function tipVertex(rec, jointName, fallbackTo) {
    ensureGeom(rec);
    let hinge = null, axis = null;
    const j = jointName ? model.joint(jointName) : null;
    if (j) {
      try {
        const M = model.fk(j.parent).multiply(j.matrix(0));
        hinge = new THREE.Vector3().setFromMatrixPosition(M);
        axis = new THREE.Vector3(j.axis[0], j.axis[1], j.axis[2]).transformDirection(M).normalize();
      } catch (e) { hinge = null; }
    }
    if (!hinge) { hinge = new THREE.Vector3().setFromMatrixPosition(fallbackTo.world); axis = null; }
    const pos = rec.geom.attributes.position.array;
    const v = new THREE.Vector3(), d = new THREE.Vector3(), best = new THREE.Vector3();
    let bd = -1;
    for (let i = 0; i < pos.length; i += 3) {
      v.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(rec.world);
      d.subVectors(v, hinge);
      if (axis) d.addScaledVector(axis, -d.dot(axis));
      const len = d.length();
      if (len > bd) { bd = len; best.copy(v); }
    }
    return best;
  }

  /**
   * Resolve the pad pair once: which two parts, the joint that opens them, the pose that
   * shuts them, and the contact point expressed in EACH part's own frame.
   */
  function tips(opt = {}) {
    if (_tips && !opt.force) return _tips;
    index();
    const a = opt.a || o.tipA, b = opt.b || o.tipB;
    let A = a ? parts.get(a) : null, B = b ? parts.get(b) : null;
    let source = A && B ? 'caller' : null;
    let sel = null;

    if (!A || !B) {
      for (const cand of padSlots()) {
        const list = padPartsOf(cand);
        if (list.length < 2) continue;
        A = A || list[0];
        B = B || list.find((r) => r !== A);
        sel = cand;
        source = `slot ${cand.prefix}${cand.id}`;
        break;
      }
    }
    if (!A || !B) {
      /* no fingertip slot: the deepest body that carries geometry, against the one before
         it — the single-sided jaw and its bracket */
      const last = Math.max(0, ...[...parts.values()].filter((r) => r.active).map((r) => r.body));
      const cand = [...parts.values()].filter((r) => r.active && r.body >= last - 1);
      if (cand.length < 2) return (_tips = { ok: false });
      A = A || cand.find((r) => r.body === last) || cand[0];
      B = B || cand.find((r) => r !== A && r.body === last - 1) || cand.find((r) => r !== A);
      source = source || 'deepest bodies';
    }
    if (!A || !B) return (_tips = { ok: false });
    ensureGeom(A); ensureGeom(B);

    const drive = drivingJoint(A, B);
    const closedQ = Object.assign({}, model.zeroPose());
    if (drive) closedQ[drive.name] = drive.closed;
    applyPose(closedQ);

    /* the contact point: the slot's anchor frame when the package declares one, else the
       fingertip of the moving part */
    const keepQ = model.getJoints();
    model.setJoints(closedQ);
    let P = null;
    if (sel) {
      try {
        const M = model.frameMatrix(sel.prefix + sel.spec.anchor);
        if (M) P = new THREE.Vector3().setFromMatrixPosition(M);
      } catch (e) { P = null; }
    }
    if (!P) { P = tipVertex(A, drive && drive.name, B); source += ' · tip vertex'; }
    model.setJoints(keepQ);

    _tips = {
      ok: true, jawId: A.id, fixId: B.id, jawLink: A.link || null, fixLink: B.link || null,
      jaw: P.clone().applyMatrix4(A.world.clone().invert()),
      fix: P.clone().applyMatrix4(B.world.clone().invert()),
      hinge: P.clone(), contact: P.clone(),
      joint: drive ? drive.name : null, closedAt: drive ? drive.closed : null,
      source,
    };
    return _tips;
  }

  /** Distance between the two pad points at this pose, in mm — 0 when the jaw is shut. */
  function gripOpening(qDeg) {
    const t = tips();
    if (!t.ok) return null;
    applyPose(qDeg || {});
    const a = t.jaw.clone().applyMatrix4(parts.get(t.jawId).world);
    const b = t.fix.clone().applyMatrix4(parts.get(t.fixId).world);
    return a.distanceTo(b);
  }
  /** world-frame positions of the two pads (robot mm). */
  function gripTips(qDeg) {
    const t = tips();
    if (!t.ok) return null;
    applyPose(qDeg || {});
    const moving = t.jaw.clone().applyMatrix4(parts.get(t.jawId).world);
    const fixed = t.fix.clone().applyMatrix4(parts.get(t.fixId).world);
    return {
      moving, fixed, hinge: t.hinge.clone(),
      centre: moving.clone().add(fixed).multiplyScalar(0.5),
      gap: moving.distanceTo(fixed),
      joint: t.joint, source: t.source,
      movingId: t.jawId, fixedId: t.fixId, movingLink: t.jawLink, fixedLink: t.fixLink,
    };
  }
  /** name the two components used as finger tips (so a UI can say so). */
  function setTips(aId, bId) { _tips = null; tips({ a: aId, b: bId, force: true }); return _tips; }

  const world = {
    model,
    checkPose, checkWorld, clampJoint, sweepJoint, checkTransform, addDynamic, setDynamicMatrix, remove,
    updateDynamic, refreshGeometry,
    /** pose every part for `q` (robot mm matrices); `checkTransform({pose})` does this for you */
    applyPose: (q) => { index(); applyPose(q || {}); return world; },
    /** the pose the part matrices currently stand for, or null */
    currentPose: () => (lastPose ? { ...lastPose } : null),
    setActive, limitsOf, clampToLimits, outOfLimits, worldMatrix, worldBox, stats, testedPairs,
    gripOpening, gripTips, setTips, baselinePairs, bodyOf, parts, limits,
    armJoints: ARM, bodyJoints: BODY_JOINTS, settableJoints, movingJoints, extraPairs,
    label: (id) => (parts.get(id) ? parts.get(id).label : id),
    bodyIndex: (id) => (parts.get(id) ? parts.get(id).body : -1),
    activeIds: () => { index(); return [...armList, ...staticList].map((r) => r.id); },
    /** rebuild the zero-pose ignore list (call after setActive) */
    resetBaseline() { baseline = null; },
    /** re-read the visible set out of a design */
    setActiveFromDesign(design) {
      const c = (design && design.components) || {};
      setActive(model.components.filter((x) => x.geometry && (c[x.id] ? c[x.id].visible !== false : x.visible !== false)).map((x) => x.id));
      baseline = null;
    },
  };
  setActive(o.active || DEFAULT_ACTIVE);
  return world;
}
