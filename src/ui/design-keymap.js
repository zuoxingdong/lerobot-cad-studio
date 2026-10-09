/* The keymap action table and the four window listeners.  core/keymap.js owns WHICH key;
   this file owns WHAT IT DOES.  Every entry of keymap.ACTIONS must have a handler here and
   every handler must be in ACTIONS — the keymap unit suite asserts both, which is the
   "no dead controls" gate.  Installed by ui/design-page.js. */

import { closeOptions, optionsOpen } from './options-list.js';
import { openHelpDialog, anyDialogOpen } from './dialogs.js';
import { motionJoints } from '../features/joints.js';
import { isRemoved } from '../features/slot-options.js';

/** @param {object} page the shared design-page state (see `ui/design-context.js`) */
export function installKeymap(page) {
  const { store, model, railR, canvas, viewport, gizmo, slots, cams, ctx, actions } = page;

  /* keymap */
  const kmActions = {
    'global.escape': () => {
      if (page.opsBar && page.opsBar.escape()) return;
      if (optionsOpen()) { closeOptions(); return; }
      if (page.menuOpen()) { page.closeMenu(); return; }
      if (page.motion && page.motion.escape && page.motion.escape()) return;
      if (page.strip.restore()) return;
      if (store.get('ui.isolate')) { actions.isolate(store.get('ui.isolate')); return; }
      actions.select(null);
    },
    'global.help': () => openHelpDialog(page.km.context()),
    'global.theme': () => page.cycleTheme(),
    'global.save-design': () => page.doExport('design'),
    'global.save-assembly': () => page.doExport('package'),
    'global.open': () => ctx.on.importDesign(),
    'global.export': () => page.openExportSheet(),
    'view.tab': ({ tab }) => {
      if (tab === 'sim' && page.simAvailable && !page.simAvailable()) { page.setStatus('nothing to simulate on this robot'); return; }
      location.hash = `#/${tab}/${encodeURIComponent(model.id)}`;
    },
    'global.undo': () => page.doHistory('undo'),
    'global.redo': () => page.doHistory('redo'),
    'global.space-reserved': () => {},
    'view.reset-camera': () => viewport.resetView(),
    'view.frame-selection': () => actions.frame(),
    'view.grid': () => page.toggle('ui.grid'),
    'view.isolate': () => actions.isolate(),
    'view.hide-selection': () => { const id = ctx.selection()[0]; if (id) actions.toggleVisible(id); },
    /* [ ] cycle the SLOT's options; Shift+[ ] cycle variants. */
    'design.variant': ({ delta }, e) => actions.cycleSlot(delta, !!(e && e.shiftKey)),
    'arm.preset': ({ delta }) => {
      const i = page.presets.findIndex((p) => (p.name || p.id) === store.get('ui.preset'));
      const n = (i < 0 ? 0 : i + delta + page.presets.length) % page.presets.length;
      actions.preset(page.presets[n].name || page.presets[n].id);
    },
    'arm.home': () => actions.preset((page.presets[0] || {}).name || 'stowed'),
    'arm.gripper': () => {
      const g = motionJoints(model, store.getState(), slots).find((j) => j.gripper);
      if (!g) return;
      /* the row's unit may not be the joint's: the PincOpen jaw reads 0…40 mm of finger gap
         and is stored as 0…30.001°, so the toggle decides in DISPLAY space and writes back. */
      const shown = g.toDisplay(model.getJoints()[g.name] || 0);
      const open = g.unit === 'mm' ? g.max : g.min;     // mm = a gap, more is open
      const shut = g.unit === 'mm' ? g.min : g.max;     // degrees = the stock servo, less is open
      page.setJoint(g.name, g.fromDisplay(Math.abs(shown - open) < Math.abs(shown - shut) ? shut : open), true);
    },
    'gizmo.mode': ({ mode }) => {
      if (!gizmoTarget()) return sayNoGizmo();
      ctx.on.gizmoMode(mode === 'scale' ? 'translate' : mode);
    },
    /* Delete / Backspace on the selection — every selected component, restorable. */
    'selection.delete': () => {
      const sel = ctx.selection();
      if (!sel.length) return;
      const st = store.getState();
      const back = sel.filter((id) => isRemoved(st, id));
      if (back.length === sel.length) page.restoreComponents(sel);
      else page.removeComponents(sel.filter((id) => !isRemoved(st, id)));
    },
    'selection.open': () => { const b = railR.querySelector('.ibody button, .ibody input'); if (b) b.focus(); },
    'menu.move': ({ delta }) => { void delta; },
    'menu.activate': () => {}
  };
  /* THE GIZMO PLACES IMPORTED PARTS AND NOTHING ELSE (§6.4, `ui/design-chrome.js` attaches
     it on exactly this rule), but W / E / X only needed *a* selection — so on a package part
     they flipped `ui.gizmo.mode` in the design, attached nothing and said nothing. */
  const gizmoTarget = () => {
    const id = ctx.selection()[0];
    const c = id && model.component(id);
    return c && c.group === 'imported' && !isRemoved(store.getState(), id) ? c : null;
  };
  function sayNoGizmo() {
    page.setStatus(ctx.selection()[0]
      ? 'the gizmo places imported parts — this one is posed by the robot'
      : 'select an imported part first — the gizmo places those');
  }
  ctx.kmActions = kmActions;

  (async () => {
    const { createDispatcher } = await import('../core/keymap.js');
    /* the page can be gone before this resolves — binding four window listeners to a
       destroyed page left every key press running against a disposed viewport */
    if (page.destroyed) return;
    page.km = createDispatcher({
      env: {
        overlay: () => anyDialogOpen() || optionsOpen(),
        menuOpen: page.menuOpen,
        hasSelection: () => ctx.selection().length > 0,
        canvasFocused: () => document.activeElement === canvas
      },
      actions: kmActions,
      onShift: (down) => gizmo.setFine(down),
      onMissing: (name) => console.warn('keymap: no handler for', name)
    });
    window.addEventListener('keydown', page.km.onKeyDown);
    window.addEventListener('keyup', page.km.onKeyUp);
    window.addEventListener('blur', page.km.releaseAll);
    window.addEventListener('pagehide', page.km.releaseAll);
    ctx.km = page.km;
  })();

}
