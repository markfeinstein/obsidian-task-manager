/**
 * Keyboard-accessible task attribute picker.
 * Two-level SuggestModal: pick attribute → pick value (or open DatePickerModal).
 * Used by the "Task Manager: Set task attribute" command.
 */

import { App, SuggestModal } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import type { TaskManagerSettings } from './types';
import { DatePickerModal, DateTabsModal, DATE_TABS, taskLineToolbarCheckbox } from './task-line-toolbar';

// ── Date helpers ──────────────────────────────────────────────────────────────

function fmtDate(iso: string, settings: TaskManagerSettings): string {
  return settings.dateFormat === 'wikilink' ? `[[${iso}]]` : iso;
}

// ── Attribute definitions ─────────────────────────────────────────────────────

export interface PickerOption {
  label: string;
  value: string;
}

interface AttributeBase {
  id: string;
  emoji: string;
  label: string;
  detect(lineText: string): boolean;
}

interface AttributeWithOptions extends AttributeBase {
  kind: 'options';
  getOptions(settings: TaskManagerSettings): PickerOption[];
  getOptions2?(): PickerOption[];
  buildInsert(value: string, settings: TaskManagerSettings): string;
}

interface AttributeWithDate extends AttributeBase {
  kind: 'date';
  buildInsert(iso: string, settings: TaskManagerSettings): string;
}

interface AttributeDirect extends AttributeBase {
  kind: 'direct';
  buildInsert(settings: TaskManagerSettings): string;
}

interface AttributeWithDateTabs extends AttributeBase {
  kind: 'date-tabs';
}

type Attribute = AttributeWithOptions | AttributeWithDate | AttributeDirect | AttributeWithDateTabs;

export const PICKER_ATTRIBUTES: Attribute[] = [
  {
    id: 'dates', emoji: '📅', label: 'Dates (due / scheduled / start)', kind: 'date-tabs' as const,
    detect: (t) => /[📅📆🗓]/.test(t) || /[⏳⌛]/.test(t) || /🛫/.test(t),
  },
  {
    id: 'followup', emoji: '👀', label: 'Follow-up date', kind: 'date',
    detect: (t) => /👀/.test(t),
    buildInsert: (iso, s) => ` 👀 ${fmtDate(iso, s)}`,
  },
  {
    id: 'priority', emoji: '🔼', label: 'Priority', kind: 'options',
    detect: (t) => /🔺|⏫|🔼|🔽|⏬/.test(t),
    getOptions: () => [
      { label: '🔺  Highest', value: '🔺' },
      { label: '⏫  High',    value: '⏫' },
      { label: '🔼  Medium',  value: '🔼' },
      { label: '🔽  Low',     value: '🔽' },
      { label: '⏬  Lowest',  value: '⏬' },
    ],
    buildInsert: (v) => ` ${v}`,
  },
  {
    id: 'recurrence', emoji: '🔁', label: 'Repeat', kind: 'options',
    detect: (t) => /🔁/.test(t),
    getOptions: () => [
      { label: 'Every day',                            value: 'every day' },
      { label: 'Every weekday',                        value: 'every weekday' },
      { label: 'Every week',                           value: 'every week' },
      { label: 'Every 2 weeks',                        value: 'every 2 weeks' },
      { label: 'Every month',                          value: 'every month' },
      { label: 'Every year',                           value: 'every year' },
    ],
    getOptions2: () => [
      { label: '↻  Every day — from completion',      value: 'every day when done' },
      { label: '↻  Every week — from completion',     value: 'every week when done' },
      { label: '↻  Every 2 weeks — from completion',  value: 'every 2 weeks when done' },
      { label: '↻  Every month — from completion',    value: 'every month when done' },
      { label: '↻  Every year — from completion',     value: 'every year when done' },
    ],
    buildInsert: (v) => ` 🔁 ${v}`,
  },
  {
    id: 'effort', emoji: '⏱️', label: 'Effort estimate', kind: 'options',
    detect: (t) => /⏱/.test(t),
    getOptions: () => [
      { label: '15 minutes', value: '15m'    },
      { label: '30 minutes', value: '30m'    },
      { label: '45 minutes', value: '45m'    },
      { label: '1 hour',     value: '1h'     },
      { label: '1.5 hours',  value: '1h 30m' },
      { label: '2 hours',    value: '2h'     },
      { label: '3 hours',    value: '3h'     },
      { label: '4 hours',    value: '4h'     },
      { label: '6 hours',    value: '6h'     },
      { label: '8 hours',    value: '8h'     },
    ],
    buildInsert: (v) => ` ⏱️ ${v}`,
  },
  {
    id: 'time', emoji: '⌚', label: 'Time of day', kind: 'options',
    detect: (t) => /⌚/.test(t),
    getOptions: () => {
      const opts: PickerOption[] = [];
      for (let h = 7; h <= 22; h++) {
        for (const m of [0, 30]) {
          if (h === 22 && m === 30) break;
          const ts = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
          opts.push({ label: ts, value: ts });
        }
      }
      return opts;
    },
    buildInsert: (v) => ` ⌚ ${v}`,
  },
  {
    id: 'assignee', emoji: '👤', label: 'Assignee', kind: 'direct',
    detect: (t) => /👤/.test(t),
    buildInsert: () => ' 👤 @',
  },
  {
    id: 'tag', emoji: '#️⃣', label: 'Tag', kind: 'direct',
    detect: (t) => {
      const m = t.match(/^(?:\s*)(?:[-*+]|\d+[.)])\s+\[[^\]]*\]\s+(.*)/s);
      return m ? /#\w/.test(m[1]) : false;
    },
    buildInsert: () => ' #',
  },
];

