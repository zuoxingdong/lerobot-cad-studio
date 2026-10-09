/* RobotModel: the kinematic and component model of a robot package.  Pure maths — no scene
   graph, no DOM, no renderer (three supplies Matrix4/Vector3/Box3 as data types only).
   Needs three and core/manifest.js + core/urdf-manifest.js. */

import * as THREE from 'three';
import {
  ROBOT_SCHEMA, DEG, RAD, LINK_FRAMES, MOVING, isFiniteNum,
  withLimits, withSlot, qualify, qualifyJoint, COMPONENT_GROUPS, validateManifest
} from './manifest.js';
import { manifestFromURDF } from './urdf-manifest.js';

export { ROBOT_SCHEMA, COMPONENT_GROUPS, validateManifest, manifestFromURDF };

/* ------------------------------------------------------------------ small helpers -- */

/** A THREE.Matrix4 from a 16-number column-major array, `null`/undefined → identity. */
export function mat4(a) {
  const m = new THREE.Matrix4();
  if (Array.isArray(a) && a.length === 16) m.fromArray(a);
  else if (a && a.isMatrix4) m.copy(a);
  return m;
}

/** Largest absolute element-wise difference between two Matrix4 — the tolerance metric. */
export function matrixMaxDiff(a, b) {
  let e = 0;
  for (let i = 0; i < 16; i++) e = Math.max(e, Math.abs(a.elements[i] - b.elements[i]));
  return e;
}

/** Trans(xyz) · Rot(rpy, ZYX) — the URDF <origin> convention. xyz is used verbatim. */
function originMatrix(xyz, rpy) {
  const e = new THREE.Euler((rpy && rpy[0]) || 0, (rpy && rpy[1]) || 0, (rpy && rpy[2]) || 0, 'ZYX');
  const M = new THREE.Matrix4().makeRotationFromEuler(e);
  M.setPosition((xyz && xyz[0]) || 0, (xyz && xyz[1]) || 0, (xyz && xyz[2]) || 0);
  return M;
}

/* ------------------------------------------------------------------ joint records -- */

/**
 * One joint, normalised.
 * `xyz` is ALWAYS in millimetres on this record (the manifest may store metres — see
 * `kinematics.units`); `rpy` is radians; `limits` is degrees (mm for prismatic).
 */
class Joint {
  constructor(raw, scale) {
    this.name = raw.name;
    this.type = raw.type || 'fixed';
    this.parent = raw.parent;
    this.child = raw.child;
    const xyz = raw.xyz || [0, 0, 0];
    this.xyz = [xyz[0] * scale, xyz[1] * scale, xyz[2] * scale];
    this.rpy = (raw.rpy || [0, 0, 0]).slice();
    const ax = raw.axis || [0, 0, 1];
    const v = new THREE.Vector3(ax[0], ax[1], ax[2]);
    if (v.lengthSq() < 1e-12) v.set(0, 0, 1);
    v.normalize();
    this.axis = [v.x, v.y, v.z];
    this.limits = raw.limits || null;           // {lower, upper} in DEGREES, or null
    this.mimic = raw.mimic || null;             // {joint, multiplier, offset}
    this._origin = originMatrix(this.xyz, this.rpy);
    this._axis = v;
  }
  get moving() { return MOVING.has(this.type); }
  /** A mimic joint is DERIVED: its value comes from another joint, never from the caller. */
  get derived() { return !!this.mimic; }
  /** True when the caller may set this joint. */
  get settable() { return this.moving && !this.mimic; }
  /** T(q) for this joint; q in DEGREES for revolute/continuous, MILLIMETRES for prismatic. */
  matrix(q) {
    const M = this._origin.clone();
    if (!this.moving || !q) return M;
    if (this.type === 'prismatic') {
      M.multiply(new THREE.Matrix4().makeTranslation(this._axis.x * q, this._axis.y * q, this._axis.z * q));
    } else {
      const quat = new THREE.Quaternion().setFromAxisAngle(this._axis, q * DEG);
      M.multiply(new THREE.Matrix4().makeRotationFromQuaternion(quat));
    }
    return M;
  }
  toJSON() {
    return {
      name: this.name, type: this.type, parent: this.parent, child: this.child,
      xyz: this.xyz.slice(), rpy: this.rpy.slice(), axis: this.axis.slice(),
      limits: this.limits ? { ...this.limits } : null,
      mimic: this.mimic ? { ...this.mimic } : null
    };
  }
}

/* components */

/**
 * One drawable / printable piece.  `geometry` is a THREE.BufferGeometry SHARED between
 * instances of the same mesh (never mutate it — place it with `worldMatrix(id)`).
 */
