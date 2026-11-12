import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readCurrentDebt, validateDebtPlan } from '../scripts/check-debt-plan.mjs';

const plan = JSON.parse(readFileSync('quality/debt-reduction-plan.json', 'utf8'));

test('debt plan accepts current ratchets before the first deadline', () => {
  assert.deepEqual(validateDebtPlan(plan, readCurrentDebt(), new Date('2026-07-12T12:00:00Z')), []);
});

test('debt plan enforces dated ceilings after deadlines', () => {
  const errors = validateDebtPlan(plan, plan.startingPoint, new Date('2026-10-01T00:00:00Z'));
  for (const category of plan.categories) assert.ok(errors.some((error) => error.includes(category)));
});

test('debt plan rejects non-monotonic targets and baseline inflation', () => {
  const malformed = structuredClone(plan);
  malformed.targets[1].uiLiterals = malformed.targets[0].uiLiterals + 1;
  assert.ok(validateDebtPlan(malformed, readCurrentDebt(), new Date('2026-07-12T12:00:00Z')).some((error) => error.includes('must not increase')));
  const inflated = { ...readCurrentDebt(), lintWarnings: plan.startingPoint.lintWarnings + 1 };
  assert.ok(validateDebtPlan(plan, inflated, new Date('2026-07-12T12:00:00Z')).some((error) => error.includes('starting point')));
});
