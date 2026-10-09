/* core/package.js: embedded packages, a package zip round trip, a URDF zip, loose meshes,
 * compositions, readable errors and the recent-designs store. */

import * as THREE from 'three';
import { zipSync, strToU8, unzipSync, strFromU8 } from 'fflate';
import { RobotModel, matrixMaxDiff, mat4 } from '../../../src/core/robot-model.js';
import * as P from '../../../src/core/package.js';
import { ROBOTS, loadGeometry } from '../../../src/data/assets.js';
import * as V3 from '../fixtures/v3-reference.mjs';
import { test, run, close, closeMatrix, rejects, throws, ok, eq, installDOM } from './_harness.mjs';

const TOL = 1e-6;

/* a light subset of LeKiwi: enough to round-trip real geometry without zipping 59 MB */
const SUBSET = ['base_plate_layer1-v5', '4-Omni-Directional-Wheel_Single_Body-v1',
  '4-Omni-Directional-Wheel_Single_Body-v1-1', 'STS3215_03a-v1', 'Moving_Jaw_08d-v1',
  'Wrist_Roll_08c-v1', 'Camera-Model-v3'];

await P.listEmbedded();
const COMPOSED = P.embeddedManifest('lekiwi-pincopen');
const N_COMPOSED = COMPOSED.components.length;
const N_PINCOPEN = ROBOTS.pincopen.manifest.components.length;

function subsetManifest() {
  const m = ROBOTS.lekiwi.manifest;
  return { ...m, id: 'lekiwi-subset', components: m.components.filter((c) => SUBSET.includes(c.id)) };
}

/* embedded */

test('loadEmbedded — the two shipped robots load and the composition resolves', async () => {
  const ids = await P.listEmbedded();
  eq(ids.join(','), 'lekiwi,lekiwi-pincopen');
  ok(ROBOTS.pincopen && !P.isEmbeddedRobot('pincopen'), 'pincopen ships as an attachment package only');

  const m = await P.loadEmbedded('lekiwi-pincopen');
  eq(m.attachments.length, 1);
  eq(m.attachments[0].id, 'pincopen');
  eq(m.attachments[0].frame, 'wrist_flange');
  eq(m.components.length, N_COMPOSED + N_PINCOPEN);
  eq(m.components.length, 78);
  eq(m.components.filter((c) => c.id.startsWith('pincopen/')).length, N_PINCOPEN);

  await m.loadGeometries();
  eq(m.components.filter((c) => !c.geometry).length, 0, 'every component must have geometry');
  const wheels = m.components.filter((c) => /^4-Omni/.test(c.id));
  eq(wheels.length, 3);
  ok(wheels[0].geometry === wheels[1].geometry && wheels[1].geometry === wheels[2].geometry,
    'a cross-package mesh_ref must still resolve to ONE shared geometry');
  const box = m.boundingBox();
  eq(box.missing, 0);

  /* the placement the whole studio depends on */
  closeMatrix('wrist flange vs matrix_at_zero', m.frameMatrix('wrist_flange'),
    mat4(COMPOSED.frames.wrist_flange.matrix_at_zero), TOL);
  closeMatrix('wrist flange vs the v3 number', m.frameMatrix('wrist_flange'),
    mat4(V3.v3Frames().wrist_mount.matrix), TOL);

  await rejects('unknown robot id', P.loadEmbedded('nope'), /unknown robot "nope"/);
});

test('resolveComposition — an attachment at a frame the base does not have is refused', async () => {
  const base = ROBOTS.lekiwi.manifest;
  const pinc = async () => ROBOTS.pincopen.manifest;

  /* undeclared: the schema check catches it before anything is built */
  await rejects('undeclared attachment frame',
    P.resolveComposition({ ...base, attachments: [{ package: 'pincopen', at: 'nowhere' }] }, { resolvePackage: pinc }),
    /frame "nowhere" is not declared in frames/);

  /* declared but not a pose (deck_grid is pitch/radius data): resolveComposition catches it */
  await rejects('attachment at a data-only frame',
    P.resolveComposition({ ...base, attachments: [{ package: 'pincopen', at: 'deck_grid' }] }, { resolvePackage: pinc }),
    /frame "deck_grid", which is not one of/);

  /* and a package that is nowhere to be found */
  await rejects('unresolvable attachment package',
    P.resolveComposition({ ...base, attachments: [{ package: 'ghost', at: 'wrist_flange' }] },
      { resolvePackage: async () => null }),
    /cannot resolve attachment "ghost"/);
});

/* zip: package */