class Component {
  constructor(raw, owner) {
    this.id = raw.id;
    this.localId = raw.id;
    this.label = raw.label || raw.id;
    this.link = raw.link || null;
    this.group = raw.group || 'imported';
    this.slot = raw.slot || null;
    this.frame = raw.frame || (raw.link ? 'link' : 'robot');
    this.local = mat4(raw.local);
    this.color = raw.color || '#9aa3ad';
    this.printable = raw.printable === true;
    this.print_source = raw.print_source || raw.print_file || null;
    /* THE BED ORIENTATION THE PACKAGE SHIPS.  A plate (`print/<part>_PRINT.stl`) is the
       robot-frame mesh beside it RIGIDLY MOVED, so a package states that move as 16 numbers
       instead of a second copy of the geometry: `print_transform` is robot frame -> bed, and
       `print_name` is the file the plate is called, so an export of a promoted workspace
       alternative still writes `head_PRINT.stl`.  `validate.geometryOf()` print-checks in
       exactly this orientation. */
    this.printTransform = raw.print_transform ? mat4(raw.print_transform) : null;
    this.printName = raw.print_name || null;
    /* the extents trimesh measured on that plate FILE at build time — what an exported
       plate's footprint is held against (`tools/build/make_robots.py plate_transform`) */
    this.printBbox = Array.isArray(raw.print_bbox_mm) ? raw.print_bbox_mm.slice() : null;
    /* set when the package names a print file that is NOT a rigid image of this mesh, so
       the package states no bed pose and says why rather than claiming one */
    this.printFitNote = raw.print_fit_note || null;
    this.mesh = raw.mesh || raw.mesh_ref || null;     // the geometry key
    this.source = raw.source || null;
    /* `hidden_by_default` is what the packs write (a slot alternative that is not the
       chosen option); `hidden` is accepted as the shorter synonym. */
    this.visible = !(raw.hidden_by_default || raw.hidden);
    /* the PACKAGE's answer, kept because `visible` is live state the page writes back on
       every visibility pass — a design that carries no override for this component (a
       stock link the user hid, deleted and then restored) has to fall back to the package,
       not to whatever the last pass happened to leave behind. */
    this.defaultVisible = this.visible;
    this.stockRemoved = !!raw.stock_removed;
    this.faces = isFiniteNum(raw.faces) ? raw.faces : null;
    this.geometry = null;
    this.owner = owner;
    this.note = raw.note || null;
  }
}

/* cameras */

class Camera {
  constructor(raw, owner) {
    this.id = raw.id;
    this.localId = raw.id;
    this.label = raw.label || raw.id;
    this.link = raw.link || null;
    /* `frame` uses the SAME vocabulary as a component — "link"/"mesh" (posed through
       `link`) or "robot" (baked) — and anything else is read as the name of a declared
       frame, so a camera can also hang off `cam_top_corner` or `wrist_flange`. */
    this.frame = raw.frame || (raw.link ? 'link' : 'robot');
    this.namedFrame = (this.frame === 'robot' || LINK_FRAMES.has(this.frame)) ? null : this.frame;
    this.local = mat4(raw.local);
    /* Is this camera a MOUNT, or only a DEVICE?  A package that poses its cameras from the
       slot options declares the lens, the intrinsics and the name here and NO mount.
       `mat4(undefined)` is the identity, so such a camera would otherwise answer "the robot
       origin, pointing along -Z"; `cameraMatrix()` answers null instead and only the fitted
       option can pose it. */
    this.posed = raw.local != null || raw.link != null || !!this.namedFrame;
    this.hfov = isFiniteNum(raw.hfov_deg) ? raw.hfov_deg : 70;
    this.aspect = isFiniteNum(raw.aspect) ? raw.aspect : 4 / 3;
    this.near = isFiniteNum(raw.near) ? raw.near : 5;
    this.far = isFiniteNum(raw.far) ? raw.far : 6000;
    this.source = raw.source || null;
    this.owner = owner;
  }
  get hfov_deg() { return this.hfov; }
}

/* RobotModel */

export class RobotModel {
  /**
   * Build from a resolved `rps/robot@1` manifest.
   * @param {object} manifest
   * @param {(meshKey:string, component:object)=>(THREE.BufferGeometry|Promise<THREE.BufferGeometry>|null)} [geometryLoader]
   * @param {{strict?:boolean}} [opts]
   */
  static fromPackage(manifest, geometryLoader = null, opts = {}) {
    const report = validateManifest(manifest);
    if (!report.ok && opts.strict !== false) {
      throw new Error('robot-model: invalid manifest — ' + report.errors.join('; '));
    }
    return new RobotModel(manifest, geometryLoader, report);
  }

  /**
   * Build from `urdf-loader` output.  Generates the equivalent `rps/robot@1` manifest
   * (available afterwards as `model.manifest`) and an in-memory geometry map, so a URDF
   * import and a package import go through exactly the same code path.
   * @param {object} urdfRobot  a URDFRobot (the object urdf-loader's parse/load returns)
   * @param {{id?:string,name?:string,source?:object,group?:(linkName:string)=>string,
   *          color?:string, printable?:boolean}} [options]
   */
  static fromURDF(urdfRobot, options = {}) {
    const { manifest, geometries } = manifestFromURDF(urdfRobot, options);
    return new RobotModel(manifest, (key) => geometries.get(key) || null, validateManifest(manifest));
  }

