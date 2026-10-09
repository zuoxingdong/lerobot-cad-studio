/* The camera registry: every camera the package, a parametric part or a fitted alternative
   declares, its pose off `model.cameraMatrix(id)`, and what each one sees.  DOM-free —
   `evaluate()` takes an injected renderer/scene/tag function.  Needs three,
   features/camera-options.js and the frustum maths in scene/frustum-math.js. */

import * as THREE from 'three';
import { verdict } from './camera-options.js';
import { hFovToV, vFovToH, CLASS_COLORS, SPARE_COLORS, CAMERA_FALLBACK } from '../scene/frustum-math.js';

export { verdict, hFovToV, vFovToH, CLASS_COLORS };

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const _e = new THREE.Euler();
const _calibM = new THREE.Matrix4();

export const CAMERA_DEFAULTS = {
  /* the lens numbers are scene/frustum-math.js's, so a spec drawn without them and a camera
     registered without them answer the same */
  ...CAMERA_FALLBACK,
  hfov_range: [30, 140],
  id_pass: { width: 160, height: 120 },
  robot_classes: ['robot', 'arm', 'gripper', 'mast', 'upgrade'],
  warn: { robot_pct: 35 },
  reach_disc: { centre: [0, 0], radius: 300, y_min: 0 },
};

/* ------------------------------------------------------------- small maths */

function asMatrix4(m) {
  if (!m) return null;
  if (m.isMatrix4) return m;
  if (m.isObject3D) { m.updateMatrixWorld && m.updateMatrixWorld(); return m.matrixWorld; }
  if (Array.isArray(m) && m.length === 16) return new THREE.Matrix4().fromArray(m);
  return null;
}
function asVector3(p) {
  if (!p) return null;
  if (p.isVector3) return p.clone();
  if (Array.isArray(p) && p.length >= 3) return new THREE.Vector3(p[0], p[1], p[2]);
  if (typeof p === 'object' && Number.isFinite(p.x)) return new THREE.Vector3(p.x, p.y, p.z);
  return null;
}

/**
 * Tolerant frame-descriptor reader — the shapes `RobotModel` accepts:
 * `{matrix:[16]}` | `{origin, dir, up?}` | `{origin, rpy}` | `{origin, tilt_deg}`.
 * Returns a Matrix4 in the CAMERA convention (looks down −Z, +Y up).
 */
/* Conventions: robot frame, millimetres, +X right / +Y forward / +Z up; a camera matrix is
   the three.js one (looking down its local -Z); image coordinates are u right-positive and
   v DOWN-positive over -1…+1, with raw three NDC returned separately as `ndc`. */
export function frameToMatrix(f) {
  if (!f) return null;
  if (f.isMatrix4) return f.clone();
  if (Array.isArray(f) && f.length === 16) return new THREE.Matrix4().fromArray(f);
  if (Array.isArray(f.matrix) && f.matrix.length === 16) return new THREE.Matrix4().fromArray(f.matrix);
  if (Array.isArray(f.local) && f.local.length === 16) return new THREE.Matrix4().fromArray(f.local);
  const o = f.origin || f.xyz || [0, 0, 0];
  let dir, up;
  if (Array.isArray(f.dir)) {
    dir = new THREE.Vector3().fromArray(f.dir).normalize();
    up = Array.isArray(f.up) ? new THREE.Vector3().fromArray(f.up) : new THREE.Vector3(0, 0, 1);
  } else if (Array.isArray(f.rpy)) {
    _e.set(f.rpy[0], f.rpy[1], f.rpy[2], 'ZYX');
    const M = new THREE.Matrix4().makeRotationFromEuler(_e);
    M.setPosition(o[0], o[1], o[2]);
    return M;
  } else {
    const t = (f.tilt_deg != null ? f.tilt_deg : 0) * D2R;   // nose-DOWN, the mast convention
    dir = new THREE.Vector3(0, Math.cos(t), -Math.sin(t));
    up = new THREE.Vector3(0, Math.sin(t), Math.cos(t));
  }
  const z = dir.clone().negate().normalize();               // the camera looks down local −Z
  up = up.clone().sub(z.clone().multiplyScalar(up.dot(z)));
  if (up.lengthSq() < 1e-9) {
    up.set(0, 0, 1).sub(z.clone().multiplyScalar(z.z));
    if (up.lengthSq() < 1e-9) up.set(0, 1, 0).sub(z.clone().multiplyScalar(z.y));
  }
  up.normalize();
  const x = new THREE.Vector3().crossVectors(up, z).normalize();
  const M = new THREE.Matrix4().makeBasis(x, up, z);
  M.setPosition(o[0], o[1], o[2]);
  return M;
}

/* the registry */

/**
 * The as-installed offset a package DECLARES for a camera, read out of its `verified`
 * block: `verified_tilt_deg − design_tilt_deg`.  `design_tilt_deg` falls back
 * to the camera's own `tilt_deg` so a package that only states the measured number still
 * yields an offset.  No `verified` block → a zero offset, which is what every camera
 * without a measurement must get.
 * @returns {{tilt_deg:number, roll_deg:number, source:string|null}}
 */
