/* Resolve an `rps/robot@2` composition into the flat `rps/robot@1` form RobotModel reads:
   base components minus `hide`, plus the attached robots, plus one component per mesh of
   every part a slot option names.  Pure data, no three.  The Python twin is
   tools/build/robots/resolve.py (tools/tests/build/resolve-parity.test.mjs). */

export const ROBOT2_SCHEMA = 'rps/robot@2';
export const PART_SCHEMA = 'rps/part@1';
const I16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/** column-major 4x4 product a·b */
function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[r + 4 * k] * b[k + 4 * c];
    o[r + 4 * c] = s;
  }
  return o;
}

/** [optionId, partId] of a part option (`part` or `option:part`), else null. */
export function optionRef(spec) {
  if (typeof spec !== 'string') return null;
  const i = spec.indexOf(':');
  return i < 0 ? [spec, spec] : [spec.slice(0, i), spec.slice(i + 1)];
}

/** The component id a part mesh resolves to. */
export function partComponentId(part, mesh) { return mesh.component || `${part.id}_${mesh.id}`; }

const PART_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
export const FRAMES = ['robot', 'slot_anchor', 'attachment'];
const is16 = (m) => Array.isArray(m) && m.length === 16 && m.every((v) => typeof v === 'number' && Number.isFinite(v));

/**
 * Problems with a part.json, as sentences ([] when it is usable).  `strict` is the agent
 * intake: an id a folder can carry, `local` as 16 numbers, a file per mesh, unique mesh ids,
 * camera poses and lenses.
 */
export function validatePart(doc, o = {}) {
  const bad = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['part.json is not an object'];
  if (doc.schema !== PART_SCHEMA) bad.push(`schema is ${JSON.stringify(doc.schema ?? null)}, expected "${PART_SCHEMA}"`);
  const id = doc.id == null ? '' : String(doc.id);
  if (!id || typeof doc.id !== 'string') bad.push('id missing');
  else if (o.strict && !PART_ID.test(id)) bad.push(`id "${id}" must be letters, digits, - or _ (≤ 64)`);
  if (!FRAMES.includes(doc.frame || 'robot')) bad.push(`frame "${doc.frame}" unknown (${FRAMES.join(', ')})`);
  if (o.strict && doc.local != null && !is16(doc.local)) bad.push('local must be null or 16 numbers');
  if (!Array.isArray(doc.meshes) || !doc.meshes.length) bad.push('meshes[] is empty');
  else {
    const ids = new Set();
    doc.meshes.forEach((m, i) => {
      m = m || {};
      if (!m.id) bad.push(`meshes[${i}] has no id`);
      else if (o.strict && ids.has(m.id)) bad.push(`meshes[${i}] id "${m.id}" is used twice`);
      ids.add(m.id);
      if (o.strict ? !m.file : !m.file && !m.print) bad.push(`meshes[${i}] (${m.id || i}) has no file${o.strict ? '' : ' or print'}`);
    });
  }
  if (o.strict && doc.cameras && typeof doc.cameras === 'object') {
    for (const [cid, c] of Object.entries(doc.cameras)) {
      if (c == null) continue;
      if (!is16(c.local)) bad.push(`cameras.${cid}.local must be 16 numbers`);
      const h = c.hfov_deg;
      if (h != null && !(typeof h === 'number' && h > 0 && h < 180)) bad.push(`cameras.${cid}.hfov_deg must be a number in (0, 180)`);
    }
  }
  return bad;
}

function partComponents(part, frames, attachAt, on, owner, meshMap) {
  let local = part.local || I16;
  let link = null, frame = 'robot';
  if (part.frame === 'attachment') {
    const f = frames[attachAt];
    if (!f) throw new Error(`compose: part "${part.id}" rides the attachment, and there is none`);
    link = f.link; frame = 'link'; local = mul(f.local, local);
  }
  const out = [];
  for (const m of part.meshes) {
    if (!m.file) continue;                           // print-only: nothing to draw
    const pr = m.print || null;
    const shared = !!pr && pr.startsWith('part:');
    const id = partComponentId(part, m);
    const c = {
      id, label: m.label || m.id, link, group: 'upgrade', slot: part.slot || null, mesh: id,
      frame, local: local.slice(), color: m.color || '#9aa3ad',
      printable: m.printable !== undefined ? !!m.printable : !m.hardware && !shared,
      print_file: pr && !shared ? pr : null, print_name: m.print_name || null,
      source: part.source || null, note: m.note || null, hidden_by_default: !on,
      part_of: part.id, part_mesh: m.id,
    };
    for (const k of ['print_transform', 'print_fit_rmse_mm', 'print_fit_worst_mm', 'print_bbox_mm', 'print_fit_note', 'faces']) {
      if (m[k] != null) c[k] = clone(m[k]);
    }
    meshMap.set(id, { owner, mesh: m.id });
    out.push(c);
  }
  return out;
}