  constructor(manifest, geometryLoader, report) {
    this.schema = manifest.schema || ROBOT_SCHEMA;
    this.id = manifest.id;
    this.name = manifest.name || manifest.id;
    this.version = manifest.version || null;
    this.manifest = manifest;
    this.report = report || { ok: true, errors: [], warnings: [] };
    this.units = manifest.units || 'mm';
    this.up = manifest.up || 'z';
    this.source = manifest.source || null;
    this.thumbnail = manifest.thumbnail || null;
    this.groundZ = (manifest.frame && isFiniteNum(manifest.frame.ground_z)) ? manifest.frame.ground_z : 0;

    /* ---- the BASE POSE: where this robot stands in the world
       The kinematic chain answers in the ROBOT frame.  A driven mobile base moves the
       whole robot frame through the world, and that is a property of the DESIGN
       (`design.base`), not of the renderer: collision, IK targets, camera
       frustums and the combined export all have to speak one frame or the floor moves
       with the robot.  `setBasePose()` is the only place it enters, and every public
       matrix accessor below carries it. */
    this.basePose = { x: 0, y: 0, yaw: 0 };
    this._base = null;               // null = identity, so the common case costs nothing
    this.baseStamp = 0;              // bumped on every change, for caches keyed on the pose

    this._geometryLoader = geometryLoader || null;
    this._geomCache = new Map();      // mesh key -> BufferGeometry (shared across instances)

    /* kinematics */
    const K = manifest.kinematics || {};
    /* joint <origin xyz> units: the URDF convention is metres, a hand-written package may
       already be in mm.  `kinematics.units` (or `urdf_units`, which the LeKiwi package writes
       next to `mesh_units`) says which; default "m", i.e. ×1000 into robot mm. */
    const kUnits = K.units || K.urdf_units || 'm';
    const scale = (kUnits === 'mm') ? 1 : 1000;
    this.rootLink = K.root_link || null;
    this.ownJoints = (K.joints || []).map((j) => new Joint(withLimits(j, K.joint_limits_deg), scale));
    this._jointByName = new Map(this.ownJoints.map((j) => [j.name, j]));
    this.jointOrder = (K.joint_order || this.ownJoints.filter((j) => j.moving).map((j) => j.name)).slice();
    this.limitsSource = K.joint_limits_source || null;
    this.zeroPoseNote = K.zero_pose_note || null;

    /* link table: name -> {name, parentJoint, parentLink, children[]} */
    this.ownLinks = [];
    this._linkInfo = new Map();
    const ensure = (name) => {
      let rec = this._linkInfo.get(name);
      if (!rec) {
        rec = { name, parentJoint: null, parentLink: null, children: [] };
        this._linkInfo.set(name, rec);
        this.ownLinks.push(name);
      }
      return rec;
    };
    if (this.rootLink) ensure(this.rootLink);
    for (const j of this.ownJoints) {
      const p = ensure(j.parent), c = ensure(j.child);
      c.parentJoint = j; c.parentLink = j.parent;
      p.children.push(c.name);
    }
    if (!this.rootLink && this.ownLinks.length) {
      const r = this.ownLinks.find((n) => !this._linkInfo.get(n).parentJoint);
      this.rootLink = r || this.ownLinks[0];
    }

    /* pose state */
    /* joint name -> value (degrees, or mm for prismatic).  Only SETTABLE joints have an
       entry; a mimic joint's value is derived from its source on every read. */
    this._q = Object.create(null);
    for (const j of this.ownJoints) if (j.settable) this._q[j.name] = 0;
    const zp = K.zero_pose_deg || null;
    if (zp) for (const k of Object.keys(zp)) if (k in this._q) this._q[k] = zp[k];
    this._zero = { ...this._q };          // control joints only, by construction
    this._poses = null;                      // link -> Matrix4 (robot mm), lazily built

    /* components */
    this.ownComponents = (manifest.components || []).map((c) => new Component(withSlot(c, manifest.slots), this));
    /* cameras */
    this.ownCameras = (manifest.cameras || []).map((c) => new Camera(c, this));
    /* frames (spec only; matrices are computed on demand) */
    this.ownFrames = { ...(manifest.frames || {}) };
    /* slots (pass-through for features/slots.js) */
    this.slots = manifest.slots || {};

    /* composition */
    this.attachments = [];      // [{id, model, frame, local: Matrix4}]
    this.parent = null;         // the attachment record that holds THIS model, if attached
    this._flatten();
    this._loadGeometriesSync();
  }

  /* flattened views */