export function calibDefaultFor(spec) {
  const v = spec && spec.verified;
  const none = { tilt_deg: 0, roll_deg: 0, source: null };
  if (!v || typeof v !== 'object') return none;
  /* `null` is how a package says UNMEASURED, and `Number(null)` is 0 — which would read a
     missing measurement as "the head points 65° away from its design".  Only a real number
     counts. */
  const num = (x) => (x === null || x === undefined || x === '' ? NaN : Number(x));
  const measured = num(v.verified_tilt_deg);
  const design = Number.isFinite(num(v.design_tilt_deg)) ? num(v.design_tilt_deg)
    : Number.isFinite(num(spec.tilt_deg)) ? num(spec.tilt_deg) : NaN;
  const tilt = Number.isFinite(measured) && Number.isFinite(design)
    ? Math.round((measured - design) * 1000) / 1000
    : (Number.isFinite(num(v.droop_deg)) ? num(v.droop_deg) : 0);
  const roll = Number.isFinite(num(v.verified_roll_deg)) ? num(v.verified_roll_deg) : 0;
  if (!tilt && !roll) return none;
  return { tilt_deg: tilt, roll_deg: roll, source: v.against || v.note || 'package `verified`' };
}

class CameraRec {
  constructor(spec, owner) {
    this.id = spec.id;
    this.owner = owner;
    this.label = spec.label || spec.name || spec.id;
    this.name = spec.name || spec.label || spec.id;
    this.link = spec.link || null;
    this.hfov_default = Number.isFinite(spec.hfov) ? spec.hfov
      : Number.isFinite(spec.hfov_deg) ? spec.hfov_deg : CAMERA_DEFAULTS.hfov_deg;
    this.hfov_deg = this.hfov_default;
    this.hfov_range = Array.isArray(spec.hfov_range) ? spec.hfov_range.slice() : CAMERA_DEFAULTS.hfov_range.slice();
    this.aspect = Number.isFinite(spec.aspect) ? spec.aspect : owner.aspect;
    this.near = Number.isFinite(spec.near) ? spec.near : CAMERA_DEFAULTS.near;
    this.far = Number.isFinite(spec.far) ? spec.far : CAMERA_DEFAULTS.far;
    this.source = spec.source || null;
    this.alternatives = Array.isArray(spec.alternatives) ? spec.alternatives.slice() : [];
    this.note = spec.note || '';
    this.owner_pkg = spec.owner || null;
    this.user_hfov = false;
    this.hfov_from_part = false;
    /* AS-INSTALLED CALIBRATION.  The package poses the
       DESIGN; a printed head droops.  `calib` is the measured offset from the design pose,
       in the camera's OWN axes, applied in `getPose()` AFTER the package/part matrix and
       never written back into a part parameter — a calibration must not edit the STL. */
    this.verified = spec.verified || null;
    this.calib_default = calibDefaultFor(spec);
    this.calib = { tilt_deg: this.calib_default.tilt_deg, roll_deg: this.calib_default.roll_deg };
    this.user_calib = false;
  }
  get vfov_deg() { return hFovToV(this.hfov_deg, this.aspect); }
  get intrinsics() {
    return { hfov_deg: this.hfov_deg, vfov_deg: this.vfov_deg, aspect: this.aspect, near: this.near, far: this.far };
  }
  getPose(ctx) { return this.owner.getPose(this.id, ctx); }
  project(p, pose) { return this.owner.project(this.id, p, pose); }
  groundFootprint(z, o) { return this.owner.groundFootprint(this.id, z, o); }
  evaluate(ctx, o) { return this.owner.evaluate(this.id, ctx, o); }
}

export class Cameras {
  /**
   * @param {import('../core/robot-model.js').RobotModel} model
   * @param {{aspect?:number, idPass?:object, robotClasses?:string[], warn?:object,
   *          reachDisc?:object, groundZ?:number}} [opts]
   */
  constructor(model, opts = {}) {
    if (!model) throw new Error('cameras: createCameras(model) needs a RobotModel');
    this.model = model;
    this.aspect = Number.isFinite(opts.aspect) ? opts.aspect : CAMERA_DEFAULTS.aspect;
    this.idPass = { ...CAMERA_DEFAULTS.id_pass, ...(opts.idPass || {}) };
    this.robotClasses = (opts.robotClasses || CAMERA_DEFAULTS.robot_classes).slice();
    this.warn = { ...CAMERA_DEFAULTS.warn, ...(opts.warn || {}) };
    this.groundZ = Number.isFinite(opts.groundZ) ? opts.groundZ : (Number.isFinite(model.groundZ) ? model.groundZ : 0);
    this.reachDisc = opts.reachDisc || readReachDisc(model);

    /* 'design' poses what a printed part is MEANT to be; 'installed' adds each camera's
       measured offset.  The panel's one toggle. */
    this.calibMode = opts.calibMode === 'installed' ? 'installed' : 'design';
    this.ids = [];
    this._cams = new Map();
    this._override = new Map();     // id -> {matrix|spec, frame, hfov_deg, source}
    /* RobotModel keeps only what it needs to pose a camera; the manifest also
       carries `hfov_range`, the sourced `alternatives` the ⌄ menu lists, and the
       note — so merge the raw entry back in. */
    const raw = rawCameraSpecs(model);
    for (const c of model.cameras || []) this.register({ ...(raw[c.id] || {}), ...c });

    this._classColor = new Map();
    this._spare = 0;
    for (const [k, c] of Object.entries({ ...CLASS_COLORS, ...(opts.classes || {}) })) this._classColor.set(k, c);
    this._mat = new Map();
    this._rt = null;
    this._threeCam = new Map();
    this._pixels = null;
    this._lut = null;
    this._selfParts = new Map();    // camera id -> Set of its own mount's component ids
  }