// ── Level-2: option picker ────────────────────────────────────────────────────

class OptionPickerModal extends SuggestModal<PickerOption> {
  constructor(
    app: App,
    private readonly attribute: AttributeWithOptions,
    private readonly settings: TaskManagerSettings,
    private readonly onChoose: (value: string) => void,
  ) {
    super(app);
    this.setPlaceholder(`Choose ${attribute.label.toLowerCase()}…`);
  }

  getSuggestions(query: string): PickerOption[] {
    const q = query.toLowerCase();
    const all = [
      ...this.attribute.getOptions(this.settings),
      ...(this.attribute.getOptions2?.() ?? []),
    ];
    return q ? all.filter((o) => o.label.toLowerCase().includes(q)) : all;
  }

  renderSuggestion(item: PickerOption, el: HTMLElement): void {
    el.createSpan({ text: item.label });
  }

  onChooseSuggestion(item: PickerOption): void {
    this.onChoose(item.value);
  }
}

// ── Level-1: attribute picker ─────────────────────────────────────────────────

class AttributePickerModal extends SuggestModal<Attribute> {
  constructor(
    app: App,
    private readonly lineText: string,
    private readonly lineFrom: number,
    private readonly view: EditorView,
    private readonly getSettings: () => TaskManagerSettings,
  ) {
    super(app);
    this.setPlaceholder('Pick an attribute to add…');
  }

  getSuggestions(query: string): Attribute[] {
    const q = query.toLowerCase();
    return PICKER_ATTRIBUTES
      .filter((a) => !a.detect(this.lineText))
      .filter((a) => !q || a.label.toLowerCase().includes(q) || a.emoji.includes(q));
  }

  renderSuggestion(attr: Attribute, el: HTMLElement): void {
    el.addClass('task-attr-picker-item');
    el.createSpan({ text: `${attr.emoji}  ${attr.label}` });
  }

  onChooseSuggestion(attr: Attribute): void {
    const settings = this.getSettings();

    if (attr.kind === 'date-tabs') {
      const state = this.view.state;
      const line = state.doc.lineAt(this.lineFrom);
      const modal = new DateTabsModal(this.app, line.text, (changes) => {
        const currentState = this.view.state;
        const currentLine = currentState.doc.lineAt(this.lineFrom);
        let text = currentLine.text;
        for (const tab of DATE_TABS) {
          text = text.replace(new RegExp(tab.stripRe.source, 'gu'), '');
        }
        text = text.replace(/\s+$/u, '');
        let additions = '';
        for (const tab of DATE_TABS) {
          const c = changes[tab.id];
          if (c) additions += tab.buildToken(c.iso, c.time, settings);
        }
        const newText = text + additions;
        this.view.dispatch(currentState.update({
          changes: { from: currentLine.from, to: currentLine.to, insert: newText },
          selection: { anchor: currentLine.from + newText.length },
        }));
        this.view.focus();
      });
      modal.open();
      return;
    }

    if (attr.kind === 'date') {
      const modal = new DatePickerModal(this.app, attr.label, (iso) => {
        this.insertText(attr.buildInsert(iso, settings));
      });
      modal.open();
      return;
    }

    if (attr.kind === 'direct') {
      this.insertText(attr.buildInsert(settings));
      return;
    }

    // options kind → level-2 modal
    new OptionPickerModal(this.app, attr, settings, (value) => {
      this.insertText(attr.buildInsert(value, settings));
    }).open();
  }

  private insertText(text: string): void {
    const state = this.view.state;
    const line = state.doc.lineAt(this.lineFrom);
    this.view.dispatch(state.update({
      changes: { from: line.to, to: line.to, insert: text },
      selection: { anchor: line.to + text.length },
    }));
    this.view.focus();
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Open the two-level keyboard attribute picker for the task line at the cursor.
 * Returns false if the cursor is not on a task line.
 */
export function openTaskAttributePicker(
  app: App,
  view: EditorView,
  getSettings: () => TaskManagerSettings,
): boolean {
  const state = view.state;
  const cursor = state.selection.main.head;
  const line = state.doc.lineAt(cursor);
  if (taskLineToolbarCheckbox(line.text) === null) return false;
  new AttributePickerModal(app, line.text, line.from, view, getSettings).open();
  return true;
}