  /** Rebuild `components` / `cameras` / `joints` / `links` / `frames` across attachments. */
  _flatten() {
    const comps = this.ownComponents.slice();
    const cams = this.ownCameras.slice();
    const joints = this.ownJoints.slice();
    const links = this.ownLinks.slice();
    for (const a of this.attachments) {
      for (const c of a.model.components) comps.push(qualify(c, a.id, 'id'));
      for (const c of a.model.cameras) cams.push(qualify(c, a.id, 'id'));
      for (const j of a.model.joints) joints.push(qualifyJoint(j, a.id));
      for (const l of a.model.links) links.push(a.id + '/' + l);
    }
    this.components = comps;
    this.cameras = cams;
    this.joints = joints;
    this.links = links;
    this._byId = new Map(comps.map((c) => [c.id, c]));
    this._camById = new Map(cams.map((c) => [c.id, c]));
    this._jointById = new Map(joints.map((j) => [j.name, j]));
    this.frames = buildFrameGetters(this);
    if (this.parent) this.parent.owner._flatten();
    return this;
  }

  /* geometry */

  _loadGeometriesSync() {
    if (!this._geometryLoader) return;
    for (const c of this.ownComponents) {
      if (!c.mesh || c.geometry) continue;
      const cached = this._geomCache.get(c.mesh);
      if (cached) { c.geometry = cached; continue; }
      let g = null;
      try { g = this._geometryLoader(c.mesh, c); } catch (e) { g = null; }
      if (g && !g.then) { this._geomCache.set(c.mesh, g); c.geometry = g; }
    }
  }

  /** Geometry for one component (shared between instances). Async-safe. */
  async geometryFor(componentId) {
    const c = this._byId.get(componentId);
    if (!c) throw new Error('robot-model: unknown component "' + componentId + '"');
    if (c.owner !== this) return c.owner.geometryFor(c.localId);
    if (c.geometry) return c.geometry;
    if (!c.mesh || !this._geometryLoader) return null;
    const cached = this._geomCache.get(c.mesh);
    if (cached) { c.geometry = cached; return cached; }
    const g = await this._geometryLoader(c.mesh, c);
    if (g) { this._geomCache.set(c.mesh, g); c.geometry = g; }
    return g || null;
  }

  /** The package's own mesh for a component, whatever a rebuild or an edit drew since. */
  packageGeometry(componentId) {
    const c = this._byId.get(componentId);
    if (!c) return null;
    if (c.owner !== this) return c.owner.packageGeometry(c.localId);
    return (c.mesh && this._geomCache.get(c.mesh)) || null;
  }

  /** Load every component's geometry (deduplicated). onProgress(done, total, meshKey). */
  async loadGeometries(onProgress) {
    const own = this.ownComponents.filter((c) => c.mesh && !c.geometry);
    const keys = [...new Set(own.map((c) => c.mesh))];
    let done = 0;
    for (const key of keys) {
      const c = own.find((x) => x.mesh === key);
      // eslint-disable-next-line no-await-in-loop
      await this.geometryFor(c.id);
      done += 1;
      if (onProgress) onProgress(done, keys.length, key);
    }
    for (const c of own) if (!c.geometry) c.geometry = this._geomCache.get(c.mesh) || null;
    for (const a of this.attachments) await a.model.loadGeometries();   // eslint-disable-line no-await-in-loop
    return this;
  }

  /* pose */

  /**
   * Set joint values, in DEGREES.  Names may be qualified (`pincopen/jaw`) or plain when
   * unambiguous.  Unknown names are ignored (and reported in `lastUnknownJoints`).
   * @param {Object<string,number>} q
   * @returns {this}
   */
  setJoints(q) {
    const unknown = [], derived = [];
    for (const key of Object.keys(q || {})) {
      const v = q[key];
      if (!isFiniteNum(v)) { unknown.push(key); continue; }
      const r = this._setOneJoint(key, v);
      if (r === 'derived') derived.push(key);
      else if (!r) unknown.push(key);
    }
    this.lastUnknownJoints = unknown;
    this.lastDerivedJoints = derived;
    return this;
  }

  /** @returns {true|false|'derived'} */
  _setOneJoint(key, value) {
    const slash = key.indexOf('/');
    if (slash > 0) {
      const a = this.attachments.find((x) => x.id === key.slice(0, slash));
      if (a) return a.model._setOneJoint(key.slice(slash + 1), value);
    }
    const j = this._jointByName.get(key);
    if (j) {
      if (j.derived) return 'derived';         // a mimic joint follows its source, always
      if (!j.moving) return false;             // fixed joint: nothing to set
      this._q[key] = value;
      this._invalidate();
      return true;
    }
    for (const a of this.attachments) {
      const r = a.model._setOneJoint(key, value);
      if (r) return r;
    }
    return false;
  }

  /**
   * The CONTROL joints, qualified — the ones a slider or a design may set.  A `mimic`
   * joint is derived from another and is deliberately not here.
   * @returns {string[]}
   */
  controlJoints() {
    const out = [];
    for (const j of this.ownJoints) if (j.settable) out.push(j.name);
    for (const a of this.attachments) for (const n of a.model.controlJoints()) out.push(a.id + '/' + n);
    return out;
  }

  /**
   * Current CONTROL joint values (degrees; millimetres for a prismatic joint), keys
   * qualified the same way `joints` are.  Safe to store in a design and hand back to
   * `setJoints`.
   */
  getJoints() {
    const out = {};
    for (const j of this.ownJoints) if (j.settable) out[j.name] = this._q[j.name] || 0;
    for (const a of this.attachments) {
      const sub = a.model.getJoints();
      for (const k of Object.keys(sub)) out[a.id + '/' + k] = sub[k];
    }
    return out;
  }

