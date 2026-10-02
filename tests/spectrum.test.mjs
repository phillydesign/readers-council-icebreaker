import test from 'node:test';
import assert from 'node:assert/strict';
import { positionFromStep, stepFromPosition, colorForPosition } from '../src/spectrum.mjs';

test('the slider crosses the dividing line in both directions without a middle stop', () => {
  const positions = Array.from({ length: 100 }, (_, step) => positionFromStep(step));
  assert.equal(positions.filter(position => position < 50).length, 50);
  assert.equal(positions.filter(position => position > 50).length, 50);
  assert.equal(positions.includes(50), false);
  assert.equal(positions[0], 0);
  assert.equal(positions[99], 100);
  assert.equal(positionFromStep(stepFromPosition(49) + 1), 51);
  assert.equal(positionFromStep(stepFromPosition(51) - 1), 49);
  for (const position of positions) assert.equal(positionFromStep(stepFromPosition(position)), position);
});

test('dot colors follow position through the brand gradient instead of switching at the dividing line', () => {
  assert.equal(colorForPosition(0), 'rgb(13, 107, 152)');
  assert.equal(colorForPosition(100), 'rgb(74, 255, 160)');
  const colors = [0, 25, 49, 51, 75, 100].map(colorForPosition);
  assert.equal(new Set(colors).size, colors.length);
  const before = colorForPosition(49).match(/\d+/g).map(Number);
  const after = colorForPosition(51).match(/\d+/g).map(Number);
  assert.ok(before.every((value, index) => Math.abs(value - after[index]) <= 3));
});