  /**
   * A camera's own housing is left out of that camera's ID pass.  The head, retainer and
   * module body sit millimetres in front of the sensor (the wrist DF200's module spans
   * 4–16 mm), and the pass paints DoubleSide — so from the sensor they cover a quarter of
   * the frame, while through the real lens (entrance pupil 8 mm further forward, barrel
   * radius 6.8 mm) none of them is imaged.  Dropping them makes the wrist agree with the
   * MuJoCo model of the same design to 0.01 pp on every camera and pose.
   *
   * Only the parts of the option that POSES the camera are dropped, and only for that
   * camera.  `adoptSlotOption()` fills this in on every swap; `evaluate()` reports the
   * list back as `self_parts`.
   *
   * @param {string} camId
   * @param {string[]} componentIds  the fitted option's own components (`option.shows`)
   */
  setSelfParts(camId, componentIds) {
    const ids = (componentIds || []).filter(Boolean).map(String);
    if (!ids.length) this._selfParts.delete(camId);
    else this._selfParts.set(camId, new Set(ids));
  }

  /** the component ids `setSelfParts()` left out of `camId`'s ID pass */
  selfParts(camId) { return [...(this._selfParts.get(camId) || [])]; }

  /* ----------------------------------------------------------- registry api */
  register(spec) {
    if (!spec || !spec.id) return null;
    const rec = new CameraRec(spec, this);
    if (!this._cams.has(rec.id)) this.ids.push(rec.id);
    this._cams.set(rec.id, rec);
    return rec;
  }
  remove(id) { this._cams.delete(id); this.ids = this.ids.filter((x) => x !== id); this._override.delete(id); }
  has(id) { return this._cams.has(id); }
  get(id) { return this._cams.get(id) || null; }
  list() { return this.ids.map((id) => this._cams.get(id)); }

  /**
   * Adopt the camera frames a parametric part build publishes, e.g.
   * `build().frames = { cam_top: {origin, tilt_deg, hfov_deg} }`.
   * The mapping frame-name -> camera id is `cam_<id>` by convention, and any
   * explicit `map` wins.
   * @param {object} frames  the part build's `frames`
   * @param {{map?:object, source?:string, frame?:'robot'|string}} [opts]
   * @returns {string[]} the camera ids that moved
   */
  registerFrames(frames, opts = {}) {
    const moved = [];
    /* a part may build in its own frame (the PincOpen assembly frame, say);
       `opts.frame` names what carries it into robot mm */
    let base = null;
    /* an explicit Matrix4 is a fixed base; a NAMED carrier is resolved again on every
       getPose(), or a camera published off a moving link (the wrist) would freeze at
       the pose the part happened to be built in and stop riding the arm. */
    const live = !!(opts.frame && opts.frame !== 'robot' && !asMatrix4(opts.frame));
    if (opts.frame && opts.frame !== 'robot') {
      base = this.liveBase(opts.frame);
      if (!base) return moved;
    }
    for (const [name, spec] of Object.entries(frames || {})) {
      const id = (opts.map && opts.map[name]) || (name.startsWith('cam_') ? name.slice(4) : name);
      if (!this._cams.has(id)) continue;
      const local = frameToMatrix(spec);
      if (!local) continue;
      const M = base ? new THREE.Matrix4().multiplyMatrices(base, local) : local;
      this._override.set(id, {
        matrix: M, local, live: live ? opts.frame : null, frame: opts.frame || 'robot',
        source: opts.source || `part frame ${name}`,
        hfov_deg: Number.isFinite(spec.hfov_deg) ? spec.hfov_deg : null,
      });
      if (Number.isFinite(spec.hfov_deg)) this.adoptHfov(id, spec.hfov_deg);
      this._threeCam.delete(id);
      moved.push(id);
    }
    return moved;
  }
  /**
   * Resolve what carries a published part frame into robot mm, LIVE.
   *
   * Four spellings, so the carrier can come from data rather than from a table of three
   * component ids in `ui/design-page.js`:
   *   · a `THREE.Matrix4`            — a fixed base, never re-resolved
   *   · a declared frame name        — `wrist_flange`, `pincopen/fingertip_pad`
   *   · `component:<id>`             — the part's OWN world matrix: exactly the frame its
   *                                    geometry is drawn in, which is what a build
   *                                    publishes its camera frame in
   *   · a link name                  — `Wrist_Roll_08c-v1`
   * @returns {THREE.Matrix4|null}
   */
  liveBase(name) {
    if (!name || name === 'robot') return null;
    const M = asMatrix4(name);
    if (M) return M;
    if (typeof name !== 'string') return null;
    if (name.startsWith('component:')) {
      try { return this.model.worldMatrix(name.slice(10)) || null; } catch (e) { return null; }
    }
    try { const f = this.model.frameMatrix(name); if (f) return f; } catch (e) { /* not a frame */ }
    try { if (this.model.hasLink && this.model.hasLink(name)) return this.model.fk(name); }
    catch (e) { /* not a link either */ }
    return null;
  }