  /** The DERIVED (mimic) joints and the values they currently hold. Read-only. */
  derivedJoints() {
    const out = {};
    for (const j of this.ownJoints) if (j.derived) out[j.name] = this._jointValue(j);
    for (const a of this.attachments) {
      const sub = a.model.derivedJoints();
      for (const k of Object.keys(sub)) out[a.id + '/' + k] = sub[k];
    }
    return out;
  }

  /** The effective value of ANY moving joint, mimic resolved. */
  jointValue(name) {
    const slash = name.indexOf('/');
    if (slash > 0) {
      const a = this.attachments.find((x) => x.id === name.slice(0, slash));
      if (a) return a.model.jointValue(name.slice(slash + 1));
    }
    const j = this._jointByName.get(name);
    return j ? this._jointValue(j) : 0;
  }

  /**
   * {name: {lower, upper, type, units}} for the CONTROL joints only — degrees for a
   * revolute/continuous joint, millimetres for a prismatic one; lower/upper are null when
   * unconstrained.  Mimic joints are excluded: their travel follows their source.
   */
  jointLimits() {
    const out = {};
    for (const j of this.ownJoints) {
      if (!j.settable) continue;
      out[j.name] = {
        type: j.type,
        units: j.type === 'prismatic' ? 'mm' : 'deg',
        lower: j.limits && isFiniteNum(j.limits.lower) ? j.limits.lower : null,
        upper: j.limits && isFiniteNum(j.limits.upper) ? j.limits.upper : null
      };
    }
    for (const a of this.attachments) {
      const sub = a.model.jointLimits();
      for (const k of Object.keys(sub)) out[a.id + '/' + k] = sub[k];
    }
    return out;
  }

  /** The package's zero pose as a joint map (does NOT apply it — pass it to setJoints). */
  zeroPose() {
    const out = { ...this._zero };
    for (const a of this.attachments) {
      const sub = a.model.zeroPose();
      for (const k of Object.keys(sub)) out[a.id + '/' + k] = sub[k];
    }
    return out;
  }

  /**
   * Clamp a joint map to `jointLimits()`.  Returns a new map holding only CONTROL joints —
   * the result is meant to go straight back into `setJoints`, and a derived joint cannot be
   * set, so it is dropped rather than silently ignored later.
   */
  clampPose(q) {
    const lim = this.jointLimits();
    const out = {};
    for (const k of Object.keys(q || {})) {
      const L = lim[k];
      if (!L) continue;                       // unknown or derived: not settable
      let v = q[k];
      if (isFiniteNum(L.lower) && v < L.lower) v = L.lower;
      if (isFiniteNum(L.upper) && v > L.upper) v = L.upper;
      out[k] = v;
    }
    return out;
  }

  _invalidate() {
    this._poses = null;
    if (this.parent) this.parent.owner._invalidate();
  }

  _computePoses() {
    const P = Object.create(null);
    if (!this.rootLink) return P;
    P[this.rootLink] = new THREE.Matrix4();
    const joints = this.ownJoints;
    for (let pass = 0; pass < joints.length + 2; pass++) {
      let moved = false;
      for (const j of joints) {
        if (P[j.parent] && !P[j.child]) {
          P[j.child] = new THREE.Matrix4().multiplyMatrices(P[j.parent], j.matrix(this._jointValue(j)));
          moved = true;
        }
      }
      if (!moved) break;
    }
    return P;
  }

  /**
   * URDF <mimic>: q_child = multiplier · q_source + offset.  Chains are followed (a mimic
   * of a mimic) with a depth cap, so a cycle degrades to 0 instead of hanging.
   * Units follow the CHILD: a prismatic jaw finger mimicking a revolute jaw has a
   * multiplier in mm/deg, which is exactly what URDF means by it.
   */
  _jointValue(j, depth = 0) {
    if (!j.mimic) return this._q[j.name] || 0;
    if (depth > 8) return 0;
    const src = this._jointByName.get(j.mimic.joint);
    const q = src ? this._jointValue(src, depth + 1) : 0;
    return q * (isFiniteNum(j.mimic.multiplier) ? j.mimic.multiplier : 1) + (j.mimic.offset || 0);
  }

  /**
   * Forward kinematics of a link, in ROBOT MILLIMETRES, at the current pose.
   * Accepts a qualified name (`pincopen/jaw_left`) on a composed model, in which case the
   * result is in the ROOT model's frame (attachment included).
   * @returns {THREE.Matrix4} a fresh matrix (safe to mutate)
   */
  fk(link) { return this._withBase(this._fk(link)); }