test('importZip — a robot.json package round-trips through fflate', async () => {
  const src = await P.loadEmbedded('lekiwi');
  const trimmed = { ...subsetManifest() };
  const model = (await P.resolveComposition(trimmed, {
    geometryLoader: () => (k) => loadGeometry('lekiwi', k)
  }));
  await model.loadGeometries();

  const zip = P.exportPackageZip(model, { readme: '# test package\n' });
  const back = await P.importZip(zip);
  eq(back.kind, 'package');
  ok(back.report.ok, back.report.errors.join('; '));
  eq(back.model.components.length, SUBSET.length);

  /* every world matrix survives the trip */
  let worst = 0, id = '';
  for (const c of model.components) {
    const e = matrixMaxDiff(model.worldMatrix(c.id), back.model.worldMatrix(c.id));
    if (e > worst) { worst = e; id = c.id; }
  }
  ok(worst <= TOL, id);

  await back.model.loadGeometries();
  for (const c of model.components) eq(c.geometry.attributes.position.count, back.model.component(c.id).geometry.attributes.position.count, c.id);
  /* the wheels are still one shared geometry on the far side */
  const w = back.model.components.filter((c) => /^4-Omni/.test(c.id));
  eq(w.length, 2);
  ok(w[0].geometry === w[1].geometry, 'instanced meshes must stay shared after import');
  ok(src.components.length > back.model.components.length);
});

test('importZip — a package zip nested in a folder, and a composition zip', async () => {
  const sub = subsetManifest();
  const pinc = { ...ROBOTS.pincopen.manifest, components: ROBOTS.pincopen.manifest.components.slice(0, 2) };
  const comp = { ...sub, id: 'combo', attachments: [{ package: 'pincopen', at: 'wrist_flange', local: null }] };
  const zip = zipSync({
    'combo/robot.json': strToU8(JSON.stringify(comp)),
    'combo/robots/pincopen/robot.json': strToU8(JSON.stringify(pinc))
  });
  const out = await P.importZip(zip);
  eq(out.kind, 'package');
  eq(out.model.id, 'combo');
  eq(out.model.attachments.length, 1);
  eq(out.model.components.length, SUBSET.length + 2);
  ok(out.warnings.length > 0, 'meshes absent from the zip must be reported, not silently dropped');
});

test('importZip — readable errors', async () => {
  await rejects('not a zip', P.importZip(new Uint8Array([1, 2, 3, 4])), /not a readable zip/);
  await rejects('nothing to import', P.importZip(zipSync({ 'notes.txt': strToU8('hello') })), /no robot\.json, no \.urdf/);
  const badJson = zipSync({ 'robot.json': strToU8('{ "schema": "rps/robot@1" }') });
  await rejects('invalid robot.json', P.importZip(badJson), /id is required/);
  const notJson = zipSync({ 'robot.json': strToU8('{oops') });
  await rejects('malformed robot.json', P.importZip(notJson), /not valid JSON/);
  const attachment = zipSync({ 'pincopen/robot.json': strToU8(JSON.stringify(ROBOTS.pincopen.manifest)) });
  await rejects('an attachment package', P.importZip(attachment), /attachment, not a robot/);
});

/* zip: URDF */

test('importZip — a URDF + meshes zip becomes a package with one component per visual', async () => {
  await installDOM();
  const urdf = `<?xml version="1.0"?><robot name="arm2">
    <link name="base"><visual><origin xyz="0 0 0.005" rpy="0 0 0"/>
      <geometry><mesh filename="package://arm2/meshes/cube.stl" scale="0.001 0.001 0.001"/></geometry></visual></link>
    <link name="tip"><visual><origin xyz="0 0 0" rpy="0 0 0"/>
      <geometry><mesh filename="meshes/cube.stl" scale="0.001 0.001 0.001"/></geometry></visual></link>
    <joint name="hinge" type="revolute"><parent link="base"/><child link="tip"/>
      <origin xyz="0 0 0.04" rpy="0 0 0"/><axis xyz="1 0 0"/>
      <limit lower="0" upper="0.7853981634" effort="1" velocity="1"/></joint></robot>`;
  const cube = P.stlBytes(new THREE.BoxGeometry(10, 10, 10).toNonIndexed());
  const zip = zipSync({ 'arm2/urdf/arm2.urdf': strToU8(urdf), 'arm2/meshes/cube.stl': cube });
  const out = await P.importZip(zip);
  eq(out.kind, 'urdf');
  eq(out.manifest.schema, 'rps/robot@1');
  eq(out.model.components.length, 2);
  eq(out.model.joints.length, 1);
  eq(out.model.rootLink, 'base');
  ok(out.report.ok, out.report.errors.join('; '));
  eq(out.model.components[0].mesh, out.model.components[1].mesh);
  eq(out.model.components[0].frame, 'mesh');
  ok(out.model.components[0].geometry, 'the mesh in the zip must be parsed');
  eq(out.model.components[0].geometry.attributes.position.count, 36);
  /* limits in degrees, and the chain moves */
  close('hinge upper limit', out.model.jointLimits().hinge.upper, 45, 1e-9, '°');
  close('base visual Z', out.model.components[0].local.elements[14], 5, 1e-9, 'mm');
  out.model.setJoints({ hinge: 90 });
  const t = new THREE.Vector3().setFromMatrixPosition(out.model.fk('tip'));
  close('tip after hinge 90°, Y', t.y, 0, 1e-9, 'mm');
  close('tip after hinge 90°, Z', t.z, 40, 1e-9, 'mm');
  /* a mesh the URDF names but the zip lacks is a warning, never a crash */
  const missing = zipSync({ 'a.urdf': strToU8(urdf.replace('cube.stl', 'ghost.stl')) });
  const out2 = await P.importZip(missing);
  ok(out2.warnings.some((w) => /ghost\.stl/.test(w)), out2.warnings.join('; '));
});

