/* Shared by store-state / store-io: a controllable clock and a store on it. */
import { createStore, memoryStorage } from '../../../src/core/store.js';

export function fakeTimers() {
  let now = 0, id = 1;
  const q = new Map();
  return {
    api: {
      setTimeout: (fn, ms) => { const t = id++; q.set(t, { at: now + ms, fn }); return t; },
      clearTimeout: (t) => { q.delete(t); }
    },
    tick(ms) {
      now += ms;
      for (const [t, e] of [...q.entries()].sort((a, b) => a[1].at - b[1].at)) if (e.at <= now) { q.delete(t); e.fn(); }
    },
  };
}

export const mk = (opts = {}) => {
  const timers = fakeTimers();
  const store = createStore({ robot: 'lekiwi-pincopen' }, { timers: timers.api, storage: memoryStorage(), ...opts });
  return { store, timers };
};