  /** `fk` without the base pose — what every internal composition uses. */
  _fk(link) {
    if (!link) return new THREE.Matrix4();
    const slash = link.indexOf('/');
    if (slash > 0) {
      const a = this.attachments.find((x) => x.id === link.slice(0, slash));
      if (a) return new THREE.Matrix4().multiplyMatrices(this._attachMatrix(a.id), a.model._fk(link.slice(slash + 1)));
    }
    if (!this._poses) this._poses = this._computePoses();
    const M = this._poses[link];
    return M ? M.clone() : new THREE.Matrix4();
  }

  /* base pose */

  /**
   * Where this robot's own frame stands in the WORLD: a planar pose (mm, degrees).
   *
   * The base pose is part of the DESIGN (`design.base`, undo-safe) and enters the maths
   * exactly here, not in the renderer's `robotRoot` — there only the picture would move,
   * while collision and the camera frustums answered in the un-driven frame.
   * So every matrix this
   * class hands out — `fk`, `frameMatrix`, `worldMatrix`, `cameraMatrix`, `attachMatrix`,
   * `boundingBox` — is in the world frame and they cannot disagree.
   *
   * Only the ROOT model carries one; an attached package is placed by its attachment.
   * @param {{x?:number, y?:number, yaw?:number}|null} pose  mm, mm, degrees about +Z
   * @returns {RobotModel} this
   */
  setBasePose(pose) {
    const x = isFiniteNum(pose && pose.x) ? pose.x : 0;
    const y = isFiniteNum(pose && pose.y) ? pose.y : 0;
    const yaw = isFiniteNum(pose && pose.yaw) ? pose.yaw : 0;
    if (x === this.basePose.x && y === this.basePose.y && yaw === this.basePose.yaw && this.baseStamp) return this;
    this.basePose = { x, y, yaw };
    if (x === 0 && y === 0 && yaw === 0) this._base = null;
    else {
      const M = new THREE.Matrix4().makeRotationZ(yaw * DEG);
      M.setPosition(x, y, 0);
      this._base = M;
    }
    this.baseStamp++;
    return this;
  }

  /** The base pose as a matrix (identity when the robot stands at the origin). */
  baseMatrix() { return this._base ? this._base.clone() : new THREE.Matrix4(); }

  /** `M` carried into the world frame.  Cheap and allocation-free when there is no base. */
  _withBase(M) {
    if (!this._base || !M) return M;
    return new THREE.Matrix4().multiplyMatrices(this._base, M);
  }

  /**
   * True when `link` is reachable from the root through the joint chain.
   * Accepts a QUALIFIED name (`pincopen/finger_L`), the way `model.links` spells an
   * attached package's links and the way `fk()` already accepted them — without this every
   * caller that asks "is this a link or a frame?" answered *frame* for an attached link
   * and posed a held prop against the gripper's body instead of its finger.
   */
  hasLink(link) {
    if (!link) return false;
    const slash = link.indexOf('/');
    if (slash > 0) {
      const a = this.attachments.find((x) => x.id === link.slice(0, slash));
      if (a) return a.model.hasLink(link.slice(slash + 1));
    }
    if (!this._poses) this._poses = this._computePoses();
    return !!this._poses[link];
  }

  /* frames */

  /**
   * A named frame as a Matrix4 in the ROOT model's robot frame at the current pose.
   * Accepts qualified names (`pincopen/jaw_hinge`) and the attachment id itself
   * (`pincopen` = where the attached package's own robot frame sits).
   */
  frameMatrix(name) { return this._withBase(this._frameMatrix(name)); }

  /** `frameMatrix` without the base pose. */
  _frameMatrix(name) {
    if (!name) return null;
    const slash = name.indexOf('/');
    if (slash > 0) {
      const a = this.attachments.find((x) => x.id === name.slice(0, slash));
      if (a) {
        const sub = a.model._frameMatrix(name.slice(slash + 1));
        return sub ? new THREE.Matrix4().multiplyMatrices(this._attachMatrix(a.id), sub) : null;
      }
    }
    const a = this.attachments.find((x) => x.id === name);
    if (a) return this._attachMatrix(a.id);
    const spec = this.ownFrames[name];
    if (!spec) return null;
    return this._frameFromSpec(spec);
  }

  _frameFromSpec(spec) {
    if (Array.isArray(spec)) return spec.length === 16 ? mat4(spec) : null;
    if (!spec || typeof spec !== 'object') return null;
    if (Array.isArray(spec.matrix) && spec.matrix.length === 16) return mat4(spec.matrix);
    if (spec.link) {
      const base = this._fk(spec.link);
      return base.multiply(mat4(spec.local));
    }
    if (Array.isArray(spec.local) && spec.local.length === 16) return mat4(spec.local);
    if (Array.isArray(spec.origin) || Array.isArray(spec.xyz)) {
      const o = spec.origin || spec.xyz;
      if (Array.isArray(spec.rpy)) {
        const M = originMatrix([0, 0, 0], spec.rpy);
        M.setPosition(o[0] || 0, o[1] || 0, o[2] || 0);
        return M;
      }
      if (isFiniteNum(spec.tilt_deg)) {
        /* scripts/build_mast.py: view direction n = (0, cos t, -sin t) in robot mm */
        const t = spec.tilt_deg * DEG;
        return lookAtMatrix(new THREE.Vector3(o[0] || 0, o[1] || 0, o[2] || 0),
          new THREE.Vector3(0, Math.cos(t), -Math.sin(t)), new THREE.Vector3(0, 0, 1));
      }
      if (Array.isArray(spec.dir)) {
        return lookAtMatrix(new THREE.Vector3(o[0] || 0, o[1] || 0, o[2] || 0),
          new THREE.Vector3(spec.dir[0], spec.dir[1], spec.dir[2]),
          new THREE.Vector3(...(spec.up || [0, 0, 1])));
      }
      const M = new THREE.Matrix4();
      M.setPosition(o[0] || 0, o[1] || 0, o[2] || 0);
      return M;
    }
    return null;   // non-pose frame data (deck_grid pitch/radius, pan_axis, …)
  }

