/* The packages ON DISK, for the tests that hold assets/ to the generator's rules: the raw
   robot.json / part.json files, and each robot resolved the way the page resolves it
   (core/compose.js), with every part plate's fitted bed pose from src/data/assets_manifest.json. */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './_root.mjs';
import { resolveRobot } from '../../src/core/compose.js';

export const STUDIO = ROOT;
export const ROBOTS_DIR = join(ROOT, 'assets', 'robots');
export const PARTS_DIR = join(ROOT, 'assets', 'parts');
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));

export const ids = readdirSync(ROBOTS_DIR).filter((d) => existsSync(join(ROBOTS_DIR, d, 'robot.json')));
export const raw = (id) => json(join(ROBOTS_DIR, id, 'robot.json'));
export const PART_DOCS = Object.fromEntries(readdirSync(PARTS_DIR)
  .filter((d) => !d.startsWith('_') && existsSync(join(PARTS_DIR, d, 'part.json')))
  .map((d) => [d, json(join(PARTS_DIR, d, 'part.json'))]));

const MAN = join(ROOT, 'src', 'data', 'assets_manifest.json');
const FITTED = existsSync(MAN) ? json(MAN).parts || {} : {};
const PARTS = Object.keys(PART_DOCS).map((id) => ({
  doc: FITTED[id] ? FITTED[id].part : PART_DOCS[id], owner: 'part:' + id, from: `assets/parts/${id}/`,
}));

const cache = new Map();
/** robot.json resolved to the flat rps/robot@1 form (a plain package passes through). */
export function load(id) {
  if (!cache.has(id)) {
    const r = resolveRobot(raw(id), { robot: (b) => ({ doc: load(b), meshes: new Map() }), parts: () => PARTS });
    cache.set(id, r.manifest);
  }
  return JSON.parse(JSON.stringify(cache.get(id)));
}
