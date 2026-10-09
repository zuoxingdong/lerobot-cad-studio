/* The "ask an agent" prompt and its context pack.  `ctx` is a plain object the UI builds:
   robot {id, name, source:{repo, commit}, units, frame, groundZ}
   slot  {id, label, frame?, anchor:{name, matrix[16]}, interface:{name: fact}, mount?, params?, keepOuts?:[str], current:{id, label, partJson?}}
   parts [{id, name, bbox:[dx,dy,dz]|{min,max}, volume (cm³), mass (g), hardware?, printRef?, note?, stlBytes, printStlBytes?}]
   neighbours {stlBytes, note?}   cameras [{id, hfov, vfov?, aspect, local[16]?}]   printer {name, bed:[x,y,z]}
   checks {overhangDeg, overhangFrac, bedContactMm2, bedContactTallMm, maxFaces, maxReachMm, presets[], camera[]}
   constraints {keepMount, keepCamera, material, maxOverhangDeg, maxMassG?}
   date 'YYYY-MM-DD', newId?, folderName? (the linked folder; none means the user carries a zip) */

import { strToU8 } from 'fflate';
import { OVERHANG_DEG, OVERHANG_WARN, BED_CONTACT_MIN_MM2, BED_CONTACT_TALL_MM } from './printcheck.js';
import { PART_SCHEMA, MAX_FACES, MAX_REACH_MM } from './part-folder.js';
import { writeTree } from '../core/link-folder.js';
import { zipFiles } from '../core/package.js';

export const CONTEXT_DIR = '_context';
export const NOTE_MAX = 200;
export const DEFAULT_CHECKS = {
  overhangDeg: OVERHANG_DEG, overhangFrac: OVERHANG_WARN, bedContactMm2: BED_CONTACT_MIN_MM2,
  bedContactTallMm: BED_CONTACT_TALL_MM, maxFaces: MAX_FACES, maxReachMm: MAX_REACH_MM, presets: [], camera: [],
};
export const DEFAULT_CONSTRAINTS = { keepMount: true, keepCamera: true, material: 'PLA', maxOverhangDeg: 45, maxMassG: null };

const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v);
const n = (v) => {
  if (!Number.isFinite(v)) return String(v);
  const s = String(Math.round(v * 10) / 10);
  return s === '-0' ? '0' : s;
};
const vec = (a) => `(${a.map(n).join(', ')})`;
const unit = (a) => `(${a.map((v) => { const s = String(Math.round(v * 1000) / 1000); return s === '-0' ? '0' : s; }).join(', ')})`;
const thousands = (v) => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const trim = (s, max = NOTE_MAX) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
};
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

function resolve(ctx) {
  const slot = ctx.slot || {};
  const current = slot.current || {};
  return {
    ...ctx,
    robot: ctx.robot || {},
    slot,
    current,
    parts: ctx.parts || [],
    cameras: ctx.cameras || [],
    printer: ctx.printer || { name: 'printer', bed: [256, 256, 256] },
    checks: { ...DEFAULT_CHECKS, ...(ctx.checks || {}) },
    constraints: { ...DEFAULT_CONSTRAINTS, ...(ctx.constraints || {}) },
    date: ctx.date || today(),
    newId: slug(ctx.newId) || `${slug(current.id || slot.id || 'part')}-v2`,
    folder: ctx.folderName ? String(ctx.folderName) : null,
  };
}

const extent = (b) => (Array.isArray(b) ? b : b && b.min ? b.max.map((v, k) => v - b.min[k]) : null);
const partFile = (p) => `current/${p.id}.stl`;
const printFile = (p) => `current/${p.id}_print.stl`;
const needsPlate = (p) => !p.hardware && !p.printRef;

/** "Corner mast, printed · 60°" -> "Corner mast, printed v2 · 60°": the angle stays last, where the live label finds it */
function newLabel(c) {
  const base = String(c.current.label || c.slot.label || c.slot.id || 'part');
  const m = base.match(/^(.*?)(\s*·\s*\d+(?:\.\d+)?\s*°)$/);
  return m ? `${m[1]} v2${m[2]}` : `${base} v2`;
}