  /** Raw frame data for non-pose frames (deck grids, axes, radii). */
  frameData(name) {
    const slash = name.indexOf('/');
    if (slash > 0) {
      const a = this.attachments.find((x) => x.id === name.slice(0, slash));
      if (a) return a.model.frameData(name.slice(slash + 1));
    }
    return this.ownFrames[name] !== undefined ? this.ownFrames[name] : null;
  }

  /** Every frame name that resolves to a matrix, including attached ones. */
  frameNames() {
    const out = [];
    for (const k of Object.keys(this.ownFrames)) if (this._frameFromSpec(this.ownFrames[k])) out.push(k);
    for (const a of this.attachments) {
      out.push(a.id);
      for (const k of a.model.frameNames()) out.push(a.id + '/' + k);
    }
    return out;
  }

  /* placement */

  /**
   * World matrix of a component, ROBOT MILLIMETRES, at the current pose.
   * This is the ONE call the viewport needs per component per frame.
   * @returns {THREE.Matrix4} a fresh matrix
   */
  worldMatrix(componentId) { return this._withBase(this._worldMatrix(componentId)); }

  /** `worldMatrix` without the base pose. */
  _worldMatrix(componentId) {
    const c = typeof componentId === 'string' ? this._byId.get(componentId) : componentId;
    if (!c) throw new Error('robot-model: unknown component "' + componentId + '"');
    const base = c.owner === this ? null : this._ownerWorld(c.owner);
    const localWorld = c.owner._localWorld(c);
    return base ? new THREE.Matrix4().multiplyMatrices(base, localWorld) : localWorld;
  }

  _localWorld(c) {
    if (LINK_FRAMES.has(c.frame) && c.link) return this._fk(c.link).multiply(c.local);
    return c.local.clone();
  }

  /** Where an attached model's own robot frame sits in THIS model's frame. */
  attachMatrix(attachmentId) { return this._withBase(this._attachMatrix(attachmentId)); }

  /** `attachMatrix` without the base pose. */
  _attachMatrix(attachmentId) {
    const a = this.attachments.find((x) => x.id === attachmentId);
    if (!a) return new THREE.Matrix4();
    const f = a.frame ? this._frameMatrix(a.frame) : new THREE.Matrix4();
    const base = f || new THREE.Matrix4();
    return base.multiply(a.local);
  }

  /** Accumulated attachment matrix from THIS model down to `model`. */
  _ownerWorld(model) {
    const chain = [];
    for (let m = model; m && m !== this; m = m.parent ? m.parent.owner : null) {
      if (!m.parent) return new THREE.Matrix4();
      chain.unshift(m.parent);
    }
    const M = new THREE.Matrix4();
    for (const a of chain) M.multiply(a.owner._attachMatrix(a.id));
    return M;
  }

  /** World matrix of a camera, or `null` when the package declares only the DEVICE
   *  (the mount pose then comes from the fitted slot option — see `Camera.posed`). */
  cameraMatrix(cameraId) {
    const m = this._cameraMatrix(cameraId);
    return m ? this._withBase(m) : null;
  }

  /** `cameraMatrix` without the base pose. */
  _cameraMatrix(cameraId) {
    const c = typeof cameraId === 'string' ? this._camById.get(cameraId) : cameraId;
    if (!c) throw new Error('robot-model: unknown camera "' + cameraId + '"');
    if (!c.posed) return null;
    const base = c.owner === this ? null : this._ownerWorld(c.owner);
    let local;
    if (c.namedFrame) {
      const f = c.owner._frameMatrix(c.namedFrame);
      local = (f || new THREE.Matrix4()).multiply(c.local);
    } else if (LINK_FRAMES.has(c.frame) && c.link) {
      local = c.owner._fk(c.link).multiply(c.local);
    } else {
      local = c.local.clone();
    }
    return base ? new THREE.Matrix4().multiplyMatrices(base, local) : local;
  }

  /** Vertical FOV in degrees for a camera, from its hFOV and aspect (what three wants). */
  cameraVFov(cameraId) {
    const c = typeof cameraId === 'string' ? this._camById.get(cameraId) : cameraId;
    if (!c) throw new Error('robot-model: unknown camera "' + cameraId + '"');
    const h = c.hfov * DEG;
    return 2 * Math.atan(Math.tan(h / 2) / c.aspect) * RAD;
  }