/* loose files */

test('importFiles — loose STLs become an assembly-only robot in the robot frame', async () => {
  const a = P.stlBytes(new THREE.BoxGeometry(20, 20, 20).toNonIndexed());
  const b = P.stlBytes(new THREE.BoxGeometry(5, 5, 40).toNonIndexed());
  const out = await P.importFiles([
    { name: 'Bracket v2.stl', bytes: a },
    { name: 'post.stl', bytes: b },
    { name: 'readme.txt', bytes: strToU8('nope') }
  ]);
  eq(out.kind, 'meshes');
  eq(out.model.components.length, 2);
  eq(out.model.joints.length, 0);
  eq(out.model.rootLink, null);
  eq(out.model.components[0].id, 'bracket-v2');
  eq(out.model.components[0].frame, 'robot');
  ok(out.model.components.every((c) => c.printable), 'an imported part is printable by default');
  ok(out.warnings.some((w) => /readme\.txt/.test(w)));
  /* frame "robot" means the local IS the world matrix */
  closeMatrix('identity placement', out.model.worldMatrix('post'), new THREE.Matrix4(), 0);
  const box = out.model.boundingBox();
  close('assembly bbox Z', box.max.z - box.min.z, 40, 1e-3, 'mm');
  await rejects('no meshes at all', P.importFiles([{ name: 'a.txt', bytes: a }]), /no \.stl\/\.3mf\/\.obj/);
});

test('importFiles — keeps the bytes, so the import reopens like a zip does', async () => {
  const mem = new Map();
  P.setRecentStore({ get: async (k) => mem.get(k), set: async (k, v) => { mem.set(k, v); }, del: async (k) => { mem.delete(k); } });
  const a = P.stlBytes(new THREE.BoxGeometry(20, 20, 20).toNonIndexed());
  const b = P.stlBytes(new THREE.BoxGeometry(5, 5, 40).toNonIndexed());
  const out = await P.importFiles([{ name: 'bracket.stl', bytes: a }, { name: 'post.stl', bytes: b }]);
  ok(await P.loadImportedPackage(out.model.id), 'no rps/imported@1 record was written at all');

  const back = await P.reopenImported(out.model.id);
  ok(back && back.model, 'reopenImported answered null, which is what bounced the page Home');
  eq(back.model.id, out.model.id, 'the SAME route id, so the Recents row lands on this design');
  eq(back.model.components.length, out.model.components.length);
  eq(back.model.components.map((c) => c.id).join(','), out.model.components.map((c) => c.id).join(','));
  await back.model.loadGeometries();
  eq(back.model.component('bracket').geometry.attributes.position.count, 36);

  /* an import into the OPEN robot is not a robot of its own and must not take a slot */
  const one = await P.importFiles([{ name: 'clip.stl', bytes: a }], { remember: false });
  eq(await P.loadImportedPackage(one.model.id), null, 'remember:false keeps the store clean');
  await P.clearRecent();
});

