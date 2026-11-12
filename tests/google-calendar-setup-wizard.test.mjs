import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const wizard = readFileSync('src/modals/google-calendar-setup-wizard.ts', 'utf8');
const quickCapture = readFileSync('src/modals/quick-capture-modal.ts', 'utf8');

void test('Google Calendar setup cannot read or write the vault-wide global filter', () => {
  assert.doesNotMatch(wizard, /settings\.globalFilter/u);
  assert.doesNotMatch(wizard, /Default calendar tag/u);
  assert.match(wizard, /openGoogleCalendarQuickCaptureModal/u);
});

void test('Google Calendar quick capture owns the fixed calendar tag', () => {
  assert.match(quickCapture, /#google-calendar/u);
  assert.match(quickCapture, /if \(!line\.includes\('#google-calendar'\)\)/u);
});