/** The part.json the agent fills in. */
export function partTemplate(ctx) {
  const c = resolve(ctx);
  const cams = {};
  for (const cam of c.cameras) {
    cams[cam.id] = { local: Array.isArray(cam.local) ? cam.local.slice() : null, hfov_deg: cam.hfov };
    if (cam.vfov != null) cams[cam.id].vfov_deg = cam.vfov;
    if (cam.aspect != null) cams[cam.id].aspect = cam.aspect;
  }
  const t = {
    schema: PART_SCHEMA, id: c.newId, label: newLabel(c), robot: c.robot.id, slot: c.slot.id,
    frame: c.slot.frame || 'robot', local: null,
    meshes: c.parts.map((p) => {
      const m = { id: p.id, file: `mesh/${p.id}.stl` };
      if (p.name && p.name !== p.id) m.label = p.name;
      if (p.hardware) m.hardware = true;
      else m.print = p.printRef || `print/${p.id}_PRINT.stl`;
      return m;
    }),
    cameras: cams,
  };
  if (c.slot.mount) t.mount = c.slot.mount;
  /* current/ holds the meshes and cameras as fitted, so the fitted detent is the design one */
  t.params = JSON.parse(JSON.stringify(c.slot.params || {}));
  for (const p of Object.values(t.params)) if (p && p.kind === 'hinge' && Number.isFinite(p.value)) p.design = p.value;
  t.source = `agent ${c.date}`;
  if (c.current.id) t.derived_from = c.current.id;
  t.notes = '';
  return t;
}

/* one key per line, arrays of objects one entry per line, numbers to 4 decimals */
function compactJson(obj) {
  const one = (v) => JSON.stringify(v, (k, x) => (typeof x === 'number' ? r4(x) : x));
  const lines = ['{'];
  const keys = Object.keys(obj);
  keys.forEach((k, i) => {
    const v = obj[k], comma = i < keys.length - 1 ? ',' : '';
    if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object')) {
      lines.push(`  "${k}": [`);
      v.forEach((x, j) => lines.push(`    ${one(x)}${j < v.length - 1 ? ',' : ''}`));
      lines.push(`  ]${comma}`);
    } else lines.push(`  "${k}": ${one(v)}${comma}`);
  });
  lines.push('}');
  return lines.join('\n');
}

function anchorLines(anchor) {
  const L = [];
  const m = anchor && Array.isArray(anchor.matrix) && anchor.matrix.length === 16 ? anchor.matrix : null;
  const name = (anchor && anchor.name) || 'slot anchor';
  if (!m) { L.push(`- Anchor \`${name}\`: the robot origin, axes as the robot frame.`); return L; }
  L.push(`- Anchor \`${name}\`: origin ${vec(m.slice(12, 15))} mm; axes X ${unit(m.slice(0, 3))}, Y ${unit(m.slice(4, 7))}, Z ${unit(m.slice(8, 11))}.`);
  L.push(`  4×4, column-major: [${m.map((v) => n(r4(v))).join(', ')}]`);
  return L;
}

function factLine(k, v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v, (kk, x) => (typeof x === 'number' ? r4(x) : x));
  return s.length > 160 ? `- ${k}: see interface.json` : `- ${k}: ${s}`;
}

function mountLine(m) {
  const bits = [];
  if (Array.isArray(m.bolts_mm) && m.bolts_mm.length) bits.push(`${m.bolts_mm.length} bolts at ${m.bolts_mm.map(vec).join(' ')} mm (X, Y)`);
  if (m.face && m.face.point) bits.push(`mating face through ${vec(m.face.point)} with normal ${vec(m.face.normal || [0, 0, -1])}`);
  return `- Mount${m.interface ? ` (${m.interface})` : ''}: ${bits.join('; ') || 'as in part.json mount'}.`;
}

function cameraLines(c) {
  const L = [];
  for (const cam of c.cameras) {
    const fov = [`hFOV ${n(cam.hfov)}°`];
    if (cam.vfov != null) fov.push(`vFOV ${n(cam.vfov)}°`);
    if (cam.aspect) fov.push(`aspect ${Math.abs(cam.aspect - 4 / 3) < 1e-3 ? '4:3' : n(cam.aspect)}`);
    L.push(`- Camera \`${cam.id}\`: ${fov.join(', ')}; the real lens, do not change it.`);
    if (Array.isArray(cam.local) && cam.local.length === 16) {
      const l = cam.local;
      L.push(`  Sensor now at ${vec(l.slice(12, 15))} mm, looking along ${unit([-l[8], -l[9], -l[10]])}`
        + ` (pose = cameras.${cam.id}.local: looks down its local -Z, +Y up).`);
    }
    L.push(c.constraints.keepCamera ? '  Keep this pose within 2 mm and 1°.'
      : `  It may move with the part: write its new pose in cameras.${cam.id}.local; the studio re-checks what it sees.`);
  }
  return L;
}