  /** Drop a part override and go back to the package pose — pose AND hFOV, or the camera
   *  keeps the last part's lens for ever.  A value the USER typed still wins. */
  clearOverride(id) {
    const ids = id ? [id] : [...this._override.keys()];
    if (id) this._override.delete(id); else this._override.clear();
    for (const k of ids) {
      const c = this.get(k);
      if (c && c.hfov_from_part && !c.user_hfov) {
        c.hfov_deg = c.hfov_default; c.hfov_from_part = false;
      }
      this._threeCam.delete(k);
    }
    this._threeCam.delete(id);
  }
  /** Drop every override one source published: that part is no longer fitted. */
  clearOverridesFrom(source) {
    const gone = [];
    for (const [id, ov] of this._override) {
      if (ov.source !== source) continue;
      this._override.delete(id);
      const c = this.get(id);
      if (c && c.hfov_from_part && !c.user_hfov) {
        c.hfov_deg = c.hfov_default; c.hfov_from_part = false;
      }
      this._threeCam.delete(id);
      gone.push(id);
    }
    return gone;
  }

  setHfov(id, deg) {
    const c = this.get(id); if (!c) return null;
    const [lo, hi] = c.hfov_range;
    c.hfov_deg = Math.min(hi, Math.max(lo, Number(deg) || c.hfov_deg));
    c.user_hfov = true;
    this._threeCam.delete(id);
    return c.hfov_deg;
  }
  setAspect(id, a) {
    const c = this.get(id); if (!c || !(a > 0)) return null;
    c.aspect = a; this._threeCam.delete(id); return a;
  }
  reset(id) {
    const c = this.get(id); if (!c) return;
    c.hfov_deg = c.hfov_default; c.user_hfov = false; c.hfov_from_part = false;
    this._threeCam.delete(id);
  }
  /* ------------------------------------------------------- as-installed calib */
  /** 'design' | 'installed' — which pose `getPose()` returns.  Returns the mode set. */
  setCalibMode(mode) {
    const m = mode === 'installed' || mode === true ? 'installed' : 'design';
    if (m !== this.calibMode) { this.calibMode = m; this._threeCam.clear(); }
    return this.calibMode;
  }
  /** The measured offset for one camera, in ITS OWN axes.  Merges; never touches params. */
  setCalib(id, calib) {
    const c = this.get(id);
    if (!c || !calib) return null;
    if (Number.isFinite(calib.tilt_deg)) c.calib.tilt_deg = Number(calib.tilt_deg);
    if (Number.isFinite(calib.roll_deg)) c.calib.roll_deg = Number(calib.roll_deg);
    c.user_calib = true;
    this._threeCam.delete(id);
    return { ...c.calib };
  }
  /** The offset in force, `{tilt_deg, roll_deg}`. */
  getCalib(id) { const c = this.get(id); return c ? { ...c.calib } : null; }
  /** What the PACKAGE declares, `{tilt_deg, roll_deg, source}` — the default of `calib`. */
  calibDefault(id) { const c = this.get(id); return c ? { ...c.calib_default } : null; }
  /** Back to the package's declared offset. */
  resetCalib(id) {
    const c = this.get(id);
    if (!c) return null;
    c.calib = { tilt_deg: c.calib_default.tilt_deg, roll_deg: c.calib_default.roll_deg };
    c.user_calib = false;
    this._threeCam.delete(id);
    return { ...c.calib };
  }
  /** Is there anything to SEE when the mode flips?  (a zero offset is not a calibration) */
  hasCalib(id) { const c = this.get(id); return !!(c && (c.calib.tilt_deg || c.calib.roll_deg)); }
  /**
   * Does the PACKAGE declare a calibration SLOT for this camera — a `verified` block — even
   * though nothing has been measured into it yet?  The strip shows the design/as-installed
   * control for these and labels them "unmeasured", instead of hiding the control and
   * leaving the user with no way to type the number in once they have it.
   */
  hasCalibSlot(id) { const c = this.get(id); return !!(c && c.verified); }

  /** a part-published hFOV, adopted once, never over a value the user typed. */
  adoptHfov(id, hfov_deg) {
    const c = this.get(id);
    if (!c || c.user_hfov || !Number.isFinite(hfov_deg)) return false;
    c.hfov_deg = hfov_deg; c.hfov_from_part = true; this._threeCam.delete(id);
    return true;
  }
  toJSON() {
    const out = {};
    for (const c of this.list()) {
      out[c.id] = { hfov_deg: c.hfov_deg, aspect: c.aspect, enabled: true, user_hfov: c.user_hfov };
      if (c.calib.tilt_deg || c.calib.roll_deg) out[c.id].calib = { ...c.calib };
    }
    return out;
  }
  fromJSON(obj) {
    if (!obj) return;
    for (const c of this.list()) {
      const o = obj[c.id]; if (!o) continue;
      if (Number.isFinite(o.hfov_deg)) { c.hfov_deg = o.hfov_deg; c.user_hfov = o.user_hfov !== false; }
      if (Number.isFinite(o.aspect)) c.aspect = o.aspect;
      if (o.calib) this.setCalib(c.id, o.calib);
      this._threeCam.delete(c.id);
    }
  }