test('importZip — two URDFs: one is imported and the other is NAMED', async () => {
  await installDOM();
  const one = `<?xml version="1.0"?><robot name="AlphaBot">
    <link name="base"><visual><geometry><mesh filename="meshes/cube.stl"/></geometry></visual></link></robot>`;
  const two = one.replace('AlphaBot', 'BetaBot');
  const cube = P.stlBytes(new THREE.BoxGeometry(10, 10, 10).toNonIndexed());
  const zip = zipSync({ 'rob/alpha.urdf': strToU8(one), 'rob/beta.urdf': strToU8(two), 'rob/meshes/cube.stl': cube });
  const out = await P.importZip(zip, { remember: false });
  eq(out.kind, 'urdf');
  const w = out.warnings.find((x) => /URDFs/.test(x));
  ok(w, 'beta.urdf was dropped with no warning at all — ' + out.warnings.join('; '));
  ok(/rob\/alpha\.urdf/.test(w), w);
  ok(/rob\/beta\.urdf/.test(w), w);
});

test('importFiles — an OBJ is parsed too', async () => {
  const obj = 'v 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n';
  const out = await P.importFiles([{ name: 'tri.obj', bytes: strToU8(obj) }]);
  eq(out.model.components.length, 1);
  await out.model.loadGeometries();
  const g = out.model.component('tri').geometry;
  ok(g, 'the OBJ must produce geometry');
  eq(g.attributes.position.count, 3);
});

/* recents */

test('saveRecent / listRecent — newest first, de-duplicated by id, never throws', async () => {
  const mem = new Map();
  P.setRecentStore({ get: async (k) => mem.get(k), set: async (k, v) => { mem.set(k, v); }, del: async (k) => { mem.delete(k); } });
  await P.saveRecent({ id: 'a', robot: 'lekiwi', label: 'first' });
  await P.saveRecent({ id: 'b', robot: 'lekiwi', label: 'second' });
  await P.saveRecent({ id: 'a', robot: 'lekiwi', label: 'first again' });
  const list = await P.listRecent();
  eq(list.length, 2);
  eq(list[0].id, 'a');
  eq(list[0].label, 'first again');
  eq(list[1].id, 'b');
  ok(list[0].savedAt >= list[1].savedAt);
  await P.removeRecent('b');
  eq((await P.listRecent()).length, 1);
  await P.clearRecent();
  eq((await P.listRecent()).length, 0);
  /* a store that throws must read as empty, not crash the Home page */
  P.setRecentStore({ get: async () => { throw new Error('IDB blocked'); }, set: async () => {}, del: async () => {} });
  eq((await P.listRecent()).length, 0);
});

/* stl bytes */

test('stlBytes writes a valid binary STL and refuses what is not whole triangles, in a sentence', () => {
  const bytes = P.stlBytes(new THREE.BoxGeometry(1, 1, 1).toNonIndexed());
  eq(bytes.length, 84 + 12 * 50);
  eq(new DataView(bytes.buffer, bytes.byteOffset).getUint32(80, true), 12);
  eq(P.parseMesh(bytes, 'cube.stl').attributes.position.count, 36);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
  throws('4 vertices', () => P.stlBytes(g), /not a whole number of triangles/);
  throws('no position', () => P.stlBytes(new THREE.BufferGeometry()), /position attribute/);
  g.setIndex([0, 1, 2, 0, 2]);
  throws('5 indices', () => P.stlBytes(g), /5 indices/);
});

test('resolveComposition refuses a cycle instead of overflowing the stack', async () => {
  const A = { schema: P.ROBOT_SCHEMA, id: 'aaa', name: 'A', links: ['root'], components: [],
    frames: { mount: { link: 'root' } }, attachments: [{ package: 'bbb', at: 'mount' }] };
  const B = { schema: P.ROBOT_SCHEMA, id: 'bbb', name: 'B', links: ['root'], components: [],
    frames: { mount: { link: 'root' } }, attachments: [{ package: 'aaa', at: 'mount' }] };
  const msg = await rejects('A ⇄ B', P.resolveComposition(A, { packages: { aaa: A, bbb: B } }),
    /attaches itself/);
  ok(/aaa → bbb → aaa/.test(msg), msg);
  /* a self-attachment is the same sentence, not a RangeError */
  const self = { ...A, attachments: [{ package: 'aaa', at: 'mount' }] };
  await rejects('A ⇄ A', P.resolveComposition(self, { packages: { aaa: self } }), /attaches itself/);
});