/**
 * The prompt: context first, the request last and verbatim, then the conflict rule.
 * @param {object} ctx
 * @param {string} request
 */
export function buildPrompt(ctx, request) {
  const c = resolve(ctx);
  const R = c.robot, S = c.slot, K = c.checks, C = c.constraints;
  const bed = c.printer.bed || [256, 256, 256];
  const L = [];
  const h = (t) => { if (L.length) L.push(''); L.push(`## ${t}`); };

  L.push(`# Redesign: ${S.label || S.id} on ${R.name || R.id}`);
  h('1 Role');
  L.push(`You are designing a 3D-printable replacement for one part of a ${R.name || R.id} robot.`);
  L.push('Deliver files in the folder layout of section 7; the studio picks them up and checks them.');

  h('2 Robot');
  const src = R.source && R.source.repo ? `, source ${R.source.repo}${R.source.commit ? '@' + String(R.source.commit).slice(0, 7) : ''}` : '';
  L.push(`- ${R.name || R.id} (\`${R.id}\`)${src}.`);
  L.push(`- Units ${R.units || 'mm'}. Frame: ${R.frame || '+X right, +Y forward, +Z up'}. Ground Z = ${n(R.groundZ ?? 0)} mm.`);

  h('3 Target');
  L.push(`- Slot \`${S.id}\` (${S.label || S.id}); fitted now: ${c.current.id ? `\`${c.current.id}\` (${c.current.label || c.current.id})` : 'nothing'}.`);
  if (c.parts.length) L.push('- Parts, robot frame, bbox = X × Y × Z extent:');
  for (const p of c.parts) {
    const e = extent(p.bbox);
    const bits = [e ? `${e.map(n).join(' × ')} mm` : null, p.volume != null ? `${n(p.volume)} cm³` : null,
      p.mass != null ? `${Math.round(p.mass)} g` : null, p.hardware ? 'hardware (bought)' : 'printed'].filter(Boolean);
    L.push(`  - \`${p.id}\` ${p.name && p.name !== p.id ? p.name + ': ' : ''}${bits.join(', ')}.`);
    if (p.note) L.push(`    ${trim(p.note)}`);
  }
  for (const [k, p] of Object.entries(S.params || {})) {
    if (!p || p.kind !== 'hinge') continue;
    const v = Array.isArray(p.values) ? p.values : [];
    const u = Array.isArray(p.usable) && p.usable.length === 2 ? p.usable : null;
    const out = u ? v.filter((x) => x < u[0] - 1e-9 || x > u[1] + 1e-9) : [];
    const range = u ? `${n(u[0])}–${n(u[1])}° usable${out.length ? ` (${out.map(n).join(', ')}° ${out.length === 1 ? 'exists but fails' : 'exist but fail'} the camera checks)` : ''}`
      : v.length ? `${n(v[0])}–${n(v[v.length - 1])}°` : '';
    L.push(`- Param \`${k}\`: hinge detents ${range}, now ${n(p.value)}°; turns ${(p.moves || []).map((x) => `\`${x}\``).join(', ')}`
      + ` about ${unit(p.axis || [1, 0, 0])} through ${vec(p.origin || [0, 0, 0])} mm.`);
  }

  h('4 Hard interface (must hold)');
  L.push(...anchorLines(S.anchor));
  if (C.keepMount && S.mount) L.push(mountLine(S.mount));
  for (const [k, v] of Object.entries(S.interface || {})) L.push(factLine(k, v));
  L.push(...cameraLines(c));
  const keep = (S.keepOuts || []).map((k) => (typeof k === 'string' ? k : k.name || JSON.stringify(k)));
  L.push(`- Keep-outs: ${keep.length ? keep.join('; ') : 'none recorded'}${ctx.neighbours ? '; neighbours.stl holds the parts around the slot' : ''}.`);
  L.push(`- Bed ${bed.map(n).join(' × ')} mm (${c.printer.name || 'printer'}), ${C.material}, max overhang ${n(C.maxOverhangDeg)}° from vertical.`
    + (C.maxMassG ? ` Max ${n(C.maxMassG)} g per part.` : ''));

  h('5 Self-check before you finish (the studio runs these)');
  L.push('- Closed: every STL is watertight, no open or non-manifold edges.');
  L.push('- Single body: one connected shell per STL.');
  L.push(`- Fits the bed: each print plate inside ${bed.map(n).join(' × ')} mm (a 90° turn is allowed).`);
  L.push(`- Overhang: under ${Math.round(K.overhangFrac * 100)} % of the surface faces down more than ${n(K.overhangDeg)}° from vertical, as printed.`);
  L.push(`- Bed contact: a plate taller than ${n(K.bedContactTallMm)} mm stands on at least ${n(K.bedContactMm2)} mm² of flat first layer.`);
  L.push(`- Clearance: no overlap with neighbours.stl${K.presets.length ? ` (the robot at ${K.presets.join(', ')})` : ''}.`);
  for (const line of K.camera) L.push(`- Camera: ${line}`);
  L.push(`- Limits: under ${thousands(K.maxFaces)} faces in all; everything within ${n(K.maxReachMm / 1000)} m of the anchor.`);
  L.push(`- part.json parses, has schema ${PART_SCHEMA}, and every file it names exists.`);

  h('6 Context pack');
  L.push(c.folder ? `In \`${c.folder}/${CONTEXT_DIR}/${S.id}/\` (or the unzipped \`${S.id}-context.zip\`):`
    : `In the context zip the user gives you (\`${S.id}-context.zip\`), unzipped:`);
  for (const [path, what] of packIndex(c)) L.push(`- \`${path}\`: ${what}`);

  h('7 Deliverable');
  L.push(c.folder ? `One new folder in \`${c.folder}/\`, next to \`${CONTEXT_DIR}/\`:`
    : 'One new folder, which the user drops into the studio (a zip of it works too):');
  L.push('```');
  L.push(`${c.folder ? c.folder + '/' : ''}${c.newId}/`);
  L.push('  part.json');
  L.push(`  mesh/<mesh-id>.stl          as fitted, frame "${S.frame || 'robot'}"`);
  L.push('  print/<mesh-id>_PRINT.stl   the same solid on the bed, +Z up');
  L.push('```');
  L.push(`- STL in mm, closed, in the frame the slot uses (${S.frame || 'robot'}: coordinates as fitted, no extra transform).`);
  L.push('- The folder name and part.json `id` match: letters, digits, - or _. Rename it if you like.');
  if (c.parts.some((p) => p.hardware)) L.push('- Hardware meshes stay as they are: copy them from `current/` unless the request moves them.');
  if (c.parts.some((p) => p.printRef)) L.push('- A `"print": "part:<id>"` plate is shared with other parts; keep it unless that mesh changes.');
  const flat = c.parts.filter((p) => needsPlate(p) && !p.printStlBytes).map((p) => `\`${p.id}\``);
  if (flat.length) L.push(`- ${flat.join(', ')} ${flat.length === 1 ? 'has no print pose yet: lay it' : 'have no print pose yet: lay each'} flat on its largest face for its plate.`);
  if (Object.keys(c.slot.params || {}).length) L.push('- `params` holds the fitted hinge: keep its shape, move `origin` and `axis` with the hinge, keep `moves` in step with `meshes`.');
  L.push('- Write part.json last; the studio reads a folder once it has not changed for 2 s.');
  L.push('part.json, pre-filled (the same file is `part.json` in the pack, full precision):');
  L.push('```json');
  L.push(compactJson(partTemplate(ctx)));
  L.push('```');

  h('8 Tools');
  L.push('Any tool: CadQuery, build123d, OpenSCAD, trimesh. Export binary STL in mm, one closed solid per file.');
  L.push('Keep the generating script in the part folder so the design can be rebuilt.');

  h('9 Request');
  L.push(String(request == null ? '' : request).replace(/\r\n?/g, '\n').replace(/\s+$/, ''));
  L.push('');
  L.push('If the request conflicts with section 4, keep section 4 and explain why in part.json "notes".');
  return L.join('\n') + '\n';
}