  /* ------------------------------------------------------------------ pose */
  /**
   * @returns {{ok, id, name, matrix:THREE.Matrix4, matrixWorld:THREE.Matrix4,
   *            origin, dir, up, right, tilt_deg, source, intrinsics}}
   */
  getPose(camId, ctx = {}) {
    const cam = this.get(camId);
    if (!cam) return null;
    let M = null, source = '';
    const ov = this._override.get(camId);
    if (ov) {
      M = ov.matrix.clone();
      if (ov.live) {
        /* re-resolve the carrier at the CURRENT pose */
        try {
          const base = this.liveBase(ov.live);
          if (base) M = new THREE.Matrix4().multiplyMatrices(base, ov.local);
        } catch (e) { /* the frame went away with a swap: keep the baked matrix */ }
      } else if (!ov.frame || ov.frame === 'robot') {
        /* A part publishes its camera frame in the ROBOT's own frame, and that frame knows
           nothing about where the robot is STANDING.  `model.cameraMatrix()` multiplies the driven base pose in; this
           branch never did, so the top camera stayed at the world origin while the robot
           drove away from it (and a look-through of it showed a robot that never moved).
           A LIVE carrier is already resolved through `frameMatrix`/`fk`, which carry the
           base themselves — doubling it there would be the opposite bug. */
        const B = this.model.baseMatrix ? this.model.baseMatrix() : null;
        const bp = this.model.basePose || {};
        if (B && (bp.x || bp.y || bp.yaw)) M = new THREE.Matrix4().multiplyMatrices(B, M);
      }
      source = ov.source;
    }
    else {
      try { M = this.model.cameraMatrix(camId); } catch (e) { M = null; }
      source = M ? `model.cameraMatrix(${camId})` : 'unresolved';
    }
    if (!M) return { ok: false, id: camId, name: cam.name, source: 'unresolved', intrinsics: cam.intrinsics };

    /* AS-INSTALLED CALIBRATION, applied AFTER the package/part matrix and in the camera's
       own axes: tilt about local +X (nose-DOWN positive, the mast convention), then roll
       about the tilted optical axis.  `design.cameras.<id>.calib` is the only input and it
       is never written back to a part parameter. */
    const cal = this.calibMode === 'installed' ? cam.calib : null;
    let calib = null;
    if (cal && (cal.tilt_deg || cal.roll_deg)) {
      M = M.clone();
      if (cal.tilt_deg) M.multiply(_calibM.makeRotationX(-cal.tilt_deg * D2R));
      if (cal.roll_deg) M.multiply(_calibM.makeRotationZ(cal.roll_deg * D2R));
      calib = { tilt_deg: cal.tilt_deg || 0, roll_deg: cal.roll_deg || 0 };
      source += ' + calib';
    }

    const root = asMatrix4(ctx.robotRoot);
    const world = root ? new THREE.Matrix4().multiplyMatrices(root, M) : M.clone();
    const right = new THREE.Vector3(), up = new THREE.Vector3(), back = new THREE.Vector3();
    M.extractBasis(right, up, back);
    const dir = back.clone().negate();
    const origin = new THREE.Vector3().setFromMatrixPosition(M);
    return {
      ok: true, id: camId, name: cam.name, label: cam.label, source,
      matrix: M, matrixRobot: M, matrixWorld: world,
      origin, dir, up, right,
      tilt_deg: -R2D * Math.asin(Math.max(-1, Math.min(1, dir.z))),   // + = nose-down
      calib, calib_mode: this.calibMode,
      hfov_deg: cam.hfov_deg, vfov_deg: cam.vfov_deg,
      aspect: cam.aspect, near: cam.near, far: cam.far,
      intrinsics: cam.intrinsics,
    };
  }

  /** Point a real THREE.PerspectiveCamera at this pose. */
  applyToCamera(camId, threeCamera, ctx = {}, frame = 'robot') {
    const pose = this.getPose(camId, ctx);
    if (!pose || !pose.ok || !threeCamera) return null;
    threeCamera.matrixAutoUpdate = false;
    threeCamera.matrix.copy(frame === 'world' ? pose.matrixWorld : pose.matrix);
    threeCamera.matrixWorldNeedsUpdate = true;
    threeCamera.aspect = pose.aspect;
    threeCamera.fov = pose.vfov_deg;
    threeCamera.near = pose.near;
    threeCamera.far = pose.far;
    threeCamera.updateProjectionMatrix();
    return pose;
  }

  /* --------------------------------------------------------------- project */
  /** Project a ROBOT-frame point.  u right-positive, v DOWN-positive, ±1. */
  project(camId, point, pose) {
    const P = pose && pose.ok ? pose : this.getPose(camId);
    const p = asVector3(point);
    if (!P || !P.ok || !p) return { in: false, u: 0, v: 0, ndc: [0, 0], dist: 0, behind: true };
    const rel = p.clone().sub(P.origin);
    const z = rel.dot(P.dir);
    const x = rel.dot(P.right);
    const y = rel.dot(P.up);
    if (!(z > 1e-9)) return { in: false, u: 0, v: 0, ndc: [0, 0], dist: rel.length(), behind: true, z };
    const th = Math.tan(P.hfov_deg * D2R / 2);
    const tv = Math.tan(P.vfov_deg * D2R / 2);
    const ndcX = (x / z) / th, ndcY = (y / z) / tv;
    return {
      in: Math.abs(ndcX) <= 1 && Math.abs(ndcY) <= 1 && z >= P.near,
      u: ndcX, v: -ndcY, ndc: [ndcX, ndcY], dist: rel.length(), z, behind: false,
    };
  }

