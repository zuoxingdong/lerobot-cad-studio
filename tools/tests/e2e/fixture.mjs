/* The zips the import cases need, built so they take the same path a user does.  `box-kit.zip`
 * is a one-part `rps/robot@1` package (robot.json + meshes/); `urdf-import.zip` is a two-link URDF
 * named `lekiwi`, which must not take the shipped package's route id; `corner_mast_printed.zip`
 * is the shipped corner mast as an `rps/part@1` folder (`part.json` + `mesh/` + `print/`);
 * `corner_mast_meta.zip` is the same mast as an older `rps/alternative@1` export (`meta.json`,
 * robot-frame meshes at the root, plates in `print/`).
 * They land in out/work/e2e/fixtures/ (served as /out/work/e2e/fixtures/); `run.mjs` rebuilds them every run. */
import fs from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { ROOT, E2E } from '../_root.mjs';

const DIR = path.join(E2E, 'fixtures');
const BOX = path.join(DIR, 'box-kit.zip');
const PART = path.join(ROOT, 'assets', 'parts', 'corner_mast_printed');
export const ALT_ZIP = path.join(DIR, 'corner_mast_printed.zip');
export const META_ZIP = path.join(DIR, 'corner_mast_meta.zip');

/** A binary STL of one axis-aligned box — 12 triangles, watertight; `unit` 1000 = metres. */
function cubeStl(size = 40, unit = 1000) {
  const h = size / 2;
  const v = [[-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h], [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]];
  const tris = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const t of tris) {
    for (let i = 0; i < 3; i++) dv.setFloat32(o + i * 4, 0, true);          // normal: let the loader compute
    o += 12;
    for (const idx of t) { for (let i = 0; i < 3; i++) dv.setFloat32(o + i * 4, v[idx][i] / unit, true); o += 12; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return new Uint8Array(buf);
}

/** A URDF zip whose robot NAME is `lekiwi` — the route-id collision the finding is about. */
function urdfZip() {
  const urdf = `<?xml version="1.0"?>
<robot name="lekiwi">
  <link name="base_link">
    <visual><origin xyz="0 0 0" rpy="0 0 0"/>
      <geometry><mesh filename="package://lekiwi/meshes/cube.stl"/></geometry></visual>
  </link>
  <link name="arm_link">
    <visual><origin xyz="0 0 0.05" rpy="0 0 0"/>
      <geometry><mesh filename="package://lekiwi/meshes/cube.stl"/></geometry></visual>
  </link>
  <joint name="shoulder" type="revolute">
    <parent link="base_link"/><child link="arm_link"/>
    <origin xyz="0 0 0.1" rpy="0 0 0"/><axis xyz="0 0 1"/>
    <limit lower="-1.57" upper="1.57" effort="1" velocity="1"/>
  </joint>
</robot>
`;
  return zipSync({ 'lekiwi/urdf/lekiwi.urdf': strToU8(urdf), 'lekiwi/meshes/cube.stl': cubeStl() });
}

/** A one-part robot package: robot.json and meshes/box.stl, in mm. */
function boxKitZip() {
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const doc = { schema: 'rps/robot@1', id: 'box-kit', name: 'Box kit', version: '1', units: 'mm', up: 'z',
    components: [{ id: 'box', label: 'Box', mesh: 'meshes/box.stl', frame: 'robot', local: I, group: 'body', printable: true }] };
  return zipSync({ 'box-kit/robot.json': strToU8(JSON.stringify(doc, null, 1)), 'box-kit/meshes/box.stl': cubeStl(30, 1) },
    { level: 6, mtime: new Date('2026-01-01T00:00:00Z') });
}

/** The shipped corner mast as an `rps/part@1` folder, zipped: part.json, mesh/, print/, the docs. */
function altZip() {
  const d = 'corner_mast_printed/';
  const read = (rel) => new Uint8Array(fs.readFileSync(path.join(PART, rel)));
  const files = {};
  for (const rel of ['part.json', 'DESIGN.md', 'ASSEMBLY.md']) files[d + rel] = read(rel);
  for (const sub of ['mesh', 'print']) {
    for (const f of fs.readdirSync(path.join(PART, sub)).sort()) files[`${d}${sub}/${f}`] = read(`${sub}/${f}`);
  }
  return zipSync(files, { level: 6, mtime: new Date('2026-01-01T00:00:00Z') });
}

/** The shipped corner mast as an `rps/alternative@1` export: meta.json, root meshes, print/. */
function metaZip() {
  const d = 'corner_mast_meta/';
  const part = JSON.parse(fs.readFileSync(path.join(PART, 'part.json'), 'utf8'));
  const prints = fs.readdirSync(path.join(PART, 'print')).sort();
  const meta = { schema: 'rps/alternative@1', slot: part.slot, label: 'Corner mast (meta.json export)',
    frame: part.frame, local: part.local, printable: true, cameras: part.cameras,
    print_files: prints.map((f) => 'print/' + f), source: part.source, notes: part.notes };
  const files = { [d + 'meta.json']: strToU8(JSON.stringify(meta, null, 1)) };
  for (const f of fs.readdirSync(path.join(PART, 'mesh')).sort()) files[d + f] = new Uint8Array(fs.readFileSync(path.join(PART, 'mesh', f)));
  for (const f of prints) files[`${d}print/${f}`] = new Uint8Array(fs.readFileSync(path.join(PART, 'print', f)));
  return zipSync(files, { level: 6, mtime: new Date('2026-01-01T00:00:00Z') });
}

export async function buildFixture(force = false) {
  fs.mkdirSync(DIR, { recursive: true });
  const urdf = path.join(DIR, 'urdf-import.zip');
  if (force || !fs.existsSync(urdf)) fs.writeFileSync(urdf, Buffer.from(urdfZip()));
  if (force || !fs.existsSync(ALT_ZIP)) fs.writeFileSync(ALT_ZIP, Buffer.from(altZip()));
  if (force || !fs.existsSync(META_ZIP)) fs.writeFileSync(META_ZIP, Buffer.from(metaZip()));
  if (force || !fs.existsSync(BOX)) fs.writeFileSync(BOX, Buffer.from(boxKitZip()));
  return BOX;
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const p = await buildFixture(true);
  console.log(path.relative(ROOT, p), fs.statSync(p).size, 'bytes');
}
