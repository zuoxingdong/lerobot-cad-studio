/* scene/picking.js, the pure half: click / drag threshold, the selection model, Alt+click
   pick-through and the hover-tag clamp. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isClick, isDrag, reduceSelection, cycleIndex, tagPosition, CLICK_PX } from '../../../src/scene/picking.js';

const down = (x, y, button = 0, t = 0) => ({ x, y, button, t });

test('a click is ≤ 4 px with the same button, however slow; a drag arms past it', () => {
  assert.equal(CLICK_PX, 4);
  assert.ok(isClick(down(100, 100), down(104, 100)) && isClick(down(10, 10, 0, 0), down(10, 10, 0, 4000)));
  assert.ok(!isClick(down(100, 100), down(105, 100)) && !isClick(down(100, 100), down(103, 103)));
  assert.ok(!isClick(down(10, 10, 0), down(10, 10, 2)) && !isClick(null, down(10, 10)) && !isClick(down(10, 10), null));
  assert.ok(!isDrag(down(50, 50), 54, 50) && isDrag(down(50, 50), 55, 50) && !isDrag(null, 500, 500));
});

test('selection: set replaces, Shift adds once, Ctrl toggles, empty space clears on a plain click; primary stays first', () => {
  assert.deepEqual(reduceSelection(['a', 'b'], 'c', 'set'), ['c']);
  assert.deepEqual(reduceSelection(['a', 'b'], 'b', 'add'), ['a', 'b']);
  assert.deepEqual(reduceSelection(['a', 'b'], 'b', 'toggle'), ['a']);
  for (const mode of ['add', 'toggle']) assert.deepEqual(reduceSelection(['a', 'b'], null, mode), ['a', 'b']);
  assert.deepEqual(reduceSelection(['a', 'b'], null, 'set'), []);
  assert.deepEqual(reduceSelection(reduceSelection(reduceSelection([], 'a'), 'b', 'add'), 'c', 'toggle'), ['a', 'b', 'c']);
});

test('Alt+click walks the hits behind and wraps; a new spot restarts; one hit stays; none is -1', () => {
  let r = cycleIndex(3, null, 100, 100);
  assert.equal(r.index, 1);
  r = cycleIndex(3, r.state, 101, 100);
  assert.equal(r.index, 2);
  assert.equal(cycleIndex(3, r.state, 101, 100).index, 0);
  assert.equal(cycleIndex(4, cycleIndex(4, null, 10, 10).state, 400, 300).index, 1);
  assert.equal(cycleIndex(1, cycleIndex(1, null, 10, 10).state, 10, 10).index, 0);
  assert.deepEqual(cycleIndex(0, null, 5, 5), { index: -1, state: null });
});

test('the hover tag sits below-right, flips at the edges, never goes negative, honours the canvas offset', () => {
  const rect = { left: 0, top: 0, width: 800, height: 600 };
  const p = tagPosition(rect, 100, 100, 170, 36, 16);
  assert.deepEqual([p.left, p.top, p.flippedX], [116, 116, false]);
  const e = tagPosition(rect, 790, 590, 170, 36, 16);
  assert.ok(e.flippedX && e.flippedY && e.left + 170 <= 800 && e.top + 36 <= 600);
  const t = tagPosition({ left: 0, top: 0, width: 120, height: 90 }, 10, 10, 170, 36, 16);
  assert.ok(t.left >= 0 && t.top >= 0);
  const o = tagPosition({ left: 300, top: 120, width: 800, height: 600 }, 500, 300, 170, 36, 16);
  assert.deepEqual([o.left, o.top], [216, 196]);
});
