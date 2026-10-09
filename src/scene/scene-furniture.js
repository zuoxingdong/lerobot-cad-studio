/* Everything in the viewport scene that is not the robot: the ground plane, the grid, the
   axes helper, the three-wall room backdrop and the three-point studio lighting.
   Needs three; `installFurniture()` is called once by scene/viewport.js. */

import * as THREE from 'three';

/* helpers */
function makeGridLines(half, step, major, colorMinor, colorMajor) {
  const pts = [], col = [];
  const a = new THREE.Color(colorMinor), b = new THREE.Color(colorMajor);
  for (let i = -half; i <= half; i += step) {
    const strong = (i === 0) || (Math.abs(i) % major === 0);
    const c = strong ? b : a;
    pts.push(i, -half, 0, i, half, 0, -half, i, 0, half, i, 0);
    for (let k = 0; k < 4; k++) col.push(c.r, c.g, c.b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const m = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 });
  const lines = new THREE.LineSegments(g, m);
  lines.name = 'grid';
  lines.userData.pickable = false;
  lines.userData.camClass = null;
  return lines;
}

/**
 * Build the scene furniture and hand back the handles the viewport keeps.
 * @param {{root, robotRoot, scene, cfg, tokens:() => object, markDirty:() => void}} o
 */
export function installFurniture(o) {
  const { root, robotRoot, scene, cfg, markDirty } = o;
  const tk = () => o.tokens();

  let groundZ = cfg.groundZ;
  const groundMat = new THREE.MeshStandardMaterial({ color: tk()['--viewer-bg-2'], roughness: 1, metalness: 0 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000), groundMat);
  ground.name = 'ground';
  ground.position.z = groundZ;
  ground.renderOrder = -1;
  ground.receiveShadow = !!cfg.shadows;
  /* Tagged for the camera ID pass (as `floor`) and excluded from picking. */
  ground.userData.camClass = 'floor';
  ground.userData.pickable = false;
  ground.userData.isGround = true;
  root.add(ground);

  const gridGroup = new THREE.Group();
  gridGroup.name = 'gridGroup';
  gridGroup.position.z = groundZ + 0.05;
  root.add(gridGroup);
  let grid = null;
  function rebuildGrid() {
    if (grid) { gridGroup.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
    grid = makeGridLines(cfg.gridHalf, cfg.gridStep, cfg.gridMajor,
      tk()['--grid-line'], tk()['--grid-line-strong']);
    gridGroup.add(grid);
  }
  rebuildGrid();

  const axes = new THREE.AxesHelper(140);      // robot X red / Y green / Z blue
  axes.name = 'axes';
  axes.position.set(0, 0, groundZ + 0.2);
  axes.userData.pickable = false;
  axes.userData.camClass = null;
  robotRoot.add(axes);

  /* room backdrop */
  /* A 10°-UP front camera sees nothing but background above the floor line, which is
     correct and unreadable.  Three walls at 3 m, 2.4 m tall give it the floor/wall
     junction the real feed has.  `camClass = null` keeps them OUT of every ID pass, so
     no verdict number moves.  The walls render in CAMERA views only (`pipOnly`); the
     design view gets the faint horizon ring instead, so it stays clean. */
  const ROOM = { r: cfg.roomRadius, h: cfg.roomHeight };
  const backdrop = new THREE.Group();
  backdrop.name = 'backdrop';
  backdrop.userData.pickable = false;
  backdrop.userData.camClass = null;
  backdrop.visible = false;
  root.add(backdrop);
  const wallMat = new THREE.MeshStandardMaterial({
    color: tk()['--viewer-bg'], roughness: 1, metalness: 0, side: THREE.DoubleSide
  });
  for (const [rz, pos] of [[0, [0, ROOM.r, 0]], [Math.PI / 2, [-ROOM.r, 0, 0]], [-Math.PI / 2, [ROOM.r, 0, 0]]]) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(2 * ROOM.r, ROOM.h), wallMat);
    w.rotation.set(Math.PI / 2, 0, rz, 'ZXY');
    w.position.set(pos[0], pos[1], groundZ + ROOM.h / 2);
    w.userData.pickable = false;
    w.userData.camClass = null;
    w.name = 'wall';
    backdrop.add(w);
  }
  /* what the DESIGN view sees of the room: one faint line where the walls meet the floor */
  const horizonMat = new THREE.LineBasicMaterial({
    color: tk()['--grid-line-strong'], transparent: true, opacity: 0.35, toneMapped: false
  });
  const horizon = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-ROOM.r, -ROOM.r, 0), new THREE.Vector3(ROOM.r, -ROOM.r, 0),
    new THREE.Vector3(ROOM.r, ROOM.r, 0), new THREE.Vector3(-ROOM.r, ROOM.r, 0)
  ]), horizonMat);
  horizon.name = 'horizon';
  horizon.position.z = groundZ + 0.3;
  horizon.userData.pickable = false;
  horizon.userData.camClass = null;
  horizon.visible = false;
  root.add(horizon);

  let roomOn = false;
  /** Room on/off.  Walls stay camera-only; the design view gets the horizon ring. */
  function setRoom(on) {
    roomOn = !!on;
    horizon.visible = roomOn;
    backdrop.userData.pipVisible = roomOn;
    markDirty();
    return roomOn;
  }
  backdrop.userData.pipVisible = false;

  /* camera + controls */
  /** Repaint the furniture after a theme change. */
  function setColors() {
    groundMat.color.set(tk()['--viewer-bg-2']);
    wallMat.color.set(tk()['--viewer-bg']);
    horizonMat.color.set(tk()['--grid-line-strong']);
    rebuildGrid();
  }

  /** Move the ground plane (and everything standing on it) to the package's Z. */
  function setGround(z) {
    groundZ = z;
    ground.position.z = z;
    gridGroup.position.z = z + 0.05;
    axes.position.z = z + 0.2;
    for (const w of backdrop.children) w.position.z = z + ROOM.h / 2;
    horizon.position.z = z + 0.3;
    markDirty();
    return z;
  }

  /* lighting: three-point studio over a neutral hemisphere */
  const lights = new THREE.Group();
  lights.name = 'lights';
  scene.add(lights);
  const hemi = new THREE.HemisphereLight(0xdfe6f0, 0x4a505a, 1.15);
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.55);   keyLight.position.set(420, 780, 520);
  const fillLight = new THREE.DirectionalLight(0xcdd8e6, 0.55);  fillLight.position.set(-620, 320, 180);
  const rimLight = new THREE.DirectionalLight(0xffe9c4, 0.50);   rimLight.position.set(-120, 420, -700);
  const ambient = new THREE.AmbientLight(0xffffff, 0.18);
  lights.add(hemi, keyLight, fillLight, rimLight, ambient);
  if (cfg.shadows) {
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    const c = keyLight.shadow.camera;
    c.left = -900; c.right = 900; c.top = 900; c.bottom = -900; c.near = 1; c.far = 3000;
  }

  function dispose() {
    ground.geometry.dispose(); groundMat.dispose();
    for (const w of backdrop.children) w.geometry.dispose();
    wallMat.dispose();
    horizon.geometry.dispose(); horizonMat.dispose();
    if (grid) { grid.geometry.dispose(); grid.material.dispose(); }
  }

  return {
    ground, groundMat, gridGroup, axes, backdrop, wallMat, horizon, horizonMat, lights,
    rebuildGrid, setRoom, setGround, setColors, dispose,
    get grid() { return grid; },
    get roomOn() { return roomOn; },
    get groundZ() { return groundZ; },
  };
}
