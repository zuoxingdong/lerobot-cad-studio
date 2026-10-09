/* The live-chip orchestrator behind the inspector's Checks section, the chips under each
   knob group and the action bar's verdict: one call answers "will it still print / fit / see?" from
   printcheck.js, collide.js and cameras.js.  DOM-free and with no timers of its own —
   `DEBOUNCE` below is the UI's timing policy as data, and every stage can be run alone. */

import * as THREE from 'three';
import { printCheck, worstOf, bedTransform, seatOnBed, DEFAULT_PRINTER } from './printcheck.js';
import { parametricFor, buildParametric, modelContext, isModified } from './parts.js';
import { verdict as cameraVerdict } from './cameras.js';
import { createCollisionWorld } from './collide.js';

/** The debounce policy, as data the UI applies. */
export const DEBOUNCE = {
  print_ms: 120,          // after `input`
  cameras_ms: 120,        // after `input`
  currentPose_ms: 0,      // live, every `input`
  presets_ms: 400,        // after the drag ENDS
  build_ms: 120,          // parametric rebuild
};

/**
 * Arm presets, used when a package declares no `manifest.presets`.  Every one is inside
 * the joint limits and collision-free (python-fcl agrees).
 *
 * `reach floor` is `arm_wrist_flex 170.5`, not the 171 the source table prints: the limit is
 * 170.5, so 171 trips the limit chip for 0.5° of nothing.
 */
export const DEFAULT_PRESETS = [
  { name: 'stowed', label: 'stowed', q: { arm_shoulder_pan: 0, arm_shoulder_lift: 0, arm_elbow_flex: 0, arm_wrist_flex: 0, arm_wrist_roll: 0, arm_gripper: 0 } },
  { name: 'reach floor', label: 'reach floor', q: { arm_shoulder_pan: 0, arm_shoulder_lift: -163, arm_elbow_flex: 35, arm_wrist_flex: 170.5, arm_wrist_roll: 0, arm_gripper: -30 } },
  { name: 'reach table', label: 'reach table', q: { arm_shoulder_pan: 0, arm_shoulder_lift: -6, arm_elbow_flex: 47, arm_wrist_flex: 2, arm_wrist_roll: 0, arm_gripper: -30 } },
  { name: 'raised max', label: 'raised max', q: { arm_shoulder_pan: 0, arm_shoulder_lift: -49, arm_elbow_flex: 99, arm_wrist_flex: 86, arm_wrist_roll: 0, arm_gripper: 0 } },
];

/**
 * Arm presets for a model.  `manifest.presets` FIRST — `DEFAULT_PRESETS` is only
 * the fallback for a package that declares none.  Both the array form
 * `[{id, label, q, note}]` and the map form `{name: q}` are accepted.
 * @returns {Array<{id, name, label, q, note, source}>}
 */
export function presetsFor(model) {
  const raw = (model && model.manifest && (model.manifest.presets || (model.manifest.kinematics || {}).presets)) || null;
  if (!raw) {
    /* DEFAULT_PRESETS is the LeKiwi / SO-101 arm, not a universal fallback.  Offering
       "reach floor" to an imported box handed the user a button that writes joint names
       the model does not have; a package sharing none of those joints has no presets. */
    const have = new Set((model && model.controlJoints && model.controlJoints()) || []);
    if (!Object.keys(DEFAULT_PRESETS[0].q).some((n) => have.has(n))) return [];
    return DEFAULT_PRESETS.map((p) => ({
      id: p.name, name: p.name, label: p.label || p.name, q: { ...p.q }, note: p.note || '',
      source: 'features/validate.js DEFAULT_PRESETS (the SO-101 motion reference §3)',
    }));
  }
  const list = Array.isArray(raw) ? raw : Object.entries(raw).map(([id, q]) => ({ id, q }));
  return list.map((p) => {
    const id = p.id || p.name;
    return {
      id, name: p.label || p.name || id, label: p.label || p.name || id,
      q: { ...(p.q || p.joints) }, note: p.note || '', source: `${model.id}.presets`,
    };
  });
}

