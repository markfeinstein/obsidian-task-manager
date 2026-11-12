import assert from 'node:assert/strict';
import test from 'node:test';
import { runDashboardRenderQueue } from '../src/dashboard-render-scheduler';

test('Dashboard render queue enforces its concurrency ceiling', async () => {
  let active = 0;
  let maximum = 0;
  const completed: number[] = [];
  await runDashboardRenderQueue([0, 1, 2, 3, 4, 5], 2, async (item) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => { setTimeout(resolve, 1); });
    completed.push(item);
    active -= 1;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(completed.sort((left, right) => left - right), [0, 1, 2, 3, 4, 5]);
});

test('Dashboard render queue stops scheduling after cancellation', async () => {
  let continueRendering = true;
  const started: number[] = [];
  await runDashboardRenderQueue([0, 1, 2, 3], 1, async (item) => {
    started.push(item);
    continueRendering = false;
  }, () => continueRendering);
  assert.deepEqual(started, [0]);
});
