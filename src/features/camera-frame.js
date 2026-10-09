/* Where a camera's pose is built and what a fitted camera looks like to a panel:
   the five-case build-frame rule and the draw-ready spec the frustum and the strip tile read.
   Pure functions of the model and the camera registry; needs nothing but them. */

/** A draw-ready spec for `scene/frustums.set()` plus everything the strip tile shows. */
export function cameraSpec(cams, model, design, camId, ctx) {
  const cam = cams.get(camId);
  if (!cam) return null;
  const pose = cams.getPose(camId, ctx || {});
  const over = ((design && design.cameras) || {})[camId] || {};
  const raw = (model.manifest.cameras || []).find((c) => c.id === camId) || {};
  return {
    id: camId, label: cam.label || camId, name: cam.name || cam.label || camId,
    matrix: pose && pose.matrixRobot ? pose.matrixRobot : (pose && pose.matrix) || null,
    hfov_deg: cam.hfov_deg, vfov_deg: cam.vfov_deg, aspect: cam.aspect,
    near: cam.near, far: cam.far, tilt_deg: pose ? pose.tilt_deg : null,
    hfov_range: raw.hfov_range || [30, 140], alternatives: raw.alternatives || [],
    source: raw.source || cam.source || null, pose,
    enabled: over.enabled !== false, ok: !!(pose && pose.ok)
  };
}

/**
 * Which frame a part builds its camera pose in — read off the package, never a table of
 * component ids, or the next mount an inbox alternative brings is read as robot-frame and
 * the wrist camera stops riding the arm.  In order:
 *   1. the component's own `build_frame` / `camera_frame`, when a package declares one;
 *   2. the `mount_frame` of the camera the part publishes (`cam_<id>` -> `cameras[id]`) —
 *      the datum the package says the mount seats on (`wrist` -> `wrist_flange`);
 *   2b. that camera's declared `frame` when it is `robot`: the pose is already in robot
 *      millimetres and nothing may carry it again.  A generated part has its `local`
 *      REPLACED by the build's `place` matrix, so falling through to (3) would multiply
 *      the datum by that part's bed->mount transform.  `place` moves GEOMETRY, never a
 *      camera datum;
 *   3. the component itself (`component:<id>`), whose world matrix IS the frame its
 *      geometry is drawn in — right for any mount, imported or generated;
 *   4. the camera's `link`, and finally the robot frame.
 *
 * @param {object} model @param {object} cams @param {string} componentId
 * @param {object} frames the build's published frames, `{cam_wrist: {...}}`
 * @returns {string} a name `cameras.liveBase()` resolves, or 'robot'
 */
export function cameraBuildFrame(model, cams, componentId, frames) {
  const c = model && model.component ? model.component(componentId) : null;
  const raw = (model && model.manifest && (model.manifest.components || [])
    .find((x) => x.id === componentId)) || {};
  const declared = raw.build_frame || raw.camera_frame || (c && c.buildFrame);
  const resolves = (n) => {
    if (!n || n === 'robot') return false;
    try { return !!(cams && cams.liveBase ? cams.liveBase(n) : model.frameMatrix(n)); } catch (e) { return false; }
  };
  if (resolves(declared)) return declared;

  for (const name of Object.keys(frames || {})) {
    const camId = name.startsWith('cam_') ? name.slice(4) : name;
    const rawCam = (model.manifest.cameras || []).find((x) => x.id === camId);
    const mount = rawCam && (rawCam.mount_frame || rawCam.build_frame);
    if (resolves(mount)) return mount;
    /* the package declares this camera in robot millimetres: whatever the publishing part
       had to do to get its own geometry off the print bed, the datum is already there. */
    if (rawCam && (mount === 'robot' || (!mount && rawCam.frame === 'robot'))) return 'robot';
  }
  if (c && resolves('component:' + componentId)) {
    /* a part baked in the robot frame at the identity IS the robot frame — say so, so the
       common case keeps the cheap path and an unmoved override stays a plain matrix */
    const link = c.link || null;
    const moved = link || (c.local && Math.abs(c.local.elements[12]) + Math.abs(c.local.elements[13])
      + Math.abs(c.local.elements[14]) > 1e-9);
    if (moved) return 'component:' + componentId;
  }
  for (const name of Object.keys(frames || {})) {
    const camId = name.startsWith('cam_') ? name.slice(4) : name;
    const cam = cams && cams.get ? cams.get(camId) : null;
    if (cam && cam.link && resolves(cam.link)) return cam.link;
  }
  return 'robot';
}