/**
 * @param {object} o
 * @param {import('../core/robot-model.js').RobotModel} o.model
 * @param {object} [o.slots]     a `buildSlots()` instance
 * @param {object} [o.cameras]   a `createCameras()` instance
 * @param {object} [o.collide]   a `createCollisionWorld()` instance
 * @param {Array}  [o.presets]
 * @param {string} [o.printer]   printer profile id
 */
export function createValidator(o) {
  const model = o.model;
  if (!model) throw new Error('validate: createValidator({model}) needs a RobotModel');
  const slots = o.slots || null;
  const cams = o.cameras || null;
  const col = o.collide || null;
  let presets = o.presets || presetsFor(model);
  let printerId = o.printer || DEFAULT_PRINTER;

  /* ---------------------------------------------------------------- print */

  /**
   * Geometry + print transform for one component (a parametric part rebuilt with the design's
   * knobs), seated on the bed (z min 0) by a translation only: the export and the check read it.
   * @returns {{geometry, printTransform, warnings, error, parametric, printable}}
   */
  function geometryOf(design, componentId) {
    const g = poseOf(design, componentId);
    return g.geometry && g.printTransform ? { ...g, printTransform: seatOnBed(g.geometry, g.printTransform) } : g;
  }
  function poseOf(design, componentId) {
    const p = parametricFor(componentId);
    const c = model.component(componentId);
    /* untouched knobs print the package plate; an op stack on either base is the live mesh */
    const stock = p && c && c.printTransform && !isModified(design, componentId)
      ? model.packageGeometry(componentId) : null;
    if (p && !stock) {
      const params = (design && design.params && design.params[componentId]) || null;
      const built = buildParametric(componentId, params, modelContext(model, (design && design.params) || {}));
      if (!built.ok) return { geometry: null, printTransform: null, warnings: [], error: built.error, parametric: p.id, printable: true };
      const want = p.mesh;
      const meshes = built.result.meshes || [];
      const mesh = (want && meshes.find((m) => m.name === want)) || meshes.find((m) => m.printable) || meshes[0];
      if (!mesh) return { geometry: null, printTransform: null, warnings: built.result.warnings || [], error: null, parametric: p.id, printable: true };
      return {
        geometry: c && c.edited ? c.geometry : mesh.geometry, printTransform: mesh.printTransform || bedTransform(mesh.geometry),
        warnings: built.result.warnings || [], error: null, parametric: p.id, printable: mesh.printable !== false,
        /* a parametric part is BUILT on the plate — the generator owns the orientation */
        orientation: 'built', orientationSource: `${p.id} — built on the bed by the part generator`,
        frames: built.result.frames || {}, stats: built.result.stats || null, ms: built.ms,
      };
    }
    if (!c || !c.geometry) return { geometry: null, printTransform: null, warnings: [], error: null, parametric: null, orientation: null, printable: false };
    /* A part that SHIPS its own bed orientation is checked in exactly that orientation — a
       workspace alternative's `print/*.stl`.  Measuring its robot-frame mesh instead would put
       five chips on geometry nobody is ever going to print (and the corner mast's tube brace,
       183 mm upright on the plate, is 458 mm tall on the robot). */
    /* an edited part (design.parts ops) prints its edited mesh: a shipped plate no longer matches */
    const plate = c.edited ? null : c.printGeometry;
    const g = plate || (c.edited ? c.geometry : stock || c.geometry);
    /* A PACKAGE may state the bed orientation as a transform instead of a second mesh: the
       plate IS this mesh, rigidly moved (`robot-model.js Component.printTransform`), so the
       chips are measured on the geometry the user will print either way. */
    if (!plate && c.printTransform) {
      return { geometry: g, printTransform: c.printTransform.clone(), warnings: [], error: null,
        parametric: null, shipped: true, orientation: 'declared',
        orientationSource: plateOf(c), printable: c.printable !== false };
    }
    /* A stock mesh with no stored print orientation is dropped flat on the bed — centred and
       sat on its lowest point, in whatever pose the ROBOT holds it.  That pose is the studio's
       invention, not the package's answer, so it is reported as `orientation: 'unknown'` and
       printcheck.js softens the bed-contact verdict to a WARN. */
    return { geometry: g, printTransform: bedTransform(g), warnings: [], error: null, parametric: null,
      /* `shipped` says the five chips were measured on the FILE the user will print, not on a
         display mesh — so the inspector must not caption them "not the package print file" */
      shipped: !!plate, orientation: plate ? 'shipped' : 'unknown',
      orientationSource: plate ? plateOf(c) : unknownWhy(c),
      /* the user's OWN file: nothing decimated it and no package plate stands behind it */
      ownMesh: isImported(c),
      printable: c.printable !== false };
  }

  /** an IMPORTED component: a dropped STL, or one part of a loose-file assembly package */
  function isImported(c) {
    return !!(c && (c.imported === true || c.group === 'imported'
      || (typeof c.source === 'string' && /^import/.test(c.source))));
  }

  /** the plate file a component's bed pose was taken from — `print_source`, short form */
  function plateOf(c) {
    const f = c && c.print_source;
    return f ? String(f).split('/').pop() : null;
  }
  /**
   * Why a part has no stated bed pose, in the package's own terms.
   *
   * A `print_file` that IS the display mesh (upstream PincOpen ships one `cad/stl/` folder,
   * so the assembly mesh and the printable file are the same bytes) names the geometry, not
   * a pose — saying "package plate" there would turn an assembly pose into a verdict.  A
   * part with no print file at all simply states nothing.
   */
  function unknownWhy(c) {
    const f = plateOf(c);
    if (!f) return 'the package names no print file for this part';
    return c.printFitNote ? `${f} — ${c.printFitNote}`
      : `${f} — the package names this file but states no bed pose for it`;
  }

  /** The five print chips for one component. */
  function printOf(design, componentId, opts = {}) {
    const g = geometryOf(design, componentId);
    const clearance = opts.clearance !== undefined ? opts.clearance : clearanceOf(design, componentId, g);
    return printCheck(g.geometry, g.printTransform, opts.printer || printerId, {
      clearance, warnings: g.warnings, error: g.error, name: componentId,
      orientation: g.orientation || null, orientationSource: g.orientationSource || null,
      /* `display` is a claim about OUR mesh; an import has no display twin, so it is
         checked as itself and its defects reach the export gate */
      preview: g.parametric ? 'csg' : (g.geometry && !g.shipped && !g.ownMesh ? 'display' : null),
      ownMesh: !!g.ownMesh,
      label: col ? (id) => col.label(id) : undefined,
    });
  }

  /**
   * Interference of this component against the rest of the visible robot, at its live
   * placement (Move, hinge turns).  A slot part gets the chip, any part moved off its shipped
   * placement, and any import or copy; its own option's parts are left out, and each hit says whether the
   * shipped shape at the shipped placement had it (`expected`).
   * @returns {Array|undefined} hits, or undefined when the chip does not apply
   */
  function clearanceOf(design, componentId, g) {
    if (!col || !slots) return undefined;
    const c = model.component(componentId);
    const sid = slots.slotOfComponent(componentId);
    const base = shippedLocal(c);
    const moved = !!(c && c.local && base && !sameMatrix(c.local, base));
    /* an import or a copy has no shipped placement: the user put it there */
    const placed = !sid && !base && isImported(c);
    if (!sid && !moved && !placed) return undefined;
    const opt = sid ? slots.option(sid, slots.activeOption(design, sid)) : null;
    const family = new Set([componentId, ...((opt && opt.shows) || [])]);
    const others = col.activeIds().filter((id) => !family.has(id));
    const geo = g || geometryOf(design, componentId);
    /* measure at THE DESIGN'S pose, not the pose the collision world was left in */
    const pose = (design && design.joints) || {};
    const keep = model.getJoints();
    let M;
    try { model.setJoints(pose); M = model.worldMatrix(componentId) || new THREE.Matrix4(); }
    finally { model.setJoints(keep); }
    const M0 = moved ? M.clone().multiply(c.local.clone().invert()).multiply(base) : M;
    const probe = (key, geometry, at) => {
      col.addDynamic(key, geometry, at, { label: componentId, group: 'preview' });
      try { return col.checkTransform(key, at, others, { maxHits: 8, pose }).hits; }
      finally { try { col.remove(key); } catch (e) { /* nothing left to do */ } }
    };
    try {
      const hits = geo.parametric && geo.geometry ? probe('__validate__' + componentId, geo.geometry, M)
        : col.checkTransform(componentId, M, others, { maxHits: 8, pose }).hits;
      /* a contact the part has as shipped is by design; only a new one is a finding */
      const before = placed ? copyHits(componentId, probe, M) : shippedHits(design, componentId, geo, probe, M0, moved);
      const was = new Set(before === null ? hits.map((h) => h.b) : before.map((h) => h.b));
      return hits.map((h) => ({ ...h, expected: was.has(h.b) }));
    } catch (e) {
      return [];
    }
  }

  /* a copy's expected contacts: its source's shape at the copy's placement, less the source */
  function copyHits(componentId, probe, at) {
    const c = model.component(componentId);
    const src = c && c.geometry && c.geometry.userData && c.geometry.userData.copyOf;
    const s = src && model.component(src);
    if (!s || !s.geometry) return [];
    const g = (s.geometry.userData && s.geometry.userData.opsBase) || s.geometry;
    return probe('__shipped__' + componentId, g, at).filter((h) => h.b !== src);
  }

  /* the package's own `local` for a component, before any Move or hinge turn */
  function shippedLocal(c) {
    const raw = c && c.owner && c.owner.manifest && (c.owner.manifest.components || []).find((x) => x.id === c.localId);
    return raw && Array.isArray(raw.local) && raw.local.length === 16 ? new THREE.Matrix4().fromArray(raw.local) : null;
  }
  const sameMatrix = (a, b) => a.elements.every((v, i) => Math.abs(v - b.elements[i]) < 1e-6);

  /* the contacts of the part's shipped shape at its shipped placement `at`; null = the part
     as it stands IS the shipped one */
  const shippedCache = new Map();
  function shippedHits(design, componentId, geo, probe, at, moved) {
    const c = model.component(componentId);
    if (geo.parametric) {
      const edited = design && design.params && design.params[componentId]
        && Object.keys(design.params[componentId]).length;
      if (!edited && !moved) return null;
      const shipped = () => {
        const pkg = model.packageGeometry(componentId);
        const base = pkg ? { geometry: pkg } : edited ? geometryOf({ ...design, params: { ...design.params, [componentId]: undefined } }, componentId) : geo;
        return base.geometry ? probe('__shipped__' + componentId, base.geometry, at) : [];
      };
      if (moved) return shipped();
      if (!shippedCache.has(componentId)) shippedCache.set(componentId, shipped());
      return shippedCache.get(componentId);
    }
    const base = c && c.edited && c.geometry && c.geometry.userData && c.geometry.userData.opsBase;
    return base || moved ? probe('__shipped__' + componentId, base || c.geometry, at) : null;
  }

  /* -------------------------------------------------------------- physics */

  /**
   * Collision at the CURRENT pose (live) and across the arm presets (debounced).
   * @returns {{currentPose:{ok, hits, names, limits, ms}, presets:[{name, ok, hits, names, limits, ms}]}}
   */
  function physicsOf(design, opts = {}) {
    if (!col) return { currentPose: null, presets: [] };
    const q = (design && design.joints) || {};
    const name = (h) => col.label(h.b) + ' × ' + col.label(h.a);
    const one = (pose, label) => {
      const r = col.checkPose(pose, { maxHits: opts.maxHits == null ? 8 : opts.maxHits, count: false });
      return {
        name: label, ok: r.ok, hits: r.hits, names: r.hits.map(name),
        limits: r.limitHits, ms: +r.ms.toFixed(2),
        tooltip: r.hits.length ? `hits ${col.label(r.hits[0].b)} at ${label}` : (r.limitHits.length ? `${r.limitHits[0].joint} outside its travel at ${label}` : null),
      };
    };
    const out = { currentPose: null, presets: [] };
    if (opts.stage !== 'presets') out.currentPose = one(q, 'current pose');
    if (opts.stage !== 'current') {
      out.presets = presets.map((p) => ({ id: p.id || p.name, ...one(p.q, p.label || p.name) }));
      /* the preset loop leaves the collision world parked in the LAST preset ("raised
         max"); put the design's own pose back so the next clearance test — and anything
         else reading col.worldMatrix / col.worldBox — measures the robot the user sees. */
      if (out.presets.length && col.applyPose) col.applyPose(q);
    }
    return out;
  }

  /* -------------------------------------------------------------- cameras */

  /**
   * The verdict chips of the cameras this component affects (its slot's
   * `provides: ["cameras.top"]`), or every camera when it affects none.
   */
  function camerasOf(design, componentId, opts = {}) {
    if (!cams) return [];
    let ids = cams.ids;
    if (componentId && slots) {
      const sid = slots.slotOfComponent(componentId);
      const provided = sid ? (slots.slots[sid].provides || []).filter((p) => p.startsWith('cameras.')).map((p) => p.slice(8)) : [];
      if (provided.length) ids = provided.filter((id) => cams.has(id));
    }
    return ids.map((id) => {
      const ev = cams.evaluate(id, opts.ctx || {});
      const v = cameraVerdict(ev, { warn: cams.warn });
      return {
        id, label: (cams.get(id) || {}).label || id,
        verdict: v, level: v.level, text: v.text,
        reach_disc_pct: ev.reach_disc_pct, robot_pct: ev.robot_pct,
        hfov_deg: ev.hfov_deg, rendered: ev.rendered, ok: ev.ok,
      };
    });
  }

  /* A chip is at most a few words; the sentence lives in the tooltip.  The inspector rail is
     344 px wide, so a chip that spells out its own detail is clipped mid-word. */
  const SHORT_CHIP = {
    bed: 'too big for the bed', bedcontact: 'bed contact', preview: 'approximate shape',
    closed: 'open edges', bodies: 'loose shells', overhang: 'overhangs', clearance: 'hits a part',
    orientation: 'print pose not set', design: 'design note', build: 'build failed',
  };
  const shortChip = (c) => SHORT_CHIP[c.key] || (c.name || c.key || '').toLowerCase();

  /* ------------------------------------------------------------ the whole */

  /**
   * @param {object} design     the rps/design@1 state
   * @param {string} componentId
   * @param {{stages?:string[], ctx?:object, printer?:string, previous?:object}} [opts]
   *        `previous` supplies the deltas the cameras chips show ("−2.1").
   * @returns {{component, slot, print, physics, cameras, chips, verdict, ms}}
   */
  function validateComponent(design, componentId, opts = {}) {
    const t0 = Date.now();
    const stages = opts.stages || ['print', 'physics', 'cameras'];
    const out = {
      component: componentId,
      slot: slots ? slots.slotOfComponent(componentId) : null,
      print: null, physics: null, cameras: null, chips: [], verdict: 'pass', ms: 0,
    };
    if (stages.includes('print')) out.print = printOf(design, componentId, opts);
    if (stages.includes('physics')) out.physics = physicsOf(design, opts);
    if (stages.includes('cameras')) out.cameras = camerasOf(design, componentId, opts);

    /* the chips the Shape section shows under the knob group */
    const chips = [];
    const fit = out.print ? out.print.chips.find((c) => c.key === 'clearance') : null;
    if (out.print) {
      const real = out.print.chips.filter((c) => !c.preview && c.key !== 'clearance');
      const bad = real.find((c) => c.level === 'fail') || real.find((c) => c.level === 'warn');
      chips.push(bad
        ? { key: 'print', level: bad.level, text: shortChip(bad), tooltip: `${bad.name} — ${bad.detail}`, from: bad.key }
        : { key: 'print', level: 'pass', text: 'print ok' });
    }
    if (out.physics && out.physics.currentPose) {
      const cp = out.physics.currentPose;
      const failing = (out.physics.presets || []).filter((p) => !p.ok);
      const hit = fit && fit.level !== 'pass' ? fit : null;
      chips.push(cp.ok && !failing.length && !hit
        ? { key: 'clear', level: 'pass', text: 'clear' }
        : !cp.ok ? { key: 'clear', level: 'fail', text: cp.names[0] || 'blocked', tooltip: cp.tooltip || null }
          : hit ? { key: 'clear', level: 'warn', text: hit.detail, tooltip: hit.detail }
            : { key: 'clear', level: 'warn', text: `${failing.length} preset${failing.length === 1 ? '' : 's'} blocked`,
                tooltip: (failing[0] && failing[0].tooltip) || null });
    } else if (fit && fit.level !== 'pass') {
      chips.push({ key: 'clear', level: fit.level, text: fit.detail, tooltip: fit.detail });
    }
    for (const c of out.cameras || []) {
      const prev = opts.previous && (opts.previous.cameras || []).find((x) => x.id === c.id);
      const d = prev && Number.isFinite(prev.reach_disc_pct) ? c.reach_disc_pct - prev.reach_disc_pct : null;
      chips.push({
        key: 'cam:' + c.id, level: c.level,
        text: `${c.id} ${Math.round(c.reach_disc_pct)}%` + (d ? ` (${d > 0 ? '+' : ''}${d.toFixed(1)})` : ''),
        tooltip: c.text,
      });
    }
    out.chips = chips;
    out.verdict = worstOf(chips.map((c) => ({ level: c.level })));
    out.ms = Date.now() - t0;
    return out;
  }

  /** Every printable component of the design — the top bar's Print check dialog. */
  function validateDesign(design, opts = {}) {
    const ids = (opts.ids || model.printables().map((c) => c.id))
      .filter((id) => { const r = (design.components || {})[id]; return r ? r.visible !== false : true; });
    const components = ids.map((id) => {
      const r = printOf(design, id, opts);
      return { component: id, label: (model.component(id) || {}).label || id,
               verdict: r.actionable, fullVerdict: r.verdict, preview: r.preview,
               orientation: r.orientation, orientationLabel: r.orientationLabel,
               orientationSource: r.orientationSource,
               chips: r.chips, analysis: r.analysis };
    });
    /* how many parts are printed in a pose somebody STATED, and how many in one the studio
       had to invent — the one number that says whether `print_file` is being read (D1) */
    const orientations = { 'from package': 0, 'laid flat': 0, 'not set': 0 };
    for (const c of components) if (c.orientationLabel in orientations) orientations[c.orientationLabel]++;
    return { components, orientations,
             worst: worstOf(components.map((c) => ({ level: c.verdict }))), printer: printerId };
  }

  return {
    model,
    /* a GETTER: captured at creation, `setPresets()` never changed what a caller read
       off the object */
    get presets() { return presets; },
    printer: () => printerId,
    setPrinter: (id) => { printerId = id; return printerId; },
    setPresets: (p) => { presets = p || []; return presets; },
    validateComponent, validateDesign, printOf, physicsOf, camerasOf, geometryOf, clearanceOf,
    DEBOUNCE,
  };
}


/**
 * A collision world for `model`, set to the design's active parts and warmed: the zero-pose
 * ignore list is built now, because `collide.js` would otherwise build it from inside the
 * first `rawCheck` and answer that first question about the zero pose.  `null` on failure.
 */
export function makeCollision(model, design) {
  let world = null;
  try { world = createCollisionWorld({ model }); } catch (e) { return null; }
  if (design) { try { world.setActiveFromDesign(design); } catch (e) { /* keep the default set */ } }
  try { world.baselinePairs(); } catch (e) { /* nothing with geometry yet */ }
  return world;
}