test('an exported composition zip re-imports (attachments and their meshes travel)', async () => {
  const model = await P.loadEmbedded('lekiwi-pincopen');
  await model.loadGeometries();
  const zip = P.exportPackageZip(model);
  const entries = unzipSync(zip);
  const names = Object.keys(entries);
  ok(names.includes('robots/pincopen/robot.json'),
    'only ownComponents were walked, so the attached package was never written');

  /* a composition zip carries what it attaches, or the import cannot resolve it */
  const back = await P.importZip(zip);
  eq(back.kind, 'package');
  eq(back.model.attachments.length, 1);
  eq(back.model.components.length, model.components.length);
  await back.model.loadGeometries();
  const missing = back.model.components.filter((c) => c.mesh && !c.geometry).map((c) => c.id);
  eq(missing.length, 0, 'every attached mesh came back: ' + missing.slice(0, 4).join(', '));

  /* every mesh landed on its own zip entry — a basename collision drops one */
  const meshKeys = new Set(back.model.components.filter((c) => c.mesh).map((c) => c.mesh));
  for (const k of meshKeys) ok(entries[k] || entries[k.replace(/^\.\//, '')], 'no entry for ' + k);
});

test('two meshes with the same basename do not overwrite each other', () => {
  const manifest = {
    schema: P.ROBOT_SCHEMA, id: 'dup', name: 'dup', links: ['root'],
    components: [{ id: 'a', link: 'root', mesh: 'a/part.stl' }, { id: 'b', link: 'root', mesh: 'b/part.stl' }],
  };
  const meshes = {
    'a/part.stl': new THREE.BoxGeometry(10, 10, 10).toNonIndexed(),
    'b/part.stl': new THREE.BoxGeometry(20, 20, 20).toNonIndexed(),
  };
  const built = RobotModel.fromPackage(manifest, (k) => meshes[k] || null);
  const entries = unzipSync(P.exportPackageZip(built));
  const written = Object.keys(entries).filter((n) => n.startsWith('meshes/'));
  eq(written.length, 2, 'both flattened to meshes/part.stl and one was lost — ' + written.join(', '));
  const mf = JSON.parse(strFromU8(entries['robot.json']));
  eq(new Set(mf.components.map((c) => c.mesh)).size, 2, 'and the manifest points at both');
  for (const c of mf.components) ok(entries[c.mesh], 'no zip entry for ' + c.mesh);
  /* the two are still different meshes, not the same one twice */
  const sizes = mf.components.map((c) => entries[c.mesh].length);
  ok(sizes[0] === sizes[1], 'a cube is a cube');
  const va = P.parseMesh(entries[mf.components[0].mesh], 'a.stl').attributes.position.array;
  const vb = P.parseMesh(entries[mf.components[1].mesh], 'b.stl').attributes.position.array;
  ok(Math.max(...va.map(Math.abs)) !== Math.max(...vb.map(Math.abs)), '10 mm and 20 mm both survived');
});

test('the basename fallback never reaches a __MACOSX resource fork', async () => {
  const box = new THREE.BoxGeometry(10, 10, 10).toNonIndexed();
  const stl = P.stlBytes(box);
  const manifest = {
    schema: P.ROBOT_SCHEMA, id: 'fork', name: 'fork', links: ['root'],
    components: [{ id: 'a', link: 'root', mesh: 'meshes/part.stl' }],
  };
  /* the resource fork sorts FIRST in the zip and is not a mesh at all */
  const zip = zipSync({
    '__MACOSX/meshes/._part.stl': strToU8('Mac OS X resource fork, not an STL'),
    'robot.json': strToU8(JSON.stringify(manifest)),
    'other/part.stl': stl,
  });
  const back = await P.importZip(zip);
  eq(back.model.components.length, 1);
  await back.model.loadGeometries();
  ok(back.model.component('a').geometry, 'the real STL beside it is what was parsed');
  eq(back.model.component('a').geometry.attributes.position.count, 36);
  ok(!back.files.some((n) => n.includes('__MACOSX')), 'and the fork is not even listed');
});

test('zipFiles writes 2000-01-01 00:00 into every entry, whatever the timezone', () => {
  const tz = process.env.TZ;
  const dos = (20 << 9) | (1 << 5) | 1;
  try {
    for (const zone of ['UTC', 'Asia/Seoul', 'America/Los_Angeles']) {
      process.env.TZ = zone;
      const z = P.zipFiles({ 'a.stl': new Uint8Array(84), 'design.json': strToU8('{}') });
      const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
      for (let o = 0, n = 0; n < 2; n++) {
        eq(dv.getUint32(o, true), 0x04034b50, zone + ' local header');
        eq(dv.getUint16(o + 10, true), 0, zone + ' time');
        eq(dv.getUint16(o + 12, true), dos, zone + ' date');
        o += 30 + dv.getUint16(o + 26, true) + dv.getUint16(o + 28, true) + dv.getUint32(o + 18, true);
      }
      eq(strFromU8(unzipSync(z)['design.json']), '{}');
    }
  } finally { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; }
});

await run('core/package — embedded, zip, URDF, loose files, recents');
