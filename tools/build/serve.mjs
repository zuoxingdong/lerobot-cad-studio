// Serve site/ the way GitHub Pages does, under /<repo>/ on loopback (npm run serve); the e2e harness adds its routes.
//
//   node tools/build/serve.mjs [port]     default 8099
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = path.join(ROOT, 'site');
/** the Pages path: https://<owner>.github.io/<repo>/, the repo named by package.json */
const REPO = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).repository.url;
export const BASE = '/' + /([^/]+?)(\.git)?$/.exec(REPO)[1] + '/';

/* html goes out WITHOUT a charset, as python's http.server and many static hosts send it: a page
   must declare its own */
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.stl': 'model/stl', '.png': 'image/png',
  '.zip': 'application/zip', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.map': 'application/json', '.jpg': 'image/jpeg', '.mp4': 'video/mp4'
};

/** a URL path -> a file under one route's dir, or null (resolve, then realpath: no `..` or symlink out) */
function routeFile(routes, url) {
  for (const [prefix, dir] of routes) {
    if (!url.startsWith(prefix)) continue;
    const file = path.resolve(dir, '.' + url.slice(prefix.length - 1));
    let real = file;
    try { real = fs.realpathSync(file); } catch { /* 404 later */ }
    const top = fs.existsSync(dir) ? fs.realpathSync(dir) : dir;
    return real === top || real.startsWith(top + path.sep) ? real : null;
  }
  return null;
}

/** `http://127.0.0.1:<port>/<repo>/<page>`: a built page as Pages serves it */
export const pageUrl = (port, page = 'index.html') => `http://127.0.0.1:${port}${BASE}${page}`;

/**
 * The Pages-like static server; it also collects JSON POSTs.
 * @param {(body:object, url:string)=>void} [onReport] called for every POST
 * @param {number} [port] 0 (the default) takes any free port
 * @param {Array<[string, string]>} [routes] [URL prefix, dir]; the default is site/ under BASE
 * @returns {Promise<{server:http.Server, port:number}>}
 */
export function serve(onReport, port = 0, routes = [[BASE, SITE]]) {
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }).end();
      return;
    }
    if (req.method === 'POST' && (req.url.startsWith('/e2e-report') || req.url.startsWith('/shot-done'))) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(204, { 'access-control-allow-origin': '*' }).end();
        if (!onReport) return;
        try { onReport(JSON.parse(body), req.url); }
        catch (e) { onReport({ ok: false, error: String(e), raw: body.slice(0, 400) }, req.url); }
      });
      return;
    }
    let url;
    try { url = decodeURIComponent((req.url || '/').split('?')[0]); }
    catch { res.writeHead(400).end('bad url'); return; }
    if (url === BASE.slice(0, -1)) { res.writeHead(301, { location: BASE }).end(); return; }
    /* a miss under the Pages path gets site/404.html, as on Pages */
    const missing = () => fs.readFile(path.join(SITE, '404.html'), (e, page) => {
      if (e || !url.startsWith(BASE)) res.writeHead(404).end('not found: ' + url);
      else res.writeHead(404, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end(page);
    });
    const real = routeFile(routes, url);
    if (!real) { missing(); return; }
    let target = real;
    try { if (fs.statSync(real).isDirectory()) target = path.join(real, 'index.html'); } catch { /* 404 below */ }
    fs.readFile(target, (err, buf) => {
      if (err) { missing(); return; }
      res.writeHead(200, {
        'content-type': TYPES[path.extname(target)] || 'application/octet-stream',
        'cache-control': 'no-store', 'access-control-allow-origin': '*'
      });
      res.end(buf);
    });
  });
  return listen(server, port);
}

/** `serve()` on a chosen port (0 = any free one). */
export function listen(server, port = 0) {
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, port: server.address().port })));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { port } = await serve(null, Number(process.argv[2]) || 8099);
  console.log('site/ served at ' + pageUrl(port, ''));
}
