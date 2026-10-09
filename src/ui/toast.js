/* Toasts: short notices with up to three buttons, stacked bottom-right of the viewport,
   newest last, two at most; a long text is cut with its whole line in the tooltip.  Needs ui/dom.js. */

import { el } from './dom.js';

const MAX = 2;

/** @param {HTMLElement} host  a positioned element (the canvas host) */
export function createToasts(host) {
  const box = el('div', 'toasts');
  box.setAttribute('aria-live', 'polite');
  host.appendChild(box);
  const live = new Map();          // key -> {node, timer}

  function close(key) {
    const t = live.get(key);
    if (!t) return;
    clearTimeout(t.timer);
    t.node.remove();
    live.delete(key);
  }

  /**
   * @param {{key?:string, text:string, title?:string, level?:string, ms?:number,
   *          actions?:Array<{label:string, run:Function, keep?:boolean, accent?:boolean}>}} o
   */
  function show(o) {
    const key = o.key || String(Math.random());
    close(key);
    const node = el('div', 'toast' + (o.level ? ' ' + o.level : ''));
    node.dataset.key = key;
    const t = el('span', 't', o.text);
    t.title = o.title ? `${o.text}\n${o.title}` : o.text;
    node.appendChild(t);
    for (const a of o.actions || []) {
      const b = el('button', 'btn sm' + (a.accent ? ' accent' : ''), a.label);
      b.type = 'button';
      b.onclick = () => { a.run(b); if (!a.keep) close(key); };
      node.appendChild(b);
    }
    const x = el('button', 'btn sm ghost x', '×');
    x.type = 'button';
    x.title = 'Dismiss';
    x.setAttribute('aria-label', 'Dismiss');
    x.onclick = () => { if (o.onClose) o.onClose(); close(key); };
    node.appendChild(x);
    box.appendChild(node);
    const timer = o.ms === 0 ? null : setTimeout(() => { if (o.onClose) o.onClose(); close(key); }, o.ms || 12000);
    live.set(key, { node, timer });
    while (live.size > MAX) close(live.keys().next().value);
    return { close: () => close(key), node };
  }

  return {
    show, close,
    keys: () => [...live.keys()],
    destroy() { for (const k of [...live.keys()]) close(k); box.remove(); },
  };
}