function resolveSlots(doc, parts, frames, attachAt, meshMap) {
  const rules = new Map();
  for (const r of doc.rules || []) {
    const k = r.slot + '\u0000' + r.option;
    rules.set(k, Object.assign(rules.get(k) || {}, clone(r.requires)));
  }
  const def = doc.default_design || {};
  const comps = [];
  const used = {};
  const slots = {};
  for (const [sid, raw] of Object.entries(doc.slots || {})) {
    const s = {};
    for (const [k, v] of Object.entries(raw)) if (k !== 'options') s[k] = clone(v);
    const specs = (raw.options || []).slice();
    const named = new Set(specs.map(optionRef).filter(Boolean).map((r) => r[1]));
    /* any part whose slot matches is listed, after the named ones */
    const extra = [...parts.values()].filter((p) => p.doc.slot === sid && !named.has(p.doc.id)
      && (p.doc.robot == null || p.doc.robot === doc.id)).map((p) => p.doc.id);
    let at = 0;
    specs.forEach((o, i) => { if (optionRef(o)) at = i + 1; });
    specs.splice(at, 0, ...extra);
    const opts = [], covers = [];
    for (const o of specs) {
      const ref = optionRef(o);
      let opt;
      if (!ref) opt = clone(o);
      else {
        const [oid, pid] = ref;
        const p = parts.get(pid);
        if (!p) continue;
        const part = p.doc;
        const on = s.default === oid || def[sid] === oid;
        const pc = partComponents(part, frames, attachAt, on, p.owner, meshMap);
        comps.push(...pc);
        used[pid] = part;
        covers.push(...pc.map((c) => c.id));
        opt = { id: oid, label: part.label, kind: 'parts', parts: pc.map((c) => c.id), frame: part.frame || 'robot' };
        if (part.cameras && Object.keys(part.cameras).length) opt.cameras = clone(part.cameras);
        Object.assign(opt, { from: p.from, source: part.source || null, part: pid });
        if (part.notes) opt.note = part.notes;
      }
      const req = rules.get(sid + '\u0000' + opt.id);
      if (req) opt.requires = clone(req);
      opts.push(opt);
    }
    s.covers = covers.concat(raw.covers || []);
    s.options = opts;
    slots[sid] = s;
  }
  for (const p of parts.values()) {
    if (p.doc.slot == null && p.doc.robot === doc.id && !used[p.doc.id]) used[p.doc.id] = p.doc;
  }
  return { slots, comps, used };
}

/**
 * @param {object} doc  a robot.json (robot@1 passes through)
 * @param {{robot:(id:string)=>{doc:object, meshes?:Map}, parts:()=>Array<{doc:object, owner:string, from?:string}>}} src
 *   `robot(id)` answers another package already resolved; `parts()` lists every part in
 *   precedence order — the first of an id wins.
 * @returns {{manifest:object, meshes:Map<string,{owner:string, mesh:string}>}}  `meshes` maps a
 *   component's mesh key to the geometry owner (robot id or "part:<id>") and its mesh id.
 */
export function resolveRobot(doc, src) {
  const meshes = new Map();
  if (!doc || doc.schema !== ROBOT2_SCHEMA) return { manifest: doc, meshes };
  const base = src.robot(doc.base);
  if (!base) throw new Error(`compose: "${doc.id}" is built on "${doc.base}", which is not a package here`);
  const B = base.doc;
  const hide = new Set(doc.hide || []);
  const out = {};
  for (const [k, v] of Object.entries(doc)) if (!['base', 'attach', 'hide', 'hide_note', 'rules'].includes(k)) out[k] = clone(v);
  out.schema = 'rps/robot@1';
  out.source = Object.assign({}, clone(B.source) || {}, clone(doc.source) || {});
  for (const k of ['units', 'up', 'frame', 'bed']) if (out[k] === undefined && B[k] !== undefined) out[k] = clone(B[k]);
  out.composition = { base: doc.base, hide: (doc.hide || []).slice(), hide_note: doc.hide_note || null };
  out.attachments = (doc.attach || []).map((a) => Object.assign(
    { package: a.robot, at: a.at, local: clone(a.local) || I16.slice() }, a.id ? { id: a.id } : {}, a.note ? { note: a.note } : {}));
  out.kinematics = clone(B.kinematics);
  const comps = (B.components || []).map((c) => {
    const d = clone(c);
    d.hidden_by_default = hide.has(c.id);
    const via = base.meshes && base.meshes.get(c.mesh);
    meshes.set(d.id, via || { owner: doc.base, mesh: c.mesh });
    d.mesh = d.id;
    return d;
  });
  const frames = Object.assign({}, clone(B.frames) || {}, clone(doc.frames) || {});
  out.frames = frames;
  const own = new Map((doc.cameras || []).map((c) => [c.id, c]));
  const cams = (B.cameras || []).map((c) => { const o = own.get(c.id); own.delete(c.id); return clone(o || c); });
  out.cameras = cams.concat([...own.values()].map(clone));
  const parts = new Map();
  for (const p of src.parts()) if (p && p.doc && !parts.has(p.doc.id)) parts.set(p.doc.id, p);
  const at = out.attachments.length ? out.attachments[0].at : null;
  const { slots, comps: pcomps, used } = resolveSlots(doc, parts, frames, at, meshes);
  out.components = comps.concat(pcomps);
  out.slots = slots;
  out.parts = clone(used);
  for (const k of ['presets', 'presets_source']) if (doc[k] === undefined && B[k] !== undefined) out[k] = clone(B[k]);
  return { manifest: out, meshes };
}
