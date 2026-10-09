/* Moving the robot: the joints, the presets and look-through.  `setJoint` is the one door
   every slider and key goes through, and `applyPreset` walks a preset through the same clamp
   one joint at a time, so limits and collisions are never skipped (while "Stop at collisions"
   is on in the Check tab).  Installed by ui/design-page.js. */

import { cameraSpec } from '../features/camera-frame.js';
import { DEBOUNCE } from '../features/validate.js';

/** @param {object} page the shared design-page state (see `ui/design-context.js`) */
export function installMotion(page) {
  const { store, model, canvasHost, viewport, picking, frustums, cams, ctx } = page;

  /* look-through */
  /* The main viewport IS the robot camera: same intrinsics, letterboxed to the camera's
     own aspect, orbit off, design-view furniture hidden.  The arm keeps working, so only
     the orbit camera is taken away. */
  function setLookThrough(id, node) {
    const hud = canvasHost.querySelector('.lookhud');
    if (hud) hud.remove();
    page.lookId = id || null;
    canvasHost.classList.toggle('looking', !!page.lookId);
    if (!page.lookId) {
      viewport.setLookThrough(null);
      picking.clearHover();
      viewport.invalidate();
      page.setStatus('');
      return null;
    }
    refreshLookCamera();
    viewport.setLookThrough({
      id: page.lookId, camera: frustums.camera(page.lookId),
      /* a robot camera cannot see the studio's own overlays */
      hide: () => [frustums.group, frustums.pipGrid]
    });
    if (node) canvasHost.appendChild(node);
    page.setStatus(`looking through ${page.lookId} · Esc returns`);
    viewport.invalidate();
    return page.lookId;
  }
  /** keep the look-through camera on the live pose, every frame */
  function refreshLookCamera() {
    if (!page.lookId) return;
    const spec = cameraSpec(cams, model, store.getState(), page.lookId, page.camCtx());
    if (spec && spec.matrix) frustums.applyToCamera(frustums.camera(page.lookId), spec);
  }
  /* motion */
  function setJoint(name, value, commit) {
    const world = store.get('ui.physics') !== false ? ctx.collide() : null;
    let stopped = false;
    if (world) {
      const w = world;
      try {
        /* the bisection resolution is |target - current| / 2^steps: 4 steps is right for a
           slider nudge, but a jump across the whole travel would stop short of the real
           obstacle, so a big move buys more probes (~1 ms each).  `applyPreset` always
           asks for 9 — every joint of a preset is such a jump. */
        const q0 = model.getJoints();
        const jump = Math.abs(value - (q0[name] || 0));
        const r = w.clampJoint(q0, name, value, { steps: jump > 20 ? 9 : 4 });
        if (r.blocked || r.limited) {
          /* `clampJoint` answers with the clamped value of THIS joint (a number) and an
             array of hits — `r.q[name]` was `undefined`, which silently cancelled every
             blocked jog and wrote `undefined` into `design.joints`. */
          const hit = (r.blockedBy || [])[0];
          page.motion.flashBlocked(name, hit ? w.label(hit.b || hit.a) : (r.limited ? 'the joint limit' : null));
          value = r.q;
          stopped = true;
        }
      } catch (e) { /* physics off for this pose */ }
    }
    /* a move that was NOT clamped clears a stale "blocked · …": the failure path was the
       only one that wrote the status, so every later successful joint move still read as
       blocked until something else happened to overwrite it */
    if (!stopped) page.clearStatus('blocked');
    store.set(['joints', name], value, { label: 'joint ' + name, coalesce: !commit });
    store.set('ui.preset', null);
    page.applyPose();
  }

  /**
   * A PRESET IS A MOVE, so it goes through the clamp.
   *
   * Patching `design.joints` with the preset's whole `q` and calling `applyPose()` walks
   * past the one door `setJoint` opens — the joint limits, the collision bisection and the
   * "say what stopped it" status — so a preset could put the arm where a slider may not.
   *
   * It is applied ONE JOINT AT A TIME against the pose built so far, each clamped exactly
   * as a slider nudge is (`clampJoint`, 9 probes because a preset is a jump across the
   * whole travel).  A joint whose start pose is already blocked simply does not move, so
   * the pose this leaves behind is always one the collision world accepts.  A preset that
   * could not be reached in full names the first thing in the way.
   *
   * @param {string} pid  the preset's `name` (or `id`) — what the pose buttons carry
   * @returns {{preset:string, reached:boolean, blocked:Array<{joint:string, by:string}>}|null}
   */
  function applyPreset(pid) {
    /* the panel and the keymap pass the canonical `name`; a key, a chip or a test may pass
       the package's own id ("reach_floor") or the lower-cased button text — one preset
       either way, and `design.ui.preset` always records the canonical spelling */
    const key = String(pid == null ? '' : pid).toLowerCase().replace(/[_\s]+/g, ' ').trim();
    const p = page.presets.find((x) => (x.name || x.id) === pid)
      || page.presets.find((x) => [x.name, x.id, x.label]
        .some((k) => String(k == null ? '' : k).toLowerCase().replace(/[_\s]+/g, ' ').trim() === key));
    if (!p) return null;
    const name0 = p.name || p.id;
    const want = p.q || {};
    const world = store.get('ui.physics') !== false ? ctx.collide() : null;
    const q = { ...model.getJoints() };
    const stuck = new Map();
    /* SEVERAL PASSES, not one.  One pass in the preset's own key order drives the first
       joint as far as it can go before any other has moved, and a straight arm swung down
       to the shoulder's -163 hits the deck long before the elbow has folded out of the
       way — "reach floor" would be permanently blocked in an empty room.  Re-running the
       sweep while it still makes progress lets the joints give way to each other, which is
       how the arm actually gets there; four passes is well past the point where the six
       joints of an SO-101 stop helping each other, and a pass that moves nothing ends it. */
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      for (const [name, target] of Object.entries(want)) {
        const from = q[name] || 0;
        if (Math.abs(from - target) < 1e-6) { stuck.delete(name); continue; }
        if (!world) { q[name] = target; moved = true; continue; }
        let r = null;
        /* `names:false` skips clampJoint's extra "name every offender" pass (~4 ms each):
           the first hit is enough for the status line, and this runs up to 24 times. */
        try { r = world.clampJoint(q, name, target, { steps: 9, names: false }); }
        catch (e) { q[name] = target; moved = true; continue; }
        if (Math.abs(r.q - from) > 1e-6) { q[name] = r.q; moved = true; }
        if (r.blocked || r.limited) {
          const h = (r.blockedBy || [])[0];
          stuck.set(name, h ? world.label(h.b || h.a) : (r.limited ? 'the joint limit' : 'the robot'));
        } else stuck.delete(name);
      }
      if (!moved) break;
    }
    const blocked = [...stuck].map(([joint, by]) => ({ joint, by }));
    const joints = {};
    for (const name of Object.keys(want)) joints[name] = q[name];
    store.patch({ joints, ui: { preset: name0 } }, { label: 'preset ' + (p.label || name0) });
    page.applyPose();
    if (blocked.length) {
      /* the same sentence a blocked slider writes, and the same red flash on its track */
      if (page.motion) page.motion.flashBlocked(blocked[0].joint, blocked[0].by);
      else page.setStatus(`blocked · ${blocked[0].joint} hits ${blocked[0].by}`, 'warn');
    } else page.clearStatus('blocked');
    if (page.motion) page.motion.render();
    return { preset: name0, reached: !blocked.length, blocked };
  }

  /* preset verdicts */
  /**
   * The preset collision pass, cached for the pose popover's warn markers.
   *
   * A preset's verdict does not depend on the pose the arm is in — only on the geometry
   * that is on the robot and the base — so one pass per DESIGN change is
   * enough, and it is debounced by the same 400 ms `DEBOUNCE.presets_ms` policy the
   * inspector uses (a BVH pass per preset is far too expensive per render).
   * `fresh` is false while the answer on hand is still the previous design's.
   * @returns {{fresh:boolean, rows:Map, get:(name:string)=>({ok, tooltip}|undefined)}}
   */
  let presetVerdicts = { key: null, rows: new Map() };
  function presetPhysicsKey() {
    const st = store.getState();
    const b = st.base || {};
    return [page.designStamp, JSON.stringify(st.slots || {}), JSON.stringify(st.removed || {}),
      b.x || 0, b.y || 0, b.yaw || 0].join('#');
  }
  function presetPhysics() {
    const key = presetPhysicsKey();
    const answer = () => ({ fresh: presetVerdicts.key === key, rows: presetVerdicts.rows,
      get: (n) => presetVerdicts.rows.get(n) });
    if (presetVerdicts.key === key || !page.presets.length || page.presetTimer) return answer();
    page.presetTimer = setTimeout(() => {
      page.presetTimer = null;
      if (page.destroyed) return;
      const k = presetPhysicsKey();
      const rows = new Map();
      try {
        const P = ctx.validator().physicsOf(store.getState(), { stage: 'presets' });
        for (const r of P.presets || []) {
          const rec = { ok: r.ok !== false, tooltip: r.tooltip || '' };
          rows.set(r.name, rec);
          if (r.id) rows.set(r.id, rec);
        }
      } catch (e) { /* no collision world */ }
      presetVerdicts = { key: k, rows };
      if (page.motion) page.motion.render();
    }, DEBOUNCE.presets_ms);
    return answer();
  }
  ctx.presetPhysics = () => presetPhysics();

  Object.assign(page, {
    applyPreset, presetPhysics, refreshLookCamera, setJoint, setLookThrough,
  });
}
