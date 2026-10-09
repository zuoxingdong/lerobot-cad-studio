/* One ROOT, one static server, one set of Chrome flags.  Everything under tools/tests/
   imports this, so the layout is known in exactly one place.  The server is tools/build/serve.mjs. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E } from '../paths.mjs';
import { BASE, serve as serveRoutes, pageUrl, listen } from '../build/serve.mjs';

/** the repo root: `tools/tests/` -> `studio/` */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** the Pages root (`npm run build` writes it) and the e2e outputs (tools/paths.mjs, gitignored) */
export const SITE = path.join(ROOT, 'site');
export { E2E, BASE, pageUrl, listen };

/**
 * The browser to drive: `$CHROME`, else the first of the usual names on PATH.
 * CI images spell it `google-chrome` or `chromium-browser` depending on the distro.
 */
export function chromeBinary() {
  if (process.env.CHROME) return process.env.CHROME;
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']) {
    for (const d of dirs) {
      const p = path.join(d, name);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { /* next */ }
    }
  }
  return 'google-chrome';                 // nothing found: let spawn report it by name
}

/** the headless flags every browser run shares — never `--virtual-time-budget` (TESTING) */
export const FLAGS = [
  '--headless=new', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
  '--window-size=1600,1000', '--force-color-profile=srgb', '--force-prefers-reduced-motion',
  '--disable-lcd-text'
];

/* the deployed site, plus the test-only routes: the harness, the fixtures, the e2e outputs and fflate (the case
   modules import it); anything else is a 404 */
const ROUTES = [[BASE, SITE], ['/tools/tests/', path.join(ROOT, 'tools/tests')], ['/out/work/e2e/', E2E],
  ['/node_modules/fflate/', path.join(ROOT, 'node_modules/fflate')]];

/** serve.mjs with the test routes; onReport gets every JSON POST */
export const serve = (onReport, port = 0) => serveRoutes(onReport, port, ROUTES);
