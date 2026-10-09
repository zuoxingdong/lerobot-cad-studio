/* features/context-pack.js on a fixed corner-mast ctx: section order, the request last and
   verbatim, vendor-neutral text, determinism, the golden prompt, the pack round trip.
   RPS_UPDATE_GOLDEN=1 rewrites the golden file. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import {
  buildPrompt, buildContextPack, contextFiles, partTemplate, writeContextToFolder, removeContextPrompt, packName, NOTE_MAX,
} from '../../../src/features/context-pack.js';
import { validatePartFolder } from '../../../src/features/part-folder.js';
import { createLinkFolder } from '../../../src/core/link-folder.js';
import { FakeDir, fakeIdb, fakeWindow, boxStl } from '../fixtures/agent/fake-fs.mjs';

const DIR = fileURLToPath(new URL('../fixtures/agent/', import.meta.url));
const GOLDEN = DIR + 'mast-prompt.golden.md';
const REQUEST = 'same mast head, 20 mm shorter, keep 45°';
const FORBIDDEN = ['claude', '~/', '/home/', 'ai-space/', 'docs/', 'studio/legacy/'];

function mastCtx() {
  const ctx = JSON.parse(readFileSync(DIR + 'mast-ctx.json', 'utf8'));
  for (const p of ctx.parts) {
    p.stlBytes = boxStl(p.bbox.min, p.bbox.max);
    if (p.hasPrint) p.printStlBytes = boxStl([0, 0, 0], p.bbox.max.map((v, k) => v - p.bbox.min[k]));
    delete p.hasPrint;
  }
  ctx.neighbours.stlBytes = boxStl([-150, -150, -33], [150, 150, 57]);
  return ctx;
}

test('nine sections in order, context first, the request last and verbatim', () => {
  const p = buildPrompt(mastCtx(), REQUEST);
  const heads = p.split('\n').filter((l) => l.startsWith('## '));
  assert.deepEqual(heads, ['## 1 Role', '## 2 Robot', '## 3 Target', '## 4 Hard interface (must hold)',
    '## 5 Self-check before you finish (the studio runs these)', '## 6 Context pack', '## 7 Deliverable',
    '## 8 Tools', '## 9 Request']);
  assert.ok(p.endsWith(`## 9 Request\n${REQUEST}\n\nIf the request conflicts with section 4, keep section 4 and explain why in part.json "notes".\n`));

  const odd = 'Make it *taller*:\n  - 30 mm\n```\nkeep `head`\n```\n# not a heading of ours';
  const q = buildPrompt(mastCtx(), odd);
  const tail = q.slice(q.indexOf('## 9 Request\n') + 13);
  assert.equal(tail.split('\n\nIf the request conflicts')[0], odd);
});

test('vendor-neutral, no local paths, ≤ 120 lines, notes trimmed', () => {
  const p = buildPrompt(mastCtx(), REQUEST);
  const low = p.toLowerCase();
  for (const f of FORBIDDEN) assert.ok(!low.includes(f), `prompt contains "${f}"`);
  const lines = p.split('\n').length;
  assert.ok(lines <= 120, `${lines} lines`);
  const noteLines = p.split('\n').filter((l) => l.startsWith('    ') && !l.startsWith('    {'));
  assert.ok(noteLines.length >= 5);
  for (const l of noteLines) assert.ok(l.trim().length <= NOTE_MAX, l);
  assert.match(p, /hFOV 87\.3°, vFOV 71\.1°, aspect 4:3/);
  assert.match(p, /origin \(0, -36\.5, 57\) mm; axes X \(1, 0, 0\), Y \(0, 1, 0\), Z \(0, 0, 1\)/);
  assert.match(p, /lekiwi-designs\/corner_mast_printed-v2\//);
  for (const f of FORBIDDEN) {
    for (const [path, bytes] of contextFiles(mastCtx(), REQUEST)) {
      if (!/\.stl$/.test(path)) assert.ok(!strFromU8(bytes).toLowerCase().includes(f), `${path} contains "${f}"`);
    }
  }
});

test('deterministic for a fixed date; matches the golden prompt', () => {
  const a = buildPrompt(mastCtx(), REQUEST), b = buildPrompt(mastCtx(), REQUEST);
  assert.equal(a, b);
  if (process.env.RPS_UPDATE_GOLDEN) writeFileSync(GOLDEN, a);
  assert.equal(a, readFileSync(GOLDEN, 'utf8'), 'golden prompt changed: rerun with RPS_UPDATE_GOLDEN=1 and review the diff');
  const z1 = buildContextPack(mastCtx(), REQUEST), z2 = buildContextPack(mastCtx(), REQUEST);
  assert.equal(Buffer.compare(Buffer.from(z1), Buffer.from(z2)), 0, 'zip bytes are stable');
  const other = buildPrompt({ ...mastCtx(), date: '2026-10-01' }, REQUEST);
  assert.notEqual(other, a);
  assert.match(other, /"source": "agent 2026-10-01"/);
});

test('the pack holds every listed file; part.json is pre-filled', () => {
  const ctx = mastCtx();
  const z = unzipSync(buildContextPack(ctx, REQUEST));
  assert.equal(packName(ctx), 'top_camera_mount-context.zip');
  assert.deepEqual(Object.keys(z).sort(), [
    'README.txt', 'checks.json', 'current/df200.stl', 'current/head.stl', 'current/head_print.stl',
    'current/retainer.stl', 'current/spar_lower.stl', 'current/spar_lower_print.stl', 'current/spar_upper.stl',
    'current/spar_upper_print.stl', 'interface.json', 'neighbours.stl', 'part.json', 'prompt.md']);
  assert.equal(strFromU8(z['prompt.md']), buildPrompt(ctx, REQUEST));
  assert.equal(strFromU8(z['README.txt']).trim().split('\n').length, 8);
  const tpl = JSON.parse(strFromU8(z['part.json']));
  assert.deepEqual([tpl.schema, tpl.robot, tpl.slot, tpl.frame, tpl.source, tpl.derived_from, tpl.id],
    ['rps/part@1', 'lekiwi-pincopen', 'top_camera_mount', 'robot', 'agent 2026-09-24', 'corner_mast_printed', 'corner_mast_printed-v2']);
  assert.equal(tpl.cameras.top.hfov_deg, 87.3);
  assert.equal(tpl.cameras.top.local.length, 16);
  assert.deepEqual(tpl.meshes.map((m) => m.print || (m.hardware ? 'hw' : null)),
    ['print/spar_lower_PRINT.stl', 'print/spar_upper_PRINT.stl', 'print/head_PRINT.stl', 'part:cam_retainer', 'hw']);
  assert.deepEqual(tpl, partTemplate(ctx));
  const iface = JSON.parse(strFromU8(z['interface.json']));
  assert.equal(iface.slot.anchor.name, 'deck_top_centre_rear');
  assert.ok(iface.parts[0].note.length > NOTE_MAX, 'the full note goes into the pack');
  const checks = JSON.parse(strFromU8(z['checks.json']));
  assert.deepEqual([checks.checks.overhangDeg, checks.checks.maxFaces, checks.printer.bed], [45, 500000, [256, 256, 256]]);
});

test('an agent that follows the template produces a folder the validator accepts', async () => {
  const ctx = mastCtx();
  const files = contextFiles(ctx, REQUEST);
  const tpl = JSON.parse(strFromU8(files.get('part.json')));
  const m = new Map([['part.json', new Blob([JSON.stringify(tpl)])]]);
  for (const mesh of tpl.meshes) {
    m.set(mesh.file, new Blob([files.get(`current/${mesh.id}.stl`)]));
    if (mesh.print && !mesh.print.startsWith('part:')) m.set(mesh.print, new Blob([files.get(`current/${mesh.id}_print.stl`)]));
  }
  const robot = { id: 'lekiwi-pincopen', partIds: ['corner_mast_printed', 'cam_retainer'],
    slots: { top_camera_mount: { anchor: ctx.slot.anchor.matrix, provides: ['cameras.top'] } } };
  const r = await validatePartFolder({ id: tpl.id, files: m }, robot);
  assert.deepEqual([r.ok, r.errors, r.warnings], [true, [], []]);
});

test('the template is the fitted state: label, mesh labels, and the hinge detent it was exported at', () => {
  const ctx = mastCtx();
  ctx.slot.params.tilt_deg.value = 60;
  ctx.slot.current.label = 'Corner mast, printed · 60°';
  const tpl = partTemplate(ctx);
  assert.equal(tpl.params.tilt_deg.design, 60, 'current/ is at 60°, so the design detent is 60°');
  assert.equal(tpl.params.tilt_deg.value, 60);
  assert.equal(tpl.label, 'Corner mast, printed v2 · 60°');
  assert.ok(tpl.meshes.every((m) => m.label && m.label !== m.id), JSON.stringify(tpl.meshes.map((m) => m.label)));
  const p = buildPrompt(ctx, REQUEST);
  assert.match(p, /hinge detents 40–65° usable \(70° exists but fails the camera checks\), now 60°/);
});

test('with no linked folder the prompt names the zip, never a placeholder path', () => {
  const ctx = mastCtx();
  delete ctx.folderName;
  const p = buildPrompt(ctx, REQUEST);
  assert.ok(!p.includes('<linked-folder>') && !p.includes('lekiwi-designs'), 'a folder path in the prompt');
  assert.match(p, /In the context zip the user gives you \(`top_camera_mount-context\.zip`\), unzipped:/);
  assert.match(p, /One new folder, which the user drops into the studio/);
  const readme = strFromU8(contextFiles(ctx, REQUEST).get('README.txt'));
  assert.match(readme, /give it to the user to drop into the studio/);
  const noPlate = mastCtx();
  delete noPlate.parts[0].printStlBytes;
  assert.match(buildPrompt(noPlate, REQUEST), /`spar_lower` has no print pose yet: lay it flat/);
});

test('writeContextToFolder writes _context/<slot>/, replaces it, and the poll ignores it', async () => {
  const root = new FakeDir('lekiwi-designs');
  root.put('_context/top_camera_mount/current/stale.stl', boxStl());
  const written = await writeContextToFolder(root, mastCtx(), REQUEST);
  assert.equal(written.length, 14);
  const paths = root.paths();
  assert.ok(!paths.includes('_context/top_camera_mount/current/stale.stl'), 'the previous pack is replaced');
  assert.ok(paths.includes('_context/top_camera_mount/part.json'));
  assert.equal(root.read('_context/top_camera_mount/prompt.md'), buildPrompt(mastCtx(), REQUEST));

  const lf = createLinkFolder({ window: fakeWindow(root), idb: fakeIdb() });
  const seen = [];
  lf.onChange((e) => seen.push(...e.added.map((f) => f.id)));
  await lf.pick(); await lf.scan(); await lf.scan();
  assert.deepEqual(seen, []);
  assert.equal(await removeContextPrompt(root, 'top_camera_mount'), true);
  assert.ok(!root.paths().includes('_context/top_camera_mount/prompt.md'), 'a stale prompt.md stayed');
  assert.ok(root.paths().includes('_context/top_camera_mount/part.json'));
});

test('an empty ctx still gives a well-formed prompt', () => {
  const p = buildPrompt({ robot: { id: 'r' }, slot: { id: 's' }, date: '2026-01-01' }, '');
  assert.equal(p.split('\n').filter((l) => l.startsWith('## ')).length, 9);
  assert.match(p, /\ns-v2\/\n/);
  assert.ok(!p.includes('<linked-folder>'));
  assert.ok(p.endsWith('## 9 Request\n\n\nIf the request conflicts with section 4, keep section 4 and explain why in part.json "notes".\n'));
});