  /* composition */

  /**
   * Attach another RobotModel so it follows a frame of this one.
   * @param {RobotModel} model
   * @param {string} frameName  a frame of THIS model (e.g. "wrist_flange")
   * @param {number[]|THREE.Matrix4} [local]  extra placement inside that frame
   * @param {{id?:string}} [opts]  attachment id (default: the attached model's id)
   */
  attach(model, frameName, local = null, opts = {}) {
    if (!(model instanceof RobotModel)) throw new Error('robot-model: attach() needs a RobotModel');
    if (model === this) throw new Error('robot-model: cannot attach a model to itself');
    const id = opts.id || model.id;
    if (this.attachments.some((a) => a.id === id)) throw new Error('robot-model: duplicate attachment id "' + id + '"');
    const rec = { id, model, frame: frameName || null, local: mat4(local), owner: this };
    this.attachments.push(rec);
    model.parent = rec;
    this._flatten();
    return rec;
  }

  detach(id) {
    const i = this.attachments.findIndex((a) => a.id === id || a.model === id);
    if (i < 0) return null;
    const [rec] = this.attachments.splice(i, 1);
    rec.model.parent = null;
    rec.model._flatten();
    this._flatten();
    return rec;
  }

  /* queries */

  component(id) { return this._byId.get(id) || null; }
  camera(id) { return this._camById.get(id) || null; }
  joint(name) { return this._jointById.get(name) || null; }
  componentsOfLink(link) { return this.components.filter((c) => c.link === link); }
  componentsOfGroup(group) { return this.components.filter((c) => c.group === group); }
  componentsOfSlot(slot) { return this.components.filter((c) => c.slot === slot); }
  printables() { return this.components.filter((c) => c.printable); }

  /**
   * Axis-aligned bounding box in robot mm at the current pose.
   * Needs geometry: components without one are skipped (`box.missing` counts them).
   * @param {{ids?:string[], visibleOnly?:boolean}} [opts]
   */
  boundingBox(opts = {}) {
    const box = new THREE.Box3();
    box.makeEmpty();
    let missing = 0, used = 0;
    const list = opts.ids ? opts.ids.map((id) => this._byId.get(id)).filter(Boolean) : this.components;
    const tmp = new THREE.Box3();
    for (const c of list) {
      if (opts.visibleOnly && !c.visible) continue;
      if (!c.geometry) { missing += 1; continue; }
      if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
      tmp.copy(c.geometry.boundingBox).applyMatrix4(this.worldMatrix(c.id));
      box.union(tmp);
      used += 1;
    }
    box.missing = missing;
    box.used = used;
    return box;
  }

  /** A plain, JSON-safe description: the manifest plus the live pose. No geometry. */
  toJSON() {
    return {
      schema: this.schema,
      id: this.id,
      name: this.name,
      version: this.version,
      units: this.units,
      up: this.up,
      source: this.source,
      root_link: this.rootLink,
      base_pose: { ...this.basePose },
      joints: this.ownJoints.map((j) => j.toJSON()),
      pose: this.getJoints(),               // control joints: deg, or mm for prismatic
      pose_deg: this.getJoints(),           // the older spelling, kept for compatibility
      derived: this.derivedJoints(),
      components: this.components.map((c) => ({
        id: c.id, label: c.label, link: c.link, group: c.group, slot: c.slot,
        frame: c.frame, local: c.local.toArray(), color: c.color,
        printable: c.printable, mesh: c.mesh, source: c.source, visible: c.visible
      })),
      cameras: this.cameras.map((c) => ({
        id: c.id, label: c.label, link: c.link, frame: c.frame,
        /* a DEVICE-only camera has no mount pose to report — the fitted slot option has it */
        local: c.posed ? c.local.toArray() : null, posed: c.posed,
        hfov_deg: c.hfov, aspect: c.aspect, source: c.source
      })),
      frames: this.frameNames().reduce((o, n) => { const m = this.frameMatrix(n); if (m) o[n] = m.toArray(); return o; }, {}),
      attachments: this.attachments.map((a) => ({ id: a.id, package: a.model.id, at: a.frame, local: a.local.toArray() }))
    };
  }
}

/* ------------------------------------------------------------------ frame getters -- */

function buildFrameGetters(model) {
  const obj = {};
  for (const name of model.frameNames()) {
    Object.defineProperty(obj, name, {
      enumerable: true, configurable: true,
      get: () => model.frameMatrix(name)
    });
  }
  return obj;
}

function lookAtMatrix(origin, dir, up) {
  const z = dir.clone().normalize().multiplyScalar(-1);       // camera looks down −Z
  let u = up.clone();
  if (Math.abs(u.dot(z)) > 0.999) u = new THREE.Vector3(0, 1, 0);
  const x = new THREE.Vector3().crossVectors(u, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  const M = new THREE.Matrix4().makeBasis(x, y, z);
  M.setPosition(origin);
  return M;
}