  /* ------------------------------------------------------- ground footprint */
  /**
   * Up to four ground intersections of the frustum's corner rays, bottom-left,
   * bottom-right, top-right, top-left; `null` where the ray is above the
   * horizon.  `polygon` is always a drawable closed ring.
   */
  groundFootprint(camId, groundZ, opts = {}) {
    const P = opts.pose && opts.pose.ok ? opts.pose : this.getPose(camId, opts.ctx || {});
    const gz = Number.isFinite(groundZ) ? groundZ : this.groundZ;
    if (!P || !P.ok) return null;
    const maxRange = Number.isFinite(opts.maxRange) ? opts.maxRange : 3000;
    const steps = Math.max(1, (opts.steps | 0) || 6);
    const th = Math.tan(P.hfov_deg * D2R / 2), tv = Math.tan(P.vfov_deg * D2R / 2);
    const rayAt = (sx, sy) => P.dir.clone()
      .add(P.right.clone().multiplyScalar(sx * th))
      .add(P.up.clone().multiplyScalar(sy * tv)).normalize();
    const hit = (d) => {
      if (d.z >= -1e-9) return null;
      const t = (gz - P.origin.z) / d.z;
      if (!(t > 0) || t > 1e7) return null;
      return P.origin.clone().addScaledVector(d, t);
    };
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => hit(rayAt(sx, sy)));

