import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderPolicy, renderPixelRatio, renderIntervalMs } from '../src/render-policy.js';

test('a touch device keeps interactive rendering within 30fps and reduces idle work', () => {
  const policy = createRenderPolicy({ coarsePointer: true, devicePixelRatio: 3 });
  assert.equal(policy.activeFps, 30);
  assert.equal(policy.idleFps, 12);
  assert.equal(policy.shadowSize, 512);
  assert.equal(renderPixelRatio(policy, 390, 460), 1);
  assert.equal(renderIntervalMs(policy, { now: 1000, lastInteractionAt: 0 }), 1000 / 30);
  assert.equal(renderIntervalMs(policy, { now: 6000, lastInteractionAt: 0 }), 1000 / 12);
});

test('a fresh interaction and an ongoing camera/celebration wake the idle budget', () => {
  const policy = createRenderPolicy({ coarsePointer: true });
  assert.equal(renderIntervalMs(policy, { now: 6000, lastInteractionAt: 5999 }), 1000 / 30);
  assert.equal(renderIntervalMs(policy, { now: 6000, lastInteractionAt: 0, busy: true }), 1000 / 30);
  assert.equal(renderIntervalMs(policy, { now: 6000, lastInteractionAt: 0, busy: false }), 1000 / 12);
});

test('desktop retains a bounded clear view and also reduces idle work', () => {
  const policy = createRenderPolicy({ devicePixelRatio: 2 });
  assert.equal(policy.activeFps, 60);
  assert.equal(policy.idleFps, 20);
  assert.equal(policy.shadowSize, 1024);
  assert.equal(renderPixelRatio(policy, 800, 600), 1.5);
  assert.equal(renderPixelRatio(createRenderPolicy({ devicePixelRatio: 1 }), 800, 600), 1);
  assert.equal(renderIntervalMs(policy, { now: 6000, lastInteractionAt: 0 }), 50);
});

test('large drawing surfaces have a total pixel budget, including on tablets', () => {
  for (const coarsePointer of [true, false]) {
    const policy = createRenderPolicy({ coarsePointer, devicePixelRatio: 3 });
    const ratio = renderPixelRatio(policy, 3000, 2000);
    assert(ratio > 0 && ratio <= policy.maxPixelRatio);
    assert(3000 * 2000 * ratio * ratio <= policy.maxPixels + 0.01);
  }
});

test('empty surfaces and invalid device pixel ratios do not allocate giant or invalid buffers', () => {
  for (const devicePixelRatio of [0, -1, NaN, Infinity]) {
    const policy = createRenderPolicy({ devicePixelRatio });
    assert.equal(renderPixelRatio(policy, 0, 0), 1);
  }
});
