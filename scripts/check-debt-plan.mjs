#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const DEBT_CATEGORIES = ['lintWarnings', 'uiLiterals', 'importantDeclarations', 'inlineStaticStyles'];

export function validateDebtPlan(plan, current, now = new Date()) {
  const errors = [];
  if (plan?.schemaVersion !== 1 || !Array.isArray(plan.targets) || !plan.startingPoint) return ['debt reduction plan must use schemaVersion 1 with startingPoint and targets'];
  let previous = plan.startingPoint;
  let previousDeadline = '';
  for (const [index, target] of plan.targets.entries()) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(target.deadline ?? '') || target.deadline <= previousDeadline) errors.push(`target ${index} deadline must increase in ISO date order`);
    for (const category of DEBT_CATEGORIES) {
      if (!Number.isInteger(target[category]) || target[category] < 0) errors.push(`target ${index}.${category} must be a non-negative integer`);
      if (target[category] > previous[category]) errors.push(`target ${index}.${category} must not increase from the previous ceiling`);
    }
    previous = target;
    previousDeadline = target.deadline;
  }
  for (const category of DEBT_CATEGORIES) {
    if (!Number.isInteger(current[category]) || current[category] < 0) errors.push(`current ${category} is invalid`);
    if (current[category] > plan.startingPoint[category]) errors.push(`current ${category} ${current[category]} exceeds reviewed starting point ${plan.startingPoint[category]}`);
  }
  const nowMs = now.getTime();
  for (const target of plan.targets) {
    const deadlineMs = Date.parse(`${target.deadline}T23:59:59.999Z`);
    if (nowMs <= deadlineMs) continue;
    for (const category of DEBT_CATEGORIES) if (current[category] > target[category]) errors.push(`${category} ${current[category]} missed ${target.deadline} ceiling ${target[category]}`);
  }
  return errors;
}

export function readCurrentDebt(root = process.cwd()) {
  const lint = JSON.parse(readFileSync(path.join(root, 'quality', 'lint-warning-baseline.json'), 'utf8'));
  const literals = JSON.parse(readFileSync(path.join(root, 'quality', 'ui-literal-baseline.json'), 'utf8'));
  const styles = JSON.parse(readFileSync(path.join(root, 'quality', 'style-debt-baseline.json'), 'utf8'));
  return {
    lintWarnings: lint.totalWarnings,
    uiLiterals: literals.totalLiterals,
    importantDeclarations: styles.importantTotal,
    inlineStaticStyles: styles.inlineStaticTotal,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = process.cwd();
  const plan = JSON.parse(readFileSync(path.join(root, 'quality', 'debt-reduction-plan.json'), 'utf8'));
  const current = readCurrentDebt(root);
  const errors = validateDebtPlan(plan, current, new Date());
  if (errors.length > 0) {
    console.error('Debt reduction plan failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(`Debt plan passed: ${DEBT_CATEGORIES.map((category) => `${category}=${current[category]}`).join(', ')}.`);
}