    const border = [];
    const edge = (ax, ay, bx, by) => {
      for (let i = 0; i < steps; i++) { const t = i / steps; border.push([ax + (bx - ax) * t, ay + (by - ay) * t]); }
    };
    edge(-1, -1, 1, -1); edge(1, -1, 1, 1); edge(1, 1, -1, 1); edge(-1, 1, -1, -1);
    let horizon = false;
    const polygon = border.map(([sx, sy]) => {
      const d = rayAt(sx, sy);
      const h = hit(d);
      if (h && h.clone().sub(P.origin).length() <= maxRange) return h;
      horizon = true;
      const flat = new THREE.Vector3(d.x, d.y, 0);
      if (flat.lengthSq() < 1e-12) return P.origin.clone().setZ(gz);
      return P.origin.clone().addScaledVector(flat.normalize(), maxRange).setZ(gz);
    });
    let near = Infinity, far = 0, nearPt = null, farPt = null;
    for (const p of polygon) {
      const r = Math.hypot(p.x, p.y);
      if (r < near) { near = r; nearPt = p; }
      if (r > far) { far = r; farPt = p; }
    }
    return {
      id: camId, groundZ: gz, corners, polygon, horizon,
      near_mm: Number.isFinite(near) ? near : null, far_mm: far || null,
      near_point: nearPt, far_point: farPt, corner_count: corners.filter(Boolean).length,
    };
  }

  /* --------------------------------------------------------- reach-disc cov */
  /** Deterministic area sampling of the forward reachable ground disc — no RNG,
   *  so Node and the browser agree to the last digit. */
  reachDiscSamples(n = 48, ctx = {}) {
    const rd = ctx.reachDisc || this.reachDisc;
    const [cx, cy] = rd.centre || rd.center || [0, 0];
    const R = rd.radius || 300, yMin = Number.isFinite(rd.y_min) ? rd.y_min : -Infinity;
    const gz = Number.isFinite(ctx.groundZ) ? ctx.groundZ : this.groundZ;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const x = cx - R + (2 * R) * (i + 0.5) / n;
      for (let j = 0; j < n; j++) {
        const y = cy - R + (2 * R) * (j + 0.5) / n;
        if ((x - cx) ** 2 + (y - cy) ** 2 > R * R) continue;
        if (y < yMin) continue;
        pts.push(new THREE.Vector3(x, y, gz));
      }
    }
    return pts;
  }

  /* -------------------------------------------------------------- evaluate */
  /**
   * ID pass + framing metrics.  `ctx.renderer`, `ctx.scene` and `ctx.tag` are
   * injected; without them the geometric half still comes back and
   * `rendered` is false.
   */
  evaluate(camId, ctx = {}, opts = {}) {
    const cam = this.get(camId);
    const pose = this.getPose(camId, ctx);
    const out = {
      id: camId, name: cam ? cam.name : camId, ok: !!(pose && pose.ok), rendered: false,
      robot_pct: null, arm_pct: null, floor_pct: null, classes: {},
      reach_disc_pct: 0, reach_disc_in_frame_pct: 0,
      tip: null, props: [], pixels: 0,
      hfov_deg: cam ? cam.hfov_deg : null, pose,
    };
    if (!pose || !pose.ok) return out;

    const samples = this.reachDiscSamples(opts.reachSamples || 48, ctx);
    const inFrame = [];
    for (const p of samples) {
      const pr = this.project(camId, p, pose);
      if (pr.in) inFrame.push([p, pr]);
    }
    out.reach_disc_in_frame_pct = round2(samples.length ? 100 * inFrame.length / samples.length : 0);
    out.reach_disc_pct = out.reach_disc_in_frame_pct;
    out.reach_disc_samples = samples.length;

    const tipPt = asVector3(ctx.tip && ctx.tip.point ? ctx.tip.point : ctx.tip);
    if (tipPt) {
      const pr = this.project(camId, tipPt, pose);
      out.tip = { in: pr.in, u: round4(pr.u), v: round4(pr.v), ndc: [round4(pr.ndc[0]), round4(pr.ndc[1])], occluded: false, dist: pr.dist };
    }
    const props = Array.isArray(ctx.props) ? ctx.props : [];
    out.props = props.map((pp) => {
      const pt = asVector3(pp.point || pp.position || pp.centre || pp.at);
      const pr = pt ? this.project(camId, pt, pose) : { in: false, u: 0, v: 0, ndc: [0, 0], dist: 0 };
      return { id: pp.id, in: pr.in, u: round4(pr.u), v: round4(pr.v), ndc: [round4(pr.ndc[0]), round4(pr.ndc[1])], occluded: false, dist: pr.dist };
    });

    const renderer = ctx.renderer, scene = ctx.scene, tag = ctx.tag;
    if (!renderer || !scene || typeof tag !== 'function') return out;

    const w = Math.max(8, opts.width || this.idPass.width || 160);
    const h = Math.max(8, opts.height || this.idPass.height || 120);
    let buf;
    try { buf = this._renderIdPass(camId, ctx, pose, w, h); }
    catch (err) { out.error = String((err && err.message) || err); return out; }
    if (!buf) return out;
    out.rendered = true;
    out.pixels = w * h;
    out.id_pass = { width: w, height: h };
    out.self_parts = this.selfParts(camId);

    const counts = new Map();
    for (let i = 0; i < w * h; i++) {
      const cls = this._classAt(buf, i * 4);
      counts.set(cls, (counts.get(cls) || 0) + 1);
    }
    let robot = 0, arm = 0, floor = 0;
    for (const [cls, n] of counts) {
      out.classes[cls] = round2(100 * n / (w * h));
      if (this.robotClasses.includes(cls)) robot += n;
      if (cls === 'arm' || cls === 'gripper') arm += n;
      if (cls === 'floor') floor += n;
    }
    out.robot_pct = round2(100 * robot / (w * h));
    out.arm_pct = round2(100 * arm / (w * h));
    out.floor_pct = round2(100 * floor / (w * h));

    const classAtUv = (u, v) => this._classAtUv(buf, w, h, u, v);
    if (out.tip && out.tip.in) {
      const want = ctx.tipClass || 'gripper';
      const seen = classAtUv(out.tip.u, out.tip.v);
      out.tip.occluded = !(seen.has(want) || seen.has('arm'));
      out.tip.class_at = [...seen][0] || 'background';
    }
    for (let i = 0; i < out.props.length; i++) {
      const pp = out.props[i], spec = props[i];
      if (!pp.in) continue;
      const want = spec.class || ('prop-' + spec.id);
      const seen = classAtUv(pp.u, pp.v);
      pp.occluded = !seen.has(want);
      pp.class_at = [...seen][0] || 'background';
    }
    if (inFrame.length) {
      let seen = 0;
      for (const [, pr] of inFrame) if (classAtUv(pr.u, pr.v).has(ctx.floorClass || 'floor')) seen++;
      out.reach_disc_pct = round2(100 * seen / samples.length);
    }
    return out;
  }

  verdict(ev, opts) { return verdict(ev, { ...opts, warn: this.warn }); }

  /**
   * Where the ROBOT sits inside a camera's frame, as the ID pass sees it:
   * `{u, v}` in 0…1 from the top-left, plus the pixel count that produced them.
   *
   * The mast and the base are symmetric about X = 0, so at a symmetric pose the top
   * camera's `u` is 0.5 by construction — the cheapest possible test that the render path
   * has not cropped, offset or scaled the frame.
   * @returns {{ok, u, v, pixels, robot_pct, width, height}|null}
   */
  idCentroid(camId, ctx = {}, opts = {}) {
    const pose = this.getPose(camId, ctx);
    if (!pose || !pose.ok || !ctx.renderer || !ctx.scene || typeof ctx.tag !== 'function') return null;
    const w = Math.max(8, opts.width || this.idPass.width || 160);
    const h = Math.max(8, opts.height || this.idPass.height || 120);
    let buf;
    try { buf = this._renderIdPass(camId, ctx, pose, w, h); } catch (e) { return null; }
    if (!buf) return null;
    const want = new Set(opts.classes || this.robotClasses);
    let n = 0, sx = 0, sy = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        /* readRenderTargetPixels counts rows from the BOTTOM, so flip into image order */
        const i = ((h - 1 - y) * w + x) * 4;
        if (!want.has(this._classAt(buf, i))) continue;
        n++; sx += x + 0.5; sy += y + 0.5;
      }
    }
    if (!n) return { ok: false, u: null, v: null, pixels: 0, robot_pct: 0, width: w, height: h };
    return { ok: true, u: round4(sx / n / w), v: round4(sy / n / h), pixels: n,
      robot_pct: round2(100 * n / (w * h)), width: w, height: h };
  }

  /* --------------------------------------------------------------- internals */
  _colorFor(cls) {
    if (this._classColor.has(cls)) return this._classColor.get(cls);
    const c = SPARE_COLORS[this._spare++ % SPARE_COLORS.length];
    this._classColor.set(cls, c);
    this._lut = null;
    return c;
  }
  _materialFor(cls) {
    if (this._mat.has(cls)) return this._mat.get(cls);
    const [r, g, b] = this._colorFor(cls);
    const m = new THREE.MeshBasicMaterial({
      side: THREE.DoubleSide, fog: false, toneMapped: false,
      transparent: false, depthWrite: true, depthTest: true,
    });
    m.color.setRGB(r / 255, g / 255, b / 255);
    this._mat.set(cls, m);
    return m;
  }
  _classAt(buf, o) {
    const r = buf[o], g = buf[o + 1], b = buf[o + 2];
    const key = (r << 16) | (g << 8) | b;
    if (!this._lut) this._lut = new Map();
    const hit = this._lut.get(key);
    if (hit !== undefined) return hit;
    let best = 'background', bd = Infinity;
    for (const [cls, c] of this._classColor) {
      const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
      if (d < bd) { bd = d; best = cls; }
    }
    const res = bd <= 60 * 60 ? best : 'background';
    this._lut.set(key, res);
    return res;
  }
  _classAtUv(buf, w, h, u, v) {
    const px = Math.round((u + 1) / 2 * (w - 1));
    const py = Math.round((v + 1) / 2 * (h - 1));
    const set = new Set();
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = px + dx, y = py + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      set.add(this._classAt(buf, ((h - 1 - y) * w + x) * 4));
    }
    return set;
  }
  _perspective(camId, pose) {
    let c = this._threeCam.get(camId);
    if (!c) { c = new THREE.PerspectiveCamera(50, 4 / 3, 1, 9000); c.matrixAutoUpdate = false; this._threeCam.set(camId, c); }
    c.fov = pose.vfov_deg; c.aspect = pose.aspect; c.near = pose.near; c.far = pose.far;
    c.updateProjectionMatrix();
    const M = pose.matrixWorld || pose.matrix;
    c.matrix.copy(M); c.matrixWorld.copy(M);
    c.matrixWorldInverse.copy(M).invert();
    c.matrixWorldNeedsUpdate = false;
    return c;
  }
  _renderIdPass(camId, ctx, pose, w, h) {
    const renderer = ctx.renderer, scene = ctx.scene, tag = ctx.tag;
    if (!this._rt || this._rt.width !== w || this._rt.height !== h) {
      if (this._rt) this._rt.dispose();
      this._rt = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        depthBuffer: true, stencilBuffer: false, generateMipmaps: false,
      });
      if ('colorSpace' in this._rt.texture) this._rt.texture.colorSpace = THREE.NoColorSpace;
      this._pixels = new Uint8Array(w * h * 4);
    }
    const cam = this._perspective(camId, pose);
    const own = this._selfParts.get(camId);
    const swapped = [], hidden = [];
    scene.traverse((o) => {
      if (o.isLine || o.isPoints || o.isSprite) { if (o.visible) { hidden.push(o); o.visible = false; } return; }
      if (!(o.isMesh || o.isSkinnedMesh || o.isInstancedMesh)) return;
      /* this camera's own mount: the bore, not the scene (see setSelfParts) */
      if (own && o.userData && own.has(o.userData.componentId)) {
        if (o.visible) { hidden.push(o); o.visible = false; }
        return;
      }
      let cls = null;
      try { cls = tag(o); } catch (e) { cls = null; }
      if (!cls) { if (o.visible) { hidden.push(o); o.visible = false; } return; }
      swapped.push([o, o.material]);
      o.material = this._materialFor(String(cls));
    });
    const prevTarget = renderer.getRenderTarget();
    const prevClear = new THREE.Color(); renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();
    const prevTone = renderer.toneMapping;
    const prevCS = renderer.outputColorSpace;
    const prevScissor = renderer.getScissorTest();
    const prevAutoClear = renderer.autoClear;
    const prevBg = scene.background, prevFog = scene.fog, prevOverride = scene.overrideMaterial;
    const prevView = renderer.getViewport ? renderer.getViewport(new THREE.Vector4()) : null;
    try {
      scene.background = null; scene.fog = null; scene.overrideMaterial = null;
      renderer.setScissorTest(false);
      renderer.autoClear = true;
      renderer.toneMapping = THREE.NoToneMapping;
      if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
      /* no setViewport: it is in CSS px and three scales it by the pixel ratio, while `this._rt` is
         sized in device px; `setRenderTarget()` takes the viewport from `_rt.viewport` */
      renderer.setRenderTarget(this._rt);
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, true, true);
      renderer.render(scene, cam);
      renderer.readRenderTargetPixels(this._rt, 0, 0, w, h, this._pixels);
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClear, prevAlpha);
      renderer.toneMapping = prevTone;
      if ('outputColorSpace' in renderer) renderer.outputColorSpace = prevCS;
      renderer.setScissorTest(prevScissor);
      renderer.autoClear = prevAutoClear;
      if (prevView) renderer.setViewport(prevView);      // CSS px again, for the canvas
      scene.background = prevBg; scene.fog = prevFog; scene.overrideMaterial = prevOverride;
      for (const [o, m] of swapped) o.material = m;
      for (const o of hidden) o.visible = true;
    }
    return this._pixels;
  }
  dispose() {
    if (this._rt) { this._rt.dispose(); this._rt = null; }
    for (const m of this._mat.values()) m.dispose();
    this._mat.clear();
  }
}

/** `manifest.cameras` of the root package and of every attachment, by qualified id */
function rawCameraSpecs(model) {
  const out = {};
  for (const c of (model.manifest && model.manifest.cameras) || []) out[c.id] = c;
  for (const a of model.attachments || []) {
    for (const c of (a.model.manifest && a.model.manifest.cameras) || []) out[a.id + '/' + c.id] = c;
  }
  return out;
}

function readReachDisc(model) {
  try {
    const d = model.frameData('reach_disc');
    if (d && (d.radius || d.centre || d.center)) return d;
  } catch (e) { /* not in this package */ }
  try {
    const pan = model.frameData('pan_axis');
    if (Array.isArray(pan)) return { centre: [pan[0], pan[1]], radius: 300, y_min: pan[1] + 33 };
  } catch (e) { /* nothing */ }
  return CAMERA_DEFAULTS.reach_disc;
}

/** Build the registry from a RobotModel. */
export function createCameras(model, opts) { return new Cameras(model, opts); }

export { adoptSlotOption, adoptAllSlotOptions } from './camera-options.js';

const round2 = (v) => Math.round(v * 100) / 100;
const round4 = (v) => Math.round(v * 10000) / 10000;
