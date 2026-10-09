// Where local runs land (gitignored): the finished products at the out/ top level, everything else under
// out/work/. The twin of tools/paths.py; tools/tests/paths.test.mjs keeps them equal.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STUDIO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = path.join(STUDIO, 'out');
export const WORK = path.join(OUT, 'work');
export const CACHE = path.join(WORK, 'cache');      // pack/ decimations, render/ CC0 downloads
export const RENDER = path.join(WORK, 'render');    // captures, .blend files, frames, stills, the bake
export const SIM = path.join(WORK, 'sim');          // sim exports and runs
export const E2E = path.join(WORK, 'e2e');
export const PRODUCTS = ['hero.mp4', 'hero_web.mp4', 'lab-task.mp4', 'teleop.mp4', 'draft.mp4', 'sim-report.md'];
