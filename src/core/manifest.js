/* rps/robot@1 manifest vocabulary: the schema id, the unit and limit normalisation a
   package goes through on load, and validateManifest().  Plain data — needs nothing. */

export const ROBOT_SCHEMA = 'rps/robot@1';

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/* frame kinds that are posed through a link */
export const LINK_FRAMES = new Set(['link', 'mesh']);

export const MOVING = new Set(['revolute', 'continuous', 'prismatic']);

export function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }

/* Joint limits in the joint's own unit — DEGREES for revolute/continuous, MILLIMETRES for
   prismatic — from whichever spelling a package uses:
     j.limits {lower, upper}        — already in that unit, the canonical form
     j.limit_deg [lo, hi]           — degrees (pincopen's jaw)
     j.limit_mm  [lo, hi]           — millimetres (a prismatic finger)
     j.lower / j.upper              — the URDF <limit> spelling: RADIANS, or METRES for prismatic
     kinematics.joint_limits_deg[name]  — a table beside the joints, [lo, hi] or {lower, upper} */
export function withLimits(j, table) {
  if (j.limits) return j;
  const pair = (t) => (Array.isArray(t) ? { lower: t[0], upper: t[1] } : t);
  if (Array.isArray(j.limit_mm)) return { ...j, limits: pair(j.limit_mm) };
  if (Array.isArray(j.limit_deg)) return { ...j, limits: pair(j.limit_deg) };
  if (table && table[j.name]) return { ...j, limits: pair(table[j.name]) };
  if (isFiniteNum(j.lower) && isFiniteNum(j.upper) && (j.lower !== 0 || j.upper !== 0)) {
    const k = j.type === 'prismatic' ? 1000 : RAD;
    return { ...j, limits: { lower: j.lower * k, upper: j.upper * k } };
  }
  return j;
}

export function withSlot(c, slots) {
  if (c.slot || !slots) return c;
  for (const sid of Object.keys(slots)) {
    const s = slots[sid];
    const covers = s && s.covers;
    if (!Array.isArray(covers)) continue;
    for (const pat of covers) {
      if (pat === c.id) return { ...c, slot: sid };
      if (pat.endsWith('*') && c.id.startsWith(pat.slice(0, -1))) return { ...c, slot: sid };
    }
  }
  return c;
}

/* Per-instance state that must NOT be lost when `_flatten()` regenerates the qualified
   copies of an attached package's components and cameras: `visible` is written by the UI
   and `geometry` asynchronously by `loadGeometries()`, both on the sub-model's OWN record.
   The qualified copy reads and writes THROUGH to that record. */
const LIVE_KEYS = ['visible', 'geometry', 'color', 'stockRemoved'];

export function qualify(obj, prefix, key) {
  const out = Object.create(Object.getPrototypeOf(obj));
  Object.assign(out, obj);
  out[key] = prefix + '/' + obj[key];
  out.localId = obj.localId !== undefined ? obj.localId : obj[key];
  for (const k of LIVE_KEYS) {
    if (!(k in obj)) continue;
    Object.defineProperty(out, k, {
      enumerable: true, configurable: true,
      get() { return obj[k]; },
      set(v) { obj[k] = v; },
    });
  }
  return out;
}

export function qualifyJoint(j, prefix) {
  const out = Object.create(Object.getPrototypeOf(j));
  Object.assign(out, j);
  out.name = prefix + '/' + j.name;
  out.localName = j.localName || j.name;
  out.parent = prefix + '/' + j.parent;
  out.child = prefix + '/' + j.child;
  /* a mimic source is a sibling inside the attached package, so it qualifies too — a UI
     reading joint.mimic.joint gets a name it can look up in the flattened list */
  if (j.mimic) out.mimic = { ...j.mimic, joint: prefix + '/' + j.mimic.joint };
  return out;
}

/* validation */

/** rps/robot@1: the component `group` vocabulary — DISPLAY GROUPING ONLY, nothing in
 *  the core branches on it.  A component that declares no group is read as "imported". */
export const COMPONENT_GROUPS = Object.freeze([
  'base', 'arm', 'wheels', 'electronics', 'camera', 'gripper',
  'upgrade', 'body', 'linkage', 'finger', 'fingertip', 'hardware', 'imported'
]);
const GROUPS = new Set(COMPONENT_GROUPS);

/**
 * Small, readable schema check for `rps/robot@1`.
 * @returns {{ok:boolean, errors:string[], warnings:string[]}}
 */
