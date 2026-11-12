import test from 'node:test';
import assert from 'node:assert/strict';
import { DashboardView } from '../src/dashboard';
import { installDomHarness } from './dom-harness';

test('expanded card measurement traverses geometry-less render hosts and restores body sizing', context => {
  const dom = installDomHarness(); context.after(dom.cleanup);
  const card = dom.document.createElement('section');
  card.style.border = '1px solid black';
  const header = dom.document.createElement('header'); header.className = 'tm-dash-card-header';
  Object.defineProperty(header, 'offsetHeight', { value: 40 });
  const body = dom.document.createElement('div');
  body.style.flex = '1 1 auto'; body.style.height = '100%'; body.style.paddingBottom = '12px';
  // JSDOM does not lay out: these measured boxes represent the real collapsed -> expanded failure.
  // The render host uses display:contents and has no box; both real control rows still have boxes.
  body.getBoundingClientRect = () => ({ top: 40 } as DOMRect);
  Object.defineProperty(body, 'offsetHeight', { value: 12 });
  const host = dom.document.createElement('div'); host.style.display = 'contents';
  const inputRow = dom.document.createElement('div');
  const actionRow = dom.document.createElement('div');
  inputRow.getBoundingClientRect = () => ({ bottom: 80 } as DOMRect);
  actionRow.getBoundingClientRect = () => ({ bottom: 120 } as DOMRect);
  host.append(inputRow, actionRow); body.appendChild(host); card.append(header, body); dom.document.body.appendChild(card);
  const measure = DashboardView.prototype as unknown as { measureCardContentRows(card: unknown, row: number, gap: number): number };
  const rows = measure.measureCardContentRows({ config: { collapsed: false }, el: card, bodyEl: body }, 7, 4);
  assert.equal(rows, 13, 'both control rows, padding and header must fit, not only the display:contents wrapper');
  assert.equal(body.style.flex, '1 1 auto');
  assert.equal(body.style.height, '100%');
});
