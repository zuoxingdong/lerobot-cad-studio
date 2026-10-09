/* THE ONE E2E HARNESS, imported by every suite in this directory: the report rows, the
   polling wait, and the single publish that hands the suite over to `harness.html`.
   A case declares only what is its own. */

/** the iframe holding the BUILT page — `harness.html` fills its src */
export const frame = document.getElementById('frame');
const out = document.getElementById('e2e-report');

/** this suite's table rows, in the order they ran */
export const results = [];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** a CI runner (run.mjs passes ?ci=1 when $CI is set): the timing checks take their relaxed bounds */
export const CI = new URLSearchParams(location.search).get('ci') === '1';

/** Poll until `fn` answers something truthy, or give up after `ms`. */
export async function waitFor(fn, ms = 30000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(50);
  }
}

/** One row of the e2e table.  A throw is a FAIL, never the end of the suite. */
export async function test(name, fn) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '', ms: Math.round(performance.now() - t0) });
  } catch (e) {
    results.push({ name, ok: false, detail: String((e && e.message) || e),
      stack: String((e && e.stack) || ''), ms: Math.round(performance.now() - t0) });
  }
}

export function assert(cond, msg) { if (!cond) throw new Error(msg); }

/**
 * Hand the report over.  `#e2e-report` losing `hidden` is what moves `harness.html` on to
 * the next suite; the POST is what `run.mjs` merges into its table.
 *
 * @param {object} [extra]        suite fields; they override the computed ones
 * @param {string[]} [omitFromPage] fields too big to also render into the page
 */
function publish(extra = {}, omitFromPage = []) {
  const suite = window.__RPS_SUITE || 'e2e';
  const body = {
    suite,
    ok: results.every((r) => r.ok),
    passed: results.filter((r) => r.ok).length,
    total: results.length,
    results,
    ...extra
  };
  const shown = { ...body };
  for (const k of omitFromPage) shown[k] = undefined;
  if (out) { out.textContent = JSON.stringify(shown, null, 1); out.hidden = false; }
  document.title = suite + ' ' + (body.ok ? 'PASS' : 'FAIL');
  try { fetch(window.__RPS_POST || '/e2e-report', { method: 'POST', body: JSON.stringify(body) }); }
  catch (e) { /* offline */ }
}

/**
 * Run the suite and publish exactly once, whatever it does — a suite that throws on its
 * way in still reports the throw instead of costing the chain a watchdog.
 *
 * @param {Function} run @param {Function|object} [extra] extras for `publish`
 * @param {string[]} [omitFromPage]
 */
export function start(run, extra, omitFromPage) {
  return run()
    .catch((e) => {
      results.push({ name: 'harness', ok: false, detail: String((e && e.stack) || e), ms: 0 });
    })
    .then(() => publish(typeof extra === 'function' ? extra() : (extra || {}), omitFromPage || []));
}

/* page helpers shared by the suites */

/** open the default robot's Design page from wherever the frame is; resolves `__rps` */
export async function openDesign(win, robot = 'lekiwi-pincopen') {
  const ok = () => win.__rps && win.__rps.page && win.__rps.readouts
    && win.location.hash.startsWith('#/design/' + robot) && win.__rps.readouts().treeRows > 0;
  if (!ok()) {
    await waitFor(() => win.document.querySelector('.home .card1') || win.__rps, 60000, 'the page');
    win.location.hash = '#/design/' + robot;
    await waitFor(ok, 60000, 'the ' + robot + ' design page');
  }
  return win.__rps;
}

/** run `fn` with `URL.createObjectURL` captured: what every download goes through */
export async function captureDownload(win, fn, ms = 60000) {
  const orig = win.URL.createObjectURL;
  let blob = null;
  win.URL.createObjectURL = (b) => { blob = b; return 'blob:captured'; };
  try { await fn(); await waitFor(() => blob, ms, 'a download'); } finally { win.URL.createObjectURL = orig; }
  return new Uint8Array(await blob.arrayBuffer());
}

/** file names in a zip, from its local headers */
export function zipNames(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out = [];
  for (let o = 0; o + 30 <= u8.length && dv.getUint32(o, true) === 0x04034b50;) {
    const size = dv.getUint32(o + 18, true), n = dv.getUint16(o + 26, true), x = dv.getUint16(o + 28, true);
    out.push(new TextDecoder().decode(u8.subarray(o + 30, o + 30 + n)));
    o += 30 + n + x + size;
  }
  return out;
}

export function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/** a closed binary-STL box of size sx × sy × sz centred at (cx, cy, cz) */
export function boxSTL(sx, sy, sz, cz, cx = 0, cy = 0) {
  const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
  const P = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const tris = quads.flatMap(([a, b, c, d]) => [[P[a], P[b], P[c]], [P[a], P[c], P[d]]]);
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const t of tris) {
    o += 12;
    for (const v of t) { dv.setFloat32(o, v[0], true); dv.setFloat32(o + 4, v[1], true); dv.setFloat32(o + 8, v[2], true); o += 12; }
    o += 2;
  }
  return new Uint8Array(buf);
}

/** feed files to the Home import dialog's file input and press its `button` */
export async function homeImport(win, files, button) {
  const doc = win.document;
  const card = [...doc.querySelectorAll('.home button, .home .card2, .home .cardi')].find((n) => /import/i.test(n.textContent || ''));
  if (!card) throw new Error('no import card on Home');
  card.click();
  const input = await waitFor(() => doc.querySelector('.sheet input[type=file]'), 10000, 'the import dialog');
  const dt = new win.DataTransfer();
  for (const [bytes, name] of files) dt.items.add(new win.File([bytes], name));
  input.files = dt.files;
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
  const b = await waitFor(() => [...doc.querySelectorAll('.sheet button')].find((x) => x.textContent.trim() === button && !x.disabled), 20000, button);
  b.click();
}