export function validateManifest(m) {
  const errors = [], warnings = [];
  const E = (s) => errors.push(s);
  const W = (s) => warnings.push(s);
  if (!m || typeof m !== 'object') return { ok: false, errors: ['manifest is not an object'], warnings };
  if (m.schema !== ROBOT_SCHEMA) E(`schema must be "${ROBOT_SCHEMA}" (got ${JSON.stringify(m.schema)})`);
  if (!m.id || typeof m.id !== 'string') E('id is required and must be a string');
  if (m.units && m.units !== 'mm') W(`units "${m.units}": everything downstream assumes mm`);
  if (m.up && m.up !== 'z') W(`up "${m.up}": the robot frame is +Z up`);

  const K = m.kinematics;
  const linkNames = new Set();
  if (K) {
    if (!Array.isArray(K.joints)) E('kinematics.joints must be an array');
    else {
      const seen = new Set();
      K.joints.forEach((j, i) => {
        const at = `kinematics.joints[${i}]`;
        if (!j.name) E(`${at}: name is required`);
        else if (seen.has(j.name)) E(`${at}: duplicate joint name "${j.name}"`);
        else seen.add(j.name);
        if (!j.parent || !j.child) E(`${at} ("${j.name}"): parent and child links are required`);
        else { linkNames.add(j.parent); linkNames.add(j.child); }
        if (j.type && !['fixed', 'revolute', 'continuous', 'prismatic', 'floating', 'planar'].includes(j.type)) {
          E(`${at} ("${j.name}"): unknown joint type "${j.type}"`);
        }
        if (j.xyz && (!Array.isArray(j.xyz) || j.xyz.length !== 3)) E(`${at} ("${j.name}"): xyz must be 3 numbers`);
        if (!j.xyz && MOVING.has(j.type || 'fixed')) {
          W(`${at} ("${j.name}"): no xyz — the joint origin is (0,0,0)`
            + (Array.isArray(j.origin_xy) ? `; it has origin_xy [${j.origin_xy}], which should be xyz [${j.origin_xy[0]}, ${j.origin_xy[1]}, 0] with kinematics.units "mm"` : ''));
        }
        if (j.rpy && (!Array.isArray(j.rpy) || j.rpy.length !== 3)) E(`${at} ("${j.name}"): rpy must be 3 numbers`);
        if (j.mimic) {
          if (!j.mimic.joint) E(`${at} ("${j.name}"): mimic needs a "joint" to follow`);
          else if (!K.joints.some((x) => x.name === j.mimic.joint)) {
            E(`${at} ("${j.name}"): mimics "${j.mimic.joint}", which is not a joint of this package`);
          } else if (K.joints.find((x) => x.name === j.mimic.joint).mimic) {
            W(`${at} ("${j.name}"): mimics "${j.mimic.joint}", which is itself a mimic — the chain is followed, but one level is easier to read`);
          }
          if (!MOVING.has(j.type || 'fixed')) E(`${at} ("${j.name}"): a mimic joint must be revolute, continuous or prismatic`);
          if (j.mimic.multiplier !== undefined && !isFiniteNum(j.mimic.multiplier)) E(`${at} ("${j.name}"): mimic.multiplier must be a number`);
        }
        if (j.type === 'prismatic' && !Array.isArray(j.axis)) {
          W(`${at} ("${j.name}"): a prismatic joint with no axis will slide along +Z`);
        }
      });
      if (K.root_link && !linkNames.has(K.root_link) && K.joints.length) {
        E(`kinematics.root_link "${K.root_link}" is not mentioned by any joint`);
      }
      /* one root only: every link that is some joint's child has a parent */
      const children = new Set(K.joints.map((j) => j.child));
      const roots = [...linkNames].filter((l) => !children.has(l));
      if (roots.length > 1) W(`kinematics: ${roots.length} disconnected roots (${roots.slice(0, 3).join(', ')}…)`);
    }
    if (K.units && !['m', 'mm'].includes(K.units)) E(`kinematics.units must be "m" or "mm" (got ${JSON.stringify(K.units)})`);
  }

  if (!Array.isArray(m.components)) E('components must be an array');
  else {
    const seen = new Set();
    m.components.forEach((c, i) => {
      const at = `components[${i}]`;
      if (!c.id) E(`${at}: id is required`);
      else if (seen.has(c.id)) E(`${at}: duplicate component id "${c.id}"`);
      else seen.add(c.id);
      const frame = c.frame || (c.link ? 'link' : 'robot');
      if (!['robot', 'link', 'mesh'].includes(frame)) E(`${at} ("${c.id}"): frame must be robot|link|mesh (got "${frame}")`);
      if (LINK_FRAMES.has(frame) && !c.link) E(`${at} ("${c.id}"): frame "${frame}" needs a link`);
      if (c.link && linkNames.size && !linkNames.has(c.link) && c.link !== (K && K.root_link)) {
        E(`${at} ("${c.id}"): link "${c.link}" is not in the kinematic chain`);
      }
      if (c.local != null && (!Array.isArray(c.local) || c.local.length !== 16)) {
        E(`${at} ("${c.id}"): local must be 16 numbers (column-major) or null`);
      }
      if (c.group && !GROUPS.has(c.group)) W(`${at} ("${c.id}"): group "${c.group}" is not one of ${[...GROUPS].join('|')}`);
      if (!c.mesh && !c.mesh_ref) W(`${at} ("${c.id}"): no mesh — it will have no geometry`);
    });
  }

  if (m.cameras && !Array.isArray(m.cameras)) E('cameras must be an array');
  else if (Array.isArray(m.cameras)) {
    m.cameras.forEach((c, i) => {
      if (!c.id) E(`cameras[${i}]: id is required`);
      if (c.hfov_deg != null && !(c.hfov_deg > 0 && c.hfov_deg < 180)) E(`cameras[${i}] ("${c.id}"): hfov_deg must be in (0, 180)`);
      if (c.local != null && (!Array.isArray(c.local) || c.local.length !== 16)) E(`cameras[${i}] ("${c.id}"): local must be 16 numbers`);
    });
  }

  if (m.attachments && !Array.isArray(m.attachments)) E('attachments must be an array');
  else if (Array.isArray(m.attachments)) {
    m.attachments.forEach((a, i) => {
      if (!a.package) E(`attachments[${i}]: package is required`);
      if (!a.at) E(`attachments[${i}] ("${a.package}"): "at" (a frame name) is required`);
      else if (m.frames && !(a.at in m.frames)) E(`attachments[${i}]: frame "${a.at}" is not declared in frames`);
    });
  }

  return { ok: errors.length === 0, errors, warnings };
}
