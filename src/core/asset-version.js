/* Cache-busting for the files a page loads after first paint: build.mjs defines __RPS_V__
   ({site path: content hash}) in every bundle, so a redeploy never mixes old and new files.
   Unbundled (node) there is no map and URLs stay bare.  Needs nothing. */

/* global __RPS_V__ */
const V = typeof __RPS_V__ === 'object' && __RPS_V__ ? __RPS_V__ : {};

/** the build's hash of a site path, or null */
export const versionOf = (path) => V[path] || null;

/** `path?v=<hash>`, from `v` or the build's map; the bare path when neither has one */
export const versioned = (path, v = versionOf(path)) => (v ? `${path}?v=${v}` : path);