/** [path, one-line description] for every file of the pack. */
function packIndex(c) {
  const out = [
    ['README.txt', 'what each file is and where to write the result'],
    ['prompt.md', 'this prompt'],
  ];
  for (const p of c.parts) {
    out.push([partFile(p), `\`${p.id}\` as fitted, robot frame, mm`]);
    if (p.printStlBytes) out.push([printFile(p), `\`${p.id}\` in its print orientation`]);
  }
  if (c.current.partJson) out.push(['current/part.json', 'the fitted part.json']);
  out.push(['interface.json', 'anchor, mount, cameras, keep-outs, full part notes']);
  if (c.neighbours) out.push(['neighbours.stl', c.neighbours.note || 'nearby parts, decimated, robot frame, for clearance']);
  out.push(['part.json', 'the template of section 7']);
  out.push(['checks.json', 'the section 5 thresholds and the printer']);
  return out;
}

function readme(c) {
  return [
    `Context for a new ${c.slot.label || c.slot.id} (${c.slot.id}) on ${c.robot.name || c.robot.id}.`,
    'prompt.md       the full brief; start there.',
    'current/        the fitted part(s) as STL, robot frame, mm.',
    'interface.json  anchor, mount, cameras and keep-outs: what the new part must respect.',
    'neighbours.stl  the parts around the slot, for clearance.',
    'part.json       the template to fill in; checks.json the thresholds the studio applies.',
    c.folder ? `Write the result to ${c.folder}/${c.newId}/ (part.json, mesh/, print/).`
      : `Write the result as a folder ${c.newId}/ (part.json, mesh/, print/) and give it to the user to drop into the studio.`,
    c.folder ? 'The studio picks it up within a few seconds and shows it under the slot options.'
      : 'The studio checks it when it is dropped in and shows it under the slot options.',
  ].join('\n') + '\n';
}

