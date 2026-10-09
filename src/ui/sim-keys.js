/* The Sim tab's keyboard: its own context over core/keymap.js's matcher.  Physical key codes,
   captured only while the canvas has focus; everything else is kept from the Design keymap
   while the Sim view is up (bar Tab and the browser's own shortcuts). */

import { keyMatches } from '../core/keymap.js';
import { SIM_KEYS } from '../features/sim-teleop.js';

/* the key map card: pairs of rows, W A S D and ← → / ↑ ↓ folded into one */
export const KEY_ROWS = [
  [['W A S D', 'base'], ['Q E', 'turn']],
  [['← →', 'joint'], ['↑ ↓', 'jog']],
  [['F', 'grip'], ['H', 'home'], ['P', 'pose']],
  [['0', 'recentre'], ['Shift', 'fast']],
  [['Space', 'stop'], ['R', 'reset'], ['Esc', 'release']],
];

const match = (b, e) => keyMatches({ ...b, shift: undefined }, { ...pick(e), shiftKey: false });
function pick(e) { return { code: e.code, key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey }; }
const typing = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));

/**
 * @param {{canvas:HTMLElement, held:Set<string>, actions:Object<string,Function>,
 *          onFocus:(on:boolean)=>void, onFast:(on:boolean)=>void, enabled:()=>boolean}} o
 */
export function installSimKeys(o) {
  const { canvas, actions } = o;
  const active = () => document.activeElement === canvas && o.enabled();
  const down = new Map();                    // code -> hold name

  function onKeyDown(e) {
    if (e.code === 'Tab' || typing(e.target)) return;
    if ((e.ctrlKey || e.metaKey) && !/^Key[ZY]$/.test(e.code)) return;
    e.stopImmediatePropagation();
    if (!active()) return;
    o.onFast(e.shiftKey);
    const b = SIM_KEYS.find((x) => !x.display && match(x, e));
    if (!b) return;
    e.preventDefault();
    if (b.hold) {
      if (!down.has(e.code)) { down.set(e.code, b.hold); o.held.add(b.hold); }
      return;
    }
    if (e.repeat) return;
    const fn = actions[b.action];
    if (fn) fn(b.args, e);
  }
  function onKeyUp(e) {
    if (typing(e.target)) return;
    e.stopImmediatePropagation();
    o.onFast(e.shiftKey);
    const h = down.get(e.code);
    if (h) {
      down.delete(e.code);
      if (![...down.values()].includes(h)) o.held.delete(h);
    }
  }
  function releaseAll() {
    down.clear();
    o.held.clear();
    o.onFast(false);
  }
  const onFocus = () => o.onFocus(true);
  const onBlur = () => { releaseAll(); o.onFocus(false); };

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', releaseAll);
  canvas.addEventListener('focus', onFocus);
  canvas.addEventListener('blur', onBlur);
  o.onFocus(document.activeElement === canvas);

  return {
    releaseAll,
    get active() { return active(); },
    dispose() {
      releaseAll();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', releaseAll);
      canvas.removeEventListener('focus', onFocus);
      canvas.removeEventListener('blur', onBlur);
    },
  };
}
