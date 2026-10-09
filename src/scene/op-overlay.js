/* Viewport overlays for the tweak ops: the 30 % ghost of the original, the stretch cut plane
   and the thicken face marker.  Everything is drawn in a part's geometry frame under
   `viewport.robotRoot`, hidden from the camera PiPs and never pickable.  Needs three. */

import * as THREE from 'three';

let ghost = null;

/** One shared ghost material: the original mesh at 30 %. */
export function ghostMaterial(viewport) {
  const col = (viewport.tokens && viewport.tokens['--mat-ghost']) || '#aab2be';
  if (!ghost) {
    ghost = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.3, depthWrite: false });
  } else ghost.color.set(col);
  return ghost;
}

function mark(o) {
  o.traverse((n) => { n.userData.pickable = false; n.userData.camClass = null; n.renderOrder = 998; });
  return o;
}

/**
 * A translucent square in the plane `p·axis = at` of a part, covering its box.
 * @param {THREE.Box3} box  the part's geometry-frame box
 */
export function cutPlane(viewport, box, axis, at, color) {
  const a = new THREE.Vector3().fromArray(axis).normalize();
  const size = box.getSize(new THREE.Vector3()).length() * 0.75 + 10;
  const c = box.getCenter(new THREE.Vector3());
  const col = color || (viewport.tokens && viewport.tokens['--accent']) || '#2f5bd3';
  const g = new THREE.Group();
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(size, size)),
    new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.9 }));
  g.add(fill, edge);
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), a);
  g.position.copy(c).addScaledVector(a, at - c.dot(a));
  g.name = 'cutPlane';
  return mark(g);
}

/** A small disc on a picked face, `point`/`normal` in the part frame. */
export function faceMarker(viewport, point, normal, radius = 6) {
  const col = (viewport.tokens && viewport.tokens['--accent']) || '#2f5bd3';
  const m = new THREE.Mesh(new THREE.CircleGeometry(radius, 24),
    new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
  const n = new THREE.Vector3().fromArray(normal).normalize();
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  m.position.fromArray(point).addScaledVector(n, 0.05);
  m.name = 'faceMarker';
  return mark(m);
}

/**
 * A holder for overlays that ride one part: its matrix is the part's world matrix.
 * @returns {{group, set(children), clear(), follow(matrix), dispose()}}
 */
export function createOverlay(viewport) {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  group.name = 'opOverlay';
  mark(group);
  viewport.robotRoot.add(group);
  viewport.hideInPip(group);
  const disposeTree = (o) => o.traverse((n) => { if (n.geometry) n.geometry.dispose(); if (n.material && n.material !== ghost) n.material.dispose(); });
  return {
    group,
    set(children) {
      for (const ch of [...group.children]) { group.remove(ch); disposeTree(ch); }
      for (const ch of children || []) if (ch) group.add(ch);
      viewport.invalidate();
    },
    clear() { this.set([]); },
    follow(matrix) { if (matrix) { group.matrix.copy(matrix); group.matrixWorldNeedsUpdate = true; } viewport.invalidate(); },
    dispose() { this.clear(); viewport.robotRoot.remove(group); },
  };
}