/** Every file of the pack as Map<relpath, Uint8Array>. */
export function contextFiles(ctx, request) {
  const c = resolve(ctx);
  const files = new Map();
  const json = (v) => strToU8(JSON.stringify(v, null, 2) + '\n');
  files.set('README.txt', strToU8(readme(c)));
  files.set('prompt.md', strToU8(buildPrompt(ctx, request)));
  for (const p of c.parts) {
    if (p.stlBytes) files.set(partFile(p), p.stlBytes);
    if (p.printStlBytes) files.set(printFile(p), p.printStlBytes);
  }
  if (c.current.partJson) files.set('current/part.json', json(c.current.partJson));
  files.set('interface.json', json({
    robot: { id: c.robot.id, name: c.robot.name, units: c.robot.units || 'mm', frame: c.robot.frame, groundZ: c.robot.groundZ },
    slot: { id: c.slot.id, label: c.slot.label, frame: c.slot.frame || 'robot', anchor: c.slot.anchor || null,
      interface: c.slot.interface || {}, mount: c.slot.mount || null, params: c.slot.params || {}, keepOuts: c.slot.keepOuts || [] },
    current: { id: c.current.id || null, label: c.current.label || null },
    cameras: c.cameras,
    parts: c.parts.map((p) => ({ id: p.id, name: p.name, bbox: p.bbox, volume_cm3: p.volume, mass_g: p.mass,
      hardware: !!p.hardware, print: p.printRef || null, note: p.note || '' })),
    constraints: c.constraints,
  }));
  if (c.neighbours && c.neighbours.stlBytes) files.set('neighbours.stl', c.neighbours.stlBytes);
  files.set('part.json', json(partTemplate(ctx)));
  files.set('checks.json', json({ checks: c.checks, printer: c.printer }));
  return files;
}

/** The pack as one zip (`<slot>-context.zip`), byte-identical for the same ctx and date. */
export function buildContextPack(ctx, request) {
  const tree = {};
  for (const [p, bytes] of contextFiles(ctx, request)) tree[p] = [bytes, { level: /\.stl$/.test(p) ? 6 : 9 }];
  return zipFiles(tree);
}

export const packName = (ctx) => `${(ctx.slot && ctx.slot.id) || 'part'}-context.zip`;

/** Remove `_context/<slot>/prompt.md`: the request changed after it was written. */
export async function removeContextPrompt(handle, slotId) {
  try {
    const dir = await (await handle.getDirectoryHandle(CONTEXT_DIR)).getDirectoryHandle(slotId);
    await dir.removeEntry('prompt.md');
    return true;
  } catch (e) { return false; }
}

/** Write the pack to `<linked>/_context/<slot>/`, replacing the previous one.  Returns the paths. */
export async function writeContextToFolder(handle, ctx, request) {
  const sid = (ctx.slot && ctx.slot.id) || 'part';
  const root = await handle.getDirectoryHandle(CONTEXT_DIR, { create: true });
  try { await root.removeEntry(sid, { recursive: true }); } catch (e) { /* first write */ }
  const files = [...contextFiles(ctx, request)];
  await writeTree(await root.getDirectoryHandle(sid, { create: true }), files);
  return files.map(([rel]) => `${CONTEXT_DIR}/${sid}/${rel}`);
}
