/**
 * Task Line Ghost Toolbar
 * Ghost attribute-picker icons at the end of incomplete task lines.
 * Hover the line → icons fade in → click to add attributes via menu or date picker.
 */

import { App, Modal } from 'obsidian';
import {
  ViewPlugin, WidgetType, Decoration,
  type DecorationSet, type EditorView,
  type PluginValue, type ViewUpdate,
} from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { TaskManagerSettings } from './types';
import { formatIsoDisplayDate } from './display-date';

// ── Date helpers ──────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function relDate(n: number): Date { const d = new Date(); d.setDate(d.getDate() + n); return d; }
export function calendarMonthLabel(year: number, month: number): string {
  return formatIsoDisplayDate(`${year}-${String(month + 1).padStart(2, '0')}-01`, { month: 'long', year: 'numeric' });
}
export function calendarWeekdayLabels(): string[] {
  return Array.from({ length: 7 }, (_value, index) => formatIsoDisplayDate(`2023-01-${String(index + 1).padStart(2, '0')}`, { weekday: 'short' }));
}
function nextWeekday(day: number): Date {
  const d = new Date(); let diff = day - d.getDay(); if (diff <= 0) diff += 7; d.setDate(d.getDate() + diff); return d;
}
function thisWeekend(): Date {
  // Next Saturday on or after today (if today is Saturday, returns today)
  const d = new Date(); const diff = (6 - d.getDay() + 7) % 7; d.setDate(d.getDate() + diff); return d;
}
function firstOfNextMonth(): Date {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + 1); return d;
}
function addMonthsClamped(date: Date, count: number): Date {
  const target = new Date(date.getTime());
  target.setDate(1);
  target.setMonth(target.getMonth() + count);
  const monthEnd = new Date(target.getTime());
  monthEnd.setMonth(target.getMonth() + 1, 0);
  target.setDate(Math.min(date.getDate(), monthEnd.getDate()));
  return target;
}
function fmtDate(iso: string, settings: TaskManagerSettings): string {
  return settings.dateFormat === 'wikilink' ? `[[${iso}]]` : iso;
}

/**
 * Parse a natural-language time string into 24h "HH:MM".
 * Accepts: "3pm", "3 pm", "3:30pm", "15:30", "1530", "9", "noon", "midnight".
 * Returns null if unparseable, '' for empty input.
 */
export function parseTimeInput(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return '';
  if (s === 'noon' || s === 'midday') return '12:00';
  if (s === 'midnight') return '00:00';

  const pad = (n: number) => String(n).padStart(2, '0');
  const norm = (h: number, m: number, ampm?: string): string | null => {
    if (m < 0 || m > 59) return null;
    if (ampm === 'pm') { if (h < 12) h += 12; }
    else if (ampm === 'am') { if (h === 12) h = 0; }
    if (h < 0 || h > 23) return null;
    return `${pad(h)}:${pad(m)}`;
  };

  // 3pm | 3:30pm | 3.30 pm | 9 am
  let m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)$/.exec(s);
  if (m) return norm(Number(m[1]), m[2] ? Number(m[2]) : 0, m[3]);

  // 15:30 | 9:05 (24h)
  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) return norm(Number(m[1]), Number(m[2]));

  // 1530 | 0905 (military, 3–4 digits)
  m = /^(\d{1,2})(\d{2})$/.exec(s);
  if (m) return norm(Number(m[1]), Number(m[2]));

  // bare hour: 9 -> 09:00
  m = /^(\d{1,2})$/.exec(s);
  if (m) return norm(Number(m[1]), 0);

  return null;
}

/** Format 24h "HH:MM" as a friendly 12h string, e.g. "3:00 PM". */
function formatTime12(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  let h = Number(m[1]);
  const ampm = h < 12 ? 'AM' : 'PM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${m[2]} ${ampm}`;
}

/** Format an ISO date as a friendly short label, e.g. "Jun 2". */
function fmtShortDate(iso: string): string {
  const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const p = iso.split('-').map(Number);
  return `${MONTHS_SHORT[p[1] - 1]} ${p[2]}`;
}

// ── Natural-language instruction parser ───────────────────────────────────────

const WEEKDAY_MAP: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};
const MONTHS_FULL = ['january','february','march','april','may','june','july','august','september','october','november','december'];

function monthIndex(name: string): number {
  const normalized = name.toLowerCase().replace(/^sept$/u, 'sep');
  return MONTHS_FULL.findIndex((m) => m === normalized || m.slice(0, 3) === normalized);
}

function localDateOrNull(year: number, month: number, day: number): Date | null {
  const date = new Date(year, month, day);
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day ? date : null;
}

/** Next occurrence of a weekday (1–7 days ahead; never today). */
function nextNamedWeekday(target: number): Date {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  let diff = (target - d.getDay() + 7) % 7;
  if (diff === 0) diff = 7;
  d.setDate(d.getDate() + diff);
  return d;
}

/** Pull a time expression out of a phrase, returning the parsed 24h time and the leftover text. */
function extractTime(text: string): { time: string; rest: string } {
  const patterns = [
    /@\s*(noon|midnight|midday|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
    /\bat\s+(noon|midnight|midday|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
    /\b(\d{1,2}:\d{2}\s*(?:am|pm)?)/i,
    /\b(\d{1,2}\s*(?:am|pm))/i,
    /\b(noon|midnight|midday)\b/i,
    /(?:^|\s)(\d{3,4})\s*$/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const parsed = parseTimeInput(m[1].trim());
      if (parsed) {
        return { time: parsed, rest: `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}` };
      }
    }
  }
  return { time: '', rest: text };
}

/** Parse a date phrase (no field keyword, no time) into a Date, or null. */
function parseDatePhrase(phrase: string): Date | null {
  const s = phrase.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);

  if (/^(today|tonight)$/.test(s)) return today;
  if (/^(tomorrow|tmrw|tmr)$/.test(s)) return relDate(1);
  if (/^yesterday$/.test(s)) return relDate(-1);
  if (/^this ?weekend$/.test(s)) return thisWeekend();
  if (/^this ?week$/.test(s)) return today;
  if (/^next ?week$/.test(s)) return nextWeekday(1);
  if (/^next ?month$/.test(s)) return firstOfNextMonth();

  let m = /^in (\d+) (day|days|week|weeks|month|months)$/.exec(s);
  if (m) {
    const n = Number(m[1]); const d = new Date(today);
    if (m[2].startsWith('day')) d.setDate(d.getDate() + n);
    else if (m[2].startsWith('week')) d.setDate(d.getDate() + n * 7);
    else return addMonthsClamped(d, n);
    return d;
  }

  m = /^(?:next|this|coming|on)?\s*([a-z]+)$/.exec(s);
  if (m && m[1] in WEEKDAY_MAP) return nextNamedWeekday(WEEKDAY_MAP[m[1]]);

  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return localDateOrNull(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  // "jun 2", "june 2nd"
  m = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?$/.exec(s);
  if (m) {
    const idx = monthIndex(m[1]);
    if (idx >= 0) {
      let dt = localDateOrNull(today.getFullYear(), idx, Number(m[2]));
      if (dt && dt < today) dt = localDateOrNull(today.getFullYear() + 1, idx, Number(m[2]));
      return dt;
    }
  }
  // "2 jun", "2nd june"
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?$/.exec(s);
  if (m) {
    const idx = monthIndex(m[2]);
    if (idx >= 0) {
      let dt = localDateOrNull(today.getFullYear(), idx, Number(m[1]));
      if (dt && dt < today) dt = localDateOrNull(today.getFullYear() + 1, idx, Number(m[1]));
      return dt;
    }
  }
  // numeric M/D or M/D/Y
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(s);
  if (m) {
    let y = m[3] ? Number(m[3]) : today.getFullYear();
    if (y < 100) y += 2000;
    return localDateOrNull(y, Number(m[1]) - 1, Number(m[2]));
  }

  return null;
}

export interface NlParseResult {
  results: Partial<Record<DateTab, { iso: string; time: string }>>;
  order: DateTab[];
  unmatched: string[];
}

/**
 * Parse a complex instruction like:
 *   "schedule for next week, start on wednesday @ noon, due friday 2:00pm"
 * into per-field dates/times.
 */
export function parseNaturalDateInstruction(input: string): NlParseResult {
  const out: NlParseResult = { results: {}, order: [], unmatched: [] };
  if (!input.trim()) return out;

  let lastField: DateTab | null = null;
  const segments = input.split(/\s*(?:,|;|\band\b|\bthen\b)\s*/i).map((s) => s.trim()).filter(Boolean);
  for (const segRaw of segments) {
    let field: DateTab | null = null;
    if (/\b(due|deadline)\b/i.test(segRaw)) field = 'due';
    else if (/\b(scheduled?|sched)\b/i.test(segRaw)) field = 'scheduled';
    else if (/\b(starts?|starting|begins?|from)\b/i.test(segRaw)) field = 'start';

    let seg = segRaw.replace(/\b(due|deadline|scheduled?|sched|starts?|starting|begins?|from)\b/ig, ' ');
    const { time, rest } = extractTime(seg);
    seg = rest.replace(/\b(for|on|by|the|to|of)\b/ig, ' ').trim();

    const date = parseDatePhrase(seg);
    const targetField: DateTab | null = field ?? (!date && time ? lastField : (!out.results.due ? 'due' : null));
    if (!targetField) { out.unmatched.push(segRaw); continue; }
    if (!date && !time) { out.unmatched.push(segRaw); continue; }
    if (!date && time) {
      // time only, applied to an already-set field (e.g. "due at 2pm" after due set elsewhere)
      const existing = out.results[targetField];
      if (existing) { existing.time = time; lastField = targetField; continue; }
      out.unmatched.push(segRaw); continue;
    }
    out.results[targetField] = { iso: isoDate(date as Date), time };
    lastField = targetField;
    if (!out.order.includes(targetField)) out.order.push(targetField);
  }
  return out;
}

// ── Date Picker Modal ─────────────────────────────────────────────────────────

export class DatePickerModal extends Modal {
  private viewYear: number;
  private viewMonth: number;
  private calendarEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly title: string,
    private readonly onSelect: (iso: string) => void,
  ) {
    super(app);
    const now = new Date();
    this.viewYear = now.getFullYear();
    this.viewMonth = now.getMonth();
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass('task-date-picker-modal-shell');
    this.modalEl.setAttribute('aria-label', this.title);
    contentEl.empty();
    contentEl.addClass('task-date-picker-modal');

    contentEl.createEl('h3', { text: this.title, cls: 'task-date-picker-title' });

    // ── Quick picks ───────────────────────────────────────────────────────────
    const quick = contentEl.createDiv('task-date-picker-quick');
    const presets: Array<{ label: string; date: Date }> = [
      { label: 'Today',       date: new Date() },
      { label: 'Tomorrow',              date: relDate(1) },
      { label: 'This Weekend',   date: thisWeekend() },
      { label: 'Next Week',        date: nextWeekday(1) },
      { label: 'Next Month',       date: firstOfNextMonth() },
    ];
    for (const p of presets) {
      const btn = quick.createEl('button', { text: p.label, cls: 'task-date-picker-quick-btn' });
      btn.addEventListener('click', () => { this.close(); this.onSelect(isoDate(p.date)); });
    }

    // ── Calendar ──────────────────────────────────────────────────────────────
    this.calendarEl = contentEl.createDiv('task-date-picker-calendar');
    this.renderCalendar();
  }

  private renderCalendar(): void {
    if (!this.calendarEl) return;
    this.calendarEl.empty();

    const days = calendarWeekdayLabels();

    // Header
    const header = this.calendarEl.createDiv('task-date-picker-cal-header');
    const prev = header.createEl('button', { text: '◀', cls: 'task-date-picker-nav' });
    prev.addEventListener('click', () => {
      this.viewMonth--; if (this.viewMonth < 0) { this.viewMonth = 11; this.viewYear--; }
      this.renderCalendar();
    });
    header.createSpan({ text: calendarMonthLabel(this.viewYear, this.viewMonth), cls: 'task-date-picker-cal-month' });
    const next = header.createEl('button', { text: '▶', cls: 'task-date-picker-nav' });
    next.addEventListener('click', () => {
      this.viewMonth++; if (this.viewMonth > 11) { this.viewMonth = 0; this.viewYear++; }
      this.renderCalendar();
    });

    // Weekday labels
    const grid = this.calendarEl.createDiv('task-date-picker-cal-grid');
    for (const day of days) grid.createSpan({ text: day, cls: 'task-date-picker-cal-label' });

    // Day cells
    const today = isoDate(new Date());
    const firstDay = new Date(this.viewYear, this.viewMonth, 1);
    // Sunday-based offset (getDay() returns 0=Sun)
    const startOffset = firstDay.getDay();
    const daysInMonth = new Date(this.viewYear, this.viewMonth + 1, 0).getDate();

    for (let i = 0; i < startOffset; i++) grid.createSpan({ cls: 'task-date-picker-cal-empty' });
    for (let day = 1; day <= daysInMonth; day++) {
      const iso = `${String(this.viewYear)}-${String(this.viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const cls = ['task-date-picker-cal-day', ...(iso === today ? ['is-today'] : [])].join(' ');
      const cell = grid.createEl('button', { text: String(day), cls });
      cell.addEventListener('click', () => { this.close(); this.onSelect(iso); });
    }
  }

  onClose(): void { this.contentEl.empty(); }
}

// ── Tabbed date picker (due / scheduled / start) ──────────────────────────────

export type DateTab = 'due' | 'scheduled' | 'start';

export interface TabDef {
  id: DateTab;
  emoji: string;
  label: string;
  /** Strips the existing value for this field from a line of text (global regex). */
  stripRe: RegExp;
  buildToken(iso: string, time: string, settings: TaskManagerSettings): string;
}

export const DATE_TABS: TabDef[] = [
  {
    id: 'due', emoji: '📅', label: 'Due',
    stripRe: /\s*[\u{1F4C5}\u{1F4C6}\u{1F5D3}]\uFE0F?\s*(?:\[\[\d{4}-\d{2}-\d{2}[^\]]*\]\]|\d{4}-\d{2}-\d{2})(?:\s+\d{1,2}:\d{2})?/gu,
    buildToken(iso, time, s) {
      const d = s.dateFormat === 'wikilink' ? `[[${iso}]]` : iso;
      return time ? ` 📅 ${d} ${time}` : ` 📅 ${d}`;
    },
  },
  {
    id: 'scheduled', emoji: '⏳', label: 'Scheduled',
    stripRe: /\s*[\u{23F3}\u{231B}]\uFE0F?\s*(?:\[\[\d{4}-\d{2}-\d{2}[^\]]*\]\]|\d{4}-\d{2}-\d{2})(?:\s+\d{1,2}:\d{2})?/gu,
    buildToken(iso, time, s) {
      const d = s.dateFormat === 'wikilink' ? `[[${iso}]]` : iso;
      return time ? ` ⏳ ${d} ${time}` : ` ⏳ ${d}`;
    },
  },
  {
    id: 'start', emoji: '🛫', label: 'Start',
    stripRe: /\s*\u{1F6EB}\uFE0F?\s*(?:\[\[\d{4}-\d{2}-\d{2}[^\]]*\]\]|\d{4}-\d{2}-\d{2})(?:\s+\d{1,2}:\d{2})?/gu,
    buildToken(iso, time, s) {
      const d = s.dateFormat === 'wikilink' ? `[[${iso}]]` : iso;
      return time ? ` 🛫 ${d} ${time}` : ` 🛫 ${d}`;
    },
  },
];

/** Extract an existing ISO date (+ optional HH:MM time) from a line using a tab's stripRe. */
function parseExistingDate(text: string, stripRe: RegExp): { iso: string; time: string } | null {
  const re = new RegExp(stripRe.source, 'u'); // non-global for single match
  const m = re.exec(text);
  if (!m) return null;
  const dm = /(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?/u.exec(m[0]);
  if (!dm) return null;
  return { iso: dm[1], time: dm[2] ?? '' };
}

// ── Tabbed date modal ─────────────────────────────────────────────────────────

export class DateTabsModal extends Modal {
  private activeTab: DateTab = 'due';
  private readonly dates: Record<DateTab, string> = { due: '', scheduled: '', start: '' };
  private readonly times: Record<DateTab, string> = { due: '', scheduled: '', start: '' };
  private readonly timeInputs: Partial<Record<DateTab, HTMLInputElement>> = {};
  private tabContentEl: HTMLElement | null = null;
  private readonly tabBtns: Partial<Record<DateTab, HTMLElement>> = {};
  private viewYear: number;
  private viewMonth: number;
  private validationEl: HTMLElement | null = null;
  private applyBtn: HTMLButtonElement | null = null;
  private summaryEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly lineText: string,
    private readonly onApply: (changes: Record<DateTab, { iso: string; time: string } | null>) => void,
  ) {
    super(app);
    // Pre-populate from existing line values
    for (const tab of DATE_TABS) {
      const existing = parseExistingDate(lineText, tab.stripRe);
      if (existing) {
        this.dates[tab.id] = existing.iso;
        this.times[tab.id] = existing.time;
      }
    }
    // Default to first unset tab, else 'due'
    const firstUnset = DATE_TABS.find((t) => !this.dates[t.id]);
    this.activeTab = firstUnset?.id ?? 'due';
    const now = new Date();
    this.viewYear = now.getFullYear();
    this.viewMonth = now.getMonth();
    const existingIso = this.dates[this.activeTab];
    if (existingIso) {
      const parts = existingIso.split('-').map(Number);
      this.viewYear = parts[0];
      this.viewMonth = parts[1] - 1;
    }
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass('task-dates-modal-shell');
    this.modalEl.setAttribute('aria-label', 'Schedule task dates');
    contentEl.empty();
    contentEl.addClass('task-dates-modal');

    const header = contentEl.createDiv('task-dates-header');
    header.createEl('h3', { text: 'Schedule task', cls: 'task-dates-title' });
    header.createDiv({ text: 'Set due, scheduled, and start dates with optional times.', cls: 'task-dates-subtitle' });

    // Natural-language instruction bar
    const nlRow = contentEl.createDiv('task-dates-nl-row');
    const nlInput = nlRow.createEl('input', { cls: 'task-dates-nl-input' });
    nlInput.type = 'text';
    nlInput.placeholder = 'Type naturally — e.g. "scheduled next week, start wed @ noon, due fri 2pm"';
    nlInput.setAttr('aria-label', 'Natural-language date instruction');
    const nlBtn = nlRow.createEl('button', { text: 'Parse', cls: 'task-dates-nl-btn' });
    const nlFeedback = contentEl.createDiv('task-dates-nl-feedback');
    nlFeedback.hide();
    const runNl = () => {
      const ok = this.applyNaturalLanguage(nlInput.value, nlFeedback);
      if (ok) nlInput.value = '';
    };
    nlBtn.addEventListener('click', runNl);
    nlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); runNl(); }
    });

    // Tab bar
    const tabBar = contentEl.createDiv('task-dates-tab-bar');
    for (const tab of DATE_TABS) {
      const btn = tabBar.createEl('button', { cls: 'task-dates-tab' });
      btn.dataset.tab = tab.id;
      this.tabBtns[tab.id] = btn;
      btn.addEventListener('click', () => this.switchTab(tab.id));
    }

    // Content area
    this.tabContentEl = contentEl.createDiv('task-dates-content');

    // Validation banner (hidden until needed)
    this.validationEl = contentEl.createDiv('task-dates-validation');
    this.validationEl.hide();

    // Footer — summary (left), then Cancel + Apply (right)
    const footer = contentEl.createDiv('task-dates-footer');
    this.summaryEl = footer.createDiv('task-dates-summary');
    const footerActions = footer.createDiv('task-dates-footer-actions');
    const cancelBtn = footerActions.createEl('button', { text: 'Cancel', cls: 'task-dates-cancel' });
    cancelBtn.addEventListener('click', () => this.close());
    const applyBtn = footerActions.createEl('button', { text: 'Apply', cls: 'task-dates-apply mod-cta' });
    this.applyBtn = applyBtn;
    applyBtn.addEventListener('click', () => {
      if (!this.flushTimeInputs()) return;
      this.close();
      this.onApply({
        due:       this.dates.due       ? { iso: this.dates.due,       time: this.times.due }       : null,
        scheduled: this.dates.scheduled ? { iso: this.dates.scheduled, time: this.times.scheduled } : null,
        start:     this.dates.start     ? { iso: this.dates.start,     time: this.times.start }     : null,
      });
    });

    this.renderTabContent();
    this.updateTabLabels();
    this.updateValidation();
    this.updateSummary();
    contentEl.tabIndex = -1;
    contentEl.addEventListener('keydown', (e) => this.handleKeydown(e));
    window.setTimeout(() => contentEl.focus(), 0);
  }

  private handleKeydown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    // Don't hijack typing in the time input.
    if (target && target.tagName === 'INPUT') return;

    const key = e.key;
    if (key === 'Enter') {
      if (this.applyBtn && !this.applyBtn.disabled) { e.preventDefault(); this.applyBtn.click(); }
      return;
    }
    if (key.toLowerCase() === 't') {
      e.preventDefault();
      this.setActiveDate(isoDate(new Date()));
      return;
    }
    const deltas: Record<string, number> = {
      ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7,
      PageUp: -30, PageDown: 30,
    };
    if (key in deltas) {
      e.preventDefault();
      const base = this.dates[this.activeTab] || isoDate(new Date());
      const parts = base.split('-').map(Number);
      const d = new Date(parts[0], parts[1] - 1, parts[2] + deltas[key]);
      this.setActiveDate(isoDate(d));
    }
  }

  private setActiveDate(iso: string): void {
    this.dates[this.activeTab] = iso;
    const parts = iso.split('-').map(Number);
    this.viewYear = parts[0];
    this.viewMonth = parts[1] - 1;
    this.renderTabContent();
    this.updateTabLabels();
    this.updateValidation();
  }

  private applyNaturalLanguage(text: string, feedback: HTMLElement): boolean {
    const parsed = parseNaturalDateInstruction(text);
    const matched = Object.keys(parsed.results) as DateTab[];
    if (matched.length === 0) {
      feedback.empty();
      feedback.setText(text.trim() ? "Couldn't understand that — try \"due friday 2pm\"." : '');
      feedback.toggleClass('is-error', Boolean(text.trim()));
      feedback.toggle(Boolean(text.trim()));
      return false;
    }
    for (const tab of DATE_TABS) {
      const r = parsed.results[tab.id];
      if (r) { this.dates[tab.id] = r.iso; this.times[tab.id] = r.time; }
    }
    // Focus the last field mentioned and sync the calendar view to it
    const focusField = parsed.order[parsed.order.length - 1] ?? matched[0];
    this.activeTab = focusField;
    const iso = this.dates[focusField];
    if (iso) { const p = iso.split('-').map(Number); this.viewYear = p[0]; this.viewMonth = p[1] - 1; }

    const labelMap: Record<DateTab, string> = { due: 'Due', scheduled: 'Scheduled', start: 'Start' };
    const summary = (Object.keys(parsed.results) as DateTab[])
      .flatMap((id) => {
        const r = parsed.results[id];
        if (!r) return [];
        return `${labelMap[id]} ${fmtShortDate(r.iso)}${r.time ? ` ${formatTime12(r.time)}` : ''}`;
      })
      .join(' · ');
    feedback.empty();
    feedback.removeClass('is-error');
    feedback.textContent = `Set → ${summary}${parsed.unmatched.length ? `  (ignored: ${parsed.unmatched.join(', ')})` : ''}`;
    feedback.show();

    this.renderTabContent();
    this.updateTabLabels();
    this.updateValidation();
    return true;
  }

  private validate(): string[] {
    const errors: string[] = [];
    const { due, scheduled, start } = this.dates;
    if (due && start && start > due) {
      errors.push(`⚠️ Start date (${start}) must be on or before the due date (${due}).`);
    }
    if (start && scheduled && scheduled > start) {
      errors.push(`⚠️ Scheduled date (${scheduled}) must be on or before the start date (${start}).`);
    }
    if (due && scheduled && !start && scheduled > due) {
      errors.push(`⚠️ Scheduled date (${scheduled}) must be on or before the due date (${due}).`);
    }
    return errors;
  }

  private updateValidation(): void {
    if (!this.validationEl || !this.applyBtn) return;
    const errors = this.validate();
    if (errors.length > 0) {
      this.validationEl.empty();
      for (const msg of errors) {
        this.validationEl.createDiv({ cls: 'task-dates-validation-msg' }).textContent = msg;
      }
      this.validationEl.show();
      this.applyBtn.disabled = true;
      this.applyBtn.addClass('is-disabled');
    } else {
      this.validationEl.hide();
      this.applyBtn.disabled = false;
      this.applyBtn.removeClass('is-disabled');
    }
    this.updateSummary();
  }

  private updateSummary(): void {
    const summaryEl = this.summaryEl;
    if (!summaryEl) return;
    summaryEl.empty();
    const parts: Array<{ tab: TabDef; iso: string; time: string }> = [];
    for (const tab of DATE_TABS) {
      const iso = this.dates[tab.id];
      if (iso) parts.push({ tab, iso, time: this.times[tab.id] });
    }
    if (parts.length === 0) {
      summaryEl.createSpan({ text: 'No dates set', cls: 'task-dates-summary-empty' });
      return;
    }
    parts.forEach((p, i) => {
      if (i > 0) summaryEl.createSpan({ text: '  ·  ', cls: 'task-dates-summary-sep' });
      const chip = summaryEl.createSpan({ cls: 'task-dates-summary-item' });
      chip.createSpan({ text: `${p.tab.emoji} `, cls: 'task-dates-summary-emoji' });
      const text = p.time ? `${fmtShortDate(p.iso)} · ${formatTime12(p.time)}` : fmtShortDate(p.iso);
      chip.createSpan({ text });
    });
  }

  private flushTimeInputs(): boolean {
    let valid = true;
    for (const tab of DATE_TABS) {
      const el = this.timeInputs[tab.id];
      if (!el) continue;
      const parsed = parseTimeInput(el.value);
      if (parsed === null) {
        el.addClass('is-error');
        valid = false;
        continue;
      }
      el.removeClass('is-error');
      this.times[tab.id] = parsed;
      el.value = parsed;
    }
    return valid;
  }

  private switchTab(id: DateTab): void {
    this.flushTimeInputs();
    this.activeTab = id;
    const iso = this.dates[id];
    if (iso) {
      const parts = iso.split('-').map(Number);
      this.viewYear = parts[0];
      this.viewMonth = parts[1] - 1;
    } else {
      const now = new Date();
      this.viewYear = now.getFullYear();
      this.viewMonth = now.getMonth();
    }
    this.renderTabContent();
    this.updateTabLabels();
    this.updateValidation();
  }

  private updateTabLabels(): void {
    for (const tab of DATE_TABS) {
      const btn = this.tabBtns[tab.id];
      if (!btn) continue;
      btn.empty();
      btn.toggleClass('is-active', tab.id === this.activeTab);
      btn.createSpan({ text: `${tab.emoji} ${tab.label}` });
      const iso = this.dates[tab.id];
      if (iso) {
        btn.createSpan({ text: ` · ${formatIsoDisplayDate(iso, { month: 'short', day: 'numeric' })}`, cls: 'task-dates-tab-date' });
      }
    }
  }

  private renderTabContent(): void {
    if (!this.tabContentEl) return;
    this.flushTimeInputs();
    this.tabContentEl.empty();

    const days = calendarWeekdayLabels();
    const WEEKEND_DAYS = new Set([0, 6]); // Su=0, Sa=6
    const todayIso = isoDate(new Date());
    const selected = this.dates[this.activeTab];

    // Quick picks
    const quick = this.tabContentEl.createDiv('task-date-picker-quick');
    const presets: Array<{ label: string; d: Date }> = [
      { label: 'Today',       d: new Date() },
      { label: 'Tomorrow',              d: relDate(1) },
      { label: 'This Weekend',   d: thisWeekend() },
      { label: 'Next Week',        d: nextWeekday(1) },
      { label: 'Next Month',       d: firstOfNextMonth() },
    ];
    for (const p of presets) {
      const iso = isoDate(p.d);
      const btn = quick.createEl('button', {
        cls: ['task-date-picker-quick-btn', iso === selected ? 'is-selected' : ''].filter(Boolean).join(' '),
      });
      btn.createSpan({ text: p.label, cls: 'task-date-picker-quick-label' });
      const displayDate = formatIsoDisplayDate(iso, { month: 'short', day: 'numeric' });
      btn.createSpan({ text: displayDate, cls: 'task-date-picker-quick-sub' });
      btn.setAttr('aria-label', `${p.label}: ${displayDate}`);
      btn.addEventListener('click', () => this.setActiveDate(iso));
    }
    // "No date" chip — clears the active field
    const noDateBtn = quick.createEl('button', {
      cls: ['task-date-picker-quick-btn', 'task-date-picker-quick-nodate', !selected ? 'is-selected' : ''].filter(Boolean).join(' '),
    });
    noDateBtn.createSpan({ text: 'No date', cls: 'task-date-picker-quick-label' });
    noDateBtn.createSpan({ text: 'clear', cls: 'task-date-picker-quick-sub' });
    noDateBtn.setAttr('aria-label', 'Clear this date');
    noDateBtn.addEventListener('click', () => {
      this.dates[this.activeTab] = '';
      this.times[this.activeTab] = '';
      this.renderTabContent();
      this.updateTabLabels();
      this.updateValidation();
    });

    // Calendar
    const cal = this.tabContentEl.createDiv('task-date-picker-calendar');
    const header = cal.createDiv('task-date-picker-cal-header');
    const prev = header.createEl('button', { text: '◀', cls: 'task-date-picker-nav' });
    prev.addEventListener('click', () => {
      this.viewMonth--;
      if (this.viewMonth < 0) { this.viewMonth = 11; this.viewYear--; }
      this.renderTabContent();
      this.updateTabLabels();
    });
    const monthLabel = header.createSpan({ text: calendarMonthLabel(this.viewYear, this.viewMonth), cls: 'task-date-picker-cal-month' });
    monthLabel.setAttr('aria-label', 'Jump to current month');
    monthLabel.addEventListener('click', () => {
      const now = new Date();
      this.viewYear = now.getFullYear();
      this.viewMonth = now.getMonth();
      this.renderTabContent();
      this.updateTabLabels();
    });
    const next = header.createEl('button', { text: '▶', cls: 'task-date-picker-nav' });
    next.addEventListener('click', () => {
      this.viewMonth++;
      if (this.viewMonth > 11) { this.viewMonth = 0; this.viewYear++; }
      this.renderTabContent();
      this.updateTabLabels();
    });

    const grid = cal.createDiv('task-date-picker-cal-grid');
    days.forEach((day, index) => grid.createSpan({ text: day, cls: `task-date-picker-cal-label${WEEKEND_DAYS.has(index) ? ' is-weekend' : ''}` }));

    const firstDay = new Date(this.viewYear, this.viewMonth, 1);
    const offset = firstDay.getDay();
    const daysInMonth = new Date(this.viewYear, this.viewMonth + 1, 0).getDate();

    for (let i = 0; i < offset; i++) grid.createSpan({ cls: 'task-date-picker-cal-empty' });
    for (let day = 1; day <= daysInMonth; day++) {
      const iso = `${String(this.viewYear)}-${String(this.viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const classes = [
        'task-date-picker-cal-day',
        iso === todayIso ? 'is-today' : '',
        iso === selected ? 'is-selected' : '',
      ].filter(Boolean).join(' ');
      const cell = grid.createEl('button', { text: String(day), cls: classes });
      cell.addEventListener('click', () => {
        this.dates[this.activeTab] = iso;
        this.renderTabContent();
        this.updateTabLabels();
        this.updateValidation();
      });
    }

    // Time + Clear row
    const timeRow = this.tabContentEl.createDiv('task-dates-time-row');
    timeRow.createSpan({ text: 'Time', cls: 'task-dates-time-label' });
    const timeWrap = timeRow.createDiv('task-dates-time-wrap');
    const timeInput = timeWrap.createEl('input', { cls: 'task-dates-time-input' });
    timeInput.type = 'text';
    timeInput.placeholder = 'e.g. 3pm, 15:30';
    timeInput.value = this.times[this.activeTab] ?? '';
    timeInput.setAttr('aria-label', 'Time (optional) — accepts 3pm, 3:30pm, 15:30, noon');
    const hint = timeWrap.createSpan({ cls: 'task-dates-time-hint' });
    const refreshHint = () => {
      const stored = this.times[this.activeTab];
      if (stored) { hint.setText(formatTime12(stored)); hint.removeClass('is-error'); }
      else { hint.setText(''); hint.removeClass('is-error'); }
    };
    refreshHint();
    const commitTime = () => {
      const parsed = parseTimeInput(timeInput.value);
      if (parsed === null) {
        timeInput.addClass('is-error');
        hint.setText('Unrecognized time');
        hint.addClass('is-error');
        return;
      }
      timeInput.removeClass('is-error');
      this.times[this.activeTab] = parsed;
      timeInput.value = parsed;
      refreshHint();
    };
    timeInput.addEventListener('input', () => { timeInput.removeClass('is-error'); hint.removeClass('is-error'); });
    timeInput.addEventListener('change', commitTime);
    timeInput.addEventListener('blur', commitTime);
    timeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitTime(); }
    });
    this.timeInputs[this.activeTab] = timeInput;

    const clearBtn = timeRow.createEl('button', { text: 'Clear date', cls: 'task-dates-clear' });
    clearBtn.disabled = !selected;
    clearBtn.toggleClass('is-disabled', !selected);
    clearBtn.addEventListener('click', () => {
      this.dates[this.activeTab] = '';
      this.times[this.activeTab] = '';
      this.renderTabContent();
      this.updateTabLabels();
      this.updateValidation();
    });
  }

  onClose(): void { this.contentEl.empty(); }
}

// ── Consolidated task settings pane ───────────────────────────────────────────

type TaskSettingsSection = 'dates' | 'priority' | 'recurrence' | 'effort' | 'followup' | 'labels';

/** Section order used by the navigation rail. */
const SECTION_ORDER: TaskSettingsSection[] = ['dates', 'priority', 'recurrence', 'effort', 'followup', 'labels'];

const SECTION_LABELS: Record<TaskSettingsSection, string> = {
  dates: 'Dates',
  priority: 'Priority',
  recurrence: 'Repeat',
  effort: 'Effort',
  followup: 'Follow-up',
  labels: 'Tags & people',
};

const SECTION_HINTS: Record<TaskSettingsSection, string> = {
  dates: 'Due, scheduled & start',
  priority: 'How important',
  recurrence: 'Repeat rule',
  effort: 'Time estimate',
  followup: 'Check back later',
  labels: 'Tags & assignees',
};

const SECTION_EMOJI: Record<TaskSettingsSection, string> = {
  dates: '📅',
  priority: '🔼',
  recurrence: '🔁',
  effort: '⏱️',
  followup: '👀',
  labels: '🏷️',
};

/** Accept legacy section ids (assignee/tag) and fold them into the merged section. */
function normalizeSection(section: TaskSettingsSection | 'assignee' | 'tag'): TaskSettingsSection {
  if (section === 'assignee' || section === 'tag') return 'labels';
  return section;
}

/** Priority marker → display label + semantic level (used for color coding). */
const PRIORITY_META: Record<string, { label: string; level: string }> = {
  '🔺': { label: 'Highest', level: 'highest' },
  '⏫': { label: 'High', level: 'high' },
  '🔼': { label: 'Medium', level: 'medium' },
  '🔽': { label: 'Low', level: 'low' },
  '⏬': { label: 'Lowest', level: 'lowest' },
};

const TASK_PREFIX_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+\[[^\]]*\]\s+/u;
const TAG_TOKEN_RE = /(?:^|\s)(#[A-Za-z0-9_/\-]+)/gu;
const ASSIGNEE_TOKEN_RE = /(?:^|\s)(@[A-Za-z0-9_/\-]+)/gu;

interface PreviewChip { kind: string; icon: string; text: string; level?: string; }
interface TaskPreview { description: string; chips: PreviewChip[]; }

/** Strip the leading non-letter/digit decoration (emoji + spaces) from a metadata match. */
function stripLeadingIcon(value: string): string {
  return value.replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

function collectTokens(body: string, re: RegExp): string[] {
  const out: string[] = [];
  const r = new RegExp(re.source, re.flags);
  let m: RegExpExecArray | null;
  while ((m = r.exec(body)) !== null) out.push(m[1]);
  return out;
}

/**
 * Parse a task line into a clean description plus a list of metadata chips, so the
 * settings modal can show a live preview of what the line will look like.
 */
function buildTaskPreview(lineText: string): TaskPreview {
  const prefixM = TASK_PREFIX_RE.exec(lineText);
  const body = prefixM ? lineText.slice(prefixM[0].length) : lineText.replace(/^\s+/u, '');
  const chips: PreviewChip[] = [];

  // Priority
  const pm = new RegExp(PRIORITY_RE.source, 'u').exec(body);
  if (pm) {
    const sym = pm[0].trim();
    const meta = PRIORITY_META[sym];
    if (meta) chips.push({ kind: 'priority', icon: sym, text: meta.label, level: meta.level });
  }
  // Dates (due / scheduled / start)
  for (const tab of DATE_TABS) {
    const existing = parseExistingDate(body, tab.stripRe);
    if (existing) chips.push({ kind: tab.id, icon: tab.emoji, text: `${fmtShortDate(existing.iso)}${existing.time ? ` ${formatTime12(existing.time)}` : ''}` });
  }
  // Recurrence
  const rec = stripLeadingIcon(firstMatchText(body, RECURRENCE_RE));
  if (rec) chips.push({ kind: 'recurrence', icon: '🔁', text: rec });
  // Effort
  const eff = stripLeadingIcon(firstMatchText(body, EFFORT_RE));
  if (eff) chips.push({ kind: 'effort', icon: '⏱️', text: eff });
  // Follow-up
  const fuMatch = /(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?/u.exec(firstMatchText(body, FOLLOWUP_RE));
  if (fuMatch) chips.push({ kind: 'followup', icon: '👀', text: `${fmtShortDate(fuMatch[1])}${fuMatch[2] ? ` ${formatTime12(fuMatch[2])}` : ''}` });
  // Tags & assignees
  for (const t of collectTokens(body, TAG_TOKEN_RE)) chips.push({ kind: 'tag', icon: '', text: t });
  for (const p of collectTokens(body, ASSIGNEE_TOKEN_RE)) chips.push({ kind: 'assignee', icon: '👤', text: p });

  // Description = body with all known metadata removed
  let desc = body;
  desc = desc.replace(new RegExp(PRIORITY_RE.source, 'gu'), '');
  for (const tab of DATE_TABS) desc = desc.replace(new RegExp(tab.stripRe.source, 'gu'), '');
  desc = desc.replace(new RegExp(RECURRENCE_RE.source, 'gu'), '');
  desc = desc.replace(new RegExp(EFFORT_RE.source, 'gu'), '');
  desc = desc.replace(new RegExp(FOLLOWUP_RE.source, 'gu'), '');
  desc = desc.replace(/(?:^|\s)#[A-Za-z0-9_/\-]+/gu, ' ');
  desc = desc.replace(/(?:^|\s)👤/gu, ' ');
  desc = desc.replace(/(?:^|\s)@[A-Za-z0-9_/\-]+/gu, ' ');
  desc = desc.replace(/\s+/gu, ' ').trim();

  return { description: desc, chips };
}

const PRIORITY_OPTIONS: ToolbarOption[] = [
  { label: '🔺 Highest', value: '🔺' },
  { label: '⏫ High',    value: '⏫' },
  { label: '🔼 Medium',  value: '🔼' },
  { label: '🔽 Low',     value: '🔽' },
  { label: '⏬ Lowest',  value: '⏬' },
];

const RECURRENCE_OPTIONS: ToolbarOption[] = [
  { label: 'Every day',     value: 'every day' },
  { label: 'Every weekday', value: 'every weekday' },
  { label: 'Every week',    value: 'every week' },
  { label: 'Every 2 weeks', value: 'every 2 weeks' },
  { label: 'Every month',   value: 'every month' },
  { label: 'Every year',    value: 'every year' },
  { label: 'Every day — from completion',     value: 'every day when done' },
  { label: 'Every week — from completion',    value: 'every week when done' },
  { label: 'Every 2 weeks — from completion', value: 'every 2 weeks when done' },
  { label: 'Every month — from completion',   value: 'every month when done' },
  { label: 'Every year — from completion',    value: 'every year when done' },
];

const EFFORT_OPTIONS: ToolbarOption[] = [
  { label: '15 minutes', value: '15m' },
  { label: '30 minutes', value: '30m' },
  { label: '45 minutes', value: '45m' },
  { label: '1 hour',     value: '1h' },
  { label: '1.5 hours',  value: '1h 30m' },
  { label: '2 hours',    value: '2h' },
  { label: '3 hours',    value: '3h' },
  { label: '4 hours',    value: '4h' },
  { label: '6 hours',    value: '6h' },
  { label: '8 hours',    value: '8h' },
];

const PRIORITY_RE = /\s*[🔺⏫🔼🔽⏬]/gu;
const RECURRENCE_RE = /\s*🔁\s+[^🔺⏫🔼🔽⏬📅📆🗓⏳⌛🛫⏱👀👤#\n]+/gu;
const EFFORT_RE = /\s*⏱️?\s+[^🔺⏫🔼🔽⏬📅📆🗓⏳⌛🛫🔁👀👤#\n]+/gu;
const FOLLOWUP_RE = /\s*👀\s*(?:\[\[\d{4}-\d{2}-\d{2}[^\]]*\]\]|\d{4}-\d{2}-\d{2})(?:\s+\d{1,2}:\d{2})?/gu;

function firstMatchText(text: string, re: RegExp): string {
  const match = new RegExp(re.source, 'u').exec(text);
  return match ? match[0].trim() : '';
}

function stripTaskSetting(text: string, re: RegExp): string {
  return text.replace(new RegExp(re.source, 'gu'), '').replace(/\s+$/u, '');
}

class TaskSettingsPaneModal extends Modal {
  private railEl: HTMLElement | null = null;
  private contentPaneEl: HTMLElement | null = null;
  private previewEl: HTMLElement | null = null;
  private headerEl: HTMLElement | null = null;
  /** Locked content-pane height: measured once from the tallest section, clamped to viewport. */
  private lockedContentHeight: number | null = null;
  private activeSection: TaskSettingsSection;
  private pendingLabelFocus: '#' | '@' | null = null;
  private readonly labelInputs: Partial<Record<'#' | '@', HTMLInputElement>> = {};

  constructor(
    app: App,
    private readonly lineFrom: number,
    private readonly view: EditorView,
    private readonly getSettings: () => TaskManagerSettings,
    initialSection: TaskSettingsSection | 'assignee' | 'tag' = 'dates',
  ) {
    super(app);
    this.activeSection = normalizeSection(initialSection);
  }

  onOpen(): void {
    this.modalEl.addClass('task-settings-pane-shell');
    this.modalEl.setAttribute('aria-label', 'Task settings');
    this.render();
  }

  /** Full build: header, navigation rail, active section, and live preview. */
  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('task-settings-pane');

    const header = contentEl.createDiv('task-settings-pane-header');
    this.headerEl = header;
    header.createEl('h3', { text: 'Task settings', cls: 'task-settings-pane-title' });
    header.createDiv({ text: 'Pick a section to edit — changes apply to the task instantly.', cls: 'task-settings-pane-subtitle' });

    const body = contentEl.createDiv('task-settings-pane-body');
    this.railEl = body.createDiv('task-settings-pane-rail');
    this.contentPaneEl = body.createDiv('task-settings-pane-content');
    this.previewEl = contentEl.createDiv('task-settings-preview');

    this.renderRail();
    this.renderActiveSection();
    this.renderPreview();
    this.applyContentSizing();
  }

  /** Re-render the active section, rail indicators, and preview after a value change. */
  private refresh(): void {
    if (this.contentPaneEl) {
      this.contentPaneEl.empty();
      this.renderActiveSection();
    }
    this.renderRail();
    this.renderPreview();
  }

  private renderRail(): void {
    if (!this.railEl) return;
    this.railEl.empty();
    for (const section of SECTION_ORDER) this.renderNavButton(section);
  }

  private renderActiveSection(): void {
    switch (this.activeSection) {
      case 'dates': this.renderDatesSection(); break;
      case 'priority': this.renderChoiceSection('priority', 'Priority', 'Pick how important this task is.', PRIORITY_OPTIONS, PRIORITY_RE, (value) => ` ${value}`, (line) => firstMatchText(line, PRIORITY_RE)); break;
      case 'recurrence': this.renderChoiceSection('recurrence', 'Repeat', 'Choose how this task repeats.', RECURRENCE_OPTIONS, RECURRENCE_RE, (value) => ` 🔁 ${value}`, (line) => stripLeadingIcon(firstMatchText(line, RECURRENCE_RE))); break;
      case 'effort': this.renderChoiceSection('effort', 'Effort', 'Estimate how long this task will take.', EFFORT_OPTIONS, EFFORT_RE, (value) => ` ⏱️ ${value}`, (line) => stripLeadingIcon(firstMatchText(line, EFFORT_RE))); break;
      case 'followup': this.renderFollowupSection(); break;
      case 'labels': this.renderLabelsSection(); break;
    }
  }

  private currentLineText(): string {
    return this.view.state.doc.lineAt(this.lineFrom).text;
  }

  private replaceCurrentLine(text: string): void {
    const state = this.view.state;
    const line = state.doc.lineAt(this.lineFrom);
    viewDispatch(this.view, line.from, line.to, text);
  }

  private appendToLine(insert: string): void {
    const state = this.view.state;
    const line = state.doc.lineAt(this.lineFrom);
    this.view.dispatch(state.update({
      changes: { from: line.to, to: line.to, insert },
      selection: { anchor: line.to + insert.length },
    }));
  }

  /** True when the given section already has a value on the line (drives the rail dot). */
  private sectionHasValue(section: TaskSettingsSection): boolean {
    const t = this.currentLineText();
    switch (section) {
      case 'dates': return DATE_TABS.some((tab) => !!parseExistingDate(t, tab.stripRe));
      case 'priority': return !!firstMatchText(t, PRIORITY_RE);
      case 'recurrence': return !!firstMatchText(t, RECURRENCE_RE);
      case 'effort': return !!firstMatchText(t, EFFORT_RE);
      case 'followup': return !!firstMatchText(t, FOLLOWUP_RE);
      case 'labels': {
        const prefixM = TASK_PREFIX_RE.exec(t);
        const body = prefixM ? t.slice(prefixM[0].length) : t;
        return collectTokens(body, TAG_TOKEN_RE).length > 0 || collectTokens(body, ASSIGNEE_TOKEN_RE).length > 0;
      }
    }
  }

  private renderNavButton(section: TaskSettingsSection): void {
    if (!this.railEl) return;
    const isActive = this.activeSection === section;
    const btn = this.railEl.createEl('button', { cls: `task-settings-rail-btn${isActive ? ' is-active' : ''}` });
    btn.createSpan({ text: SECTION_EMOJI[section], cls: 'task-settings-rail-icon' });
    const text = btn.createDiv('task-settings-rail-text');
    text.createSpan({ text: SECTION_LABELS[section], cls: 'task-settings-rail-label' });
    text.createSpan({ text: SECTION_HINTS[section], cls: 'task-settings-rail-hint' });
    if (this.sectionHasValue(section)) {
      const dot = btn.createSpan({ cls: 'task-settings-rail-dot' });
      dot.setAttr('aria-label', 'Has a value');
    }
    btn.setAttr('aria-pressed', isActive ? 'true' : 'false');
    btn.addEventListener('click', () => this.focusSection(section));
  }

  private createSection(section: TaskSettingsSection, title: string, description: string): HTMLElement {
    const host = this.contentPaneEl ?? this.contentEl;
    const container = host.createDiv('task-settings-section');
    container.dataset.section = section;
    const header = container.createDiv('task-settings-section-header');
    header.createDiv({ text: SECTION_EMOJI[section], cls: 'task-settings-section-icon' });
    const copy = header.createDiv('task-settings-section-copy');
    copy.createEl('h4', { text: title, cls: 'task-settings-section-title' });
    copy.createDiv({ text: description, cls: 'task-settings-section-desc' });
    return container;
  }

  private renderCurrent(container: HTMLElement, label: string, value: string): void {
    const current = container.createDiv('task-settings-current');
    current.createSpan({ text: label, cls: 'task-settings-current-label' });
    current.createSpan({ text: value || 'Not set', cls: value ? 'task-settings-current-value' : 'task-settings-current-value is-empty' });
  }

  private renderDatesSection(): void {
    const section = this.createSection('dates', 'Dates & times', 'Open the scheduler to set due, scheduled, and start dates. Existing values are pre-filled.');
    const line = this.currentLineText();
    const hasAny = DATE_TABS.some((tab) => !!parseExistingDate(line, tab.stripRe));
    const current = section.createDiv('task-settings-date-grid');
    for (const tab of DATE_TABS) {
      const existing = parseExistingDate(line, tab.stripRe);
      const chip = current.createDiv(`task-settings-date-chip${existing ? ' is-set' : ''}`);
      chip.createSpan({ text: `${tab.emoji} ${tab.label}`, cls: 'task-settings-date-chip-label' });
      chip.createSpan({ text: existing ? `${fmtShortDate(existing.iso)}${existing.time ? ` · ${formatTime12(existing.time)}` : ''}` : 'Not set', cls: existing ? 'task-settings-date-chip-value' : 'task-settings-date-chip-value is-empty' });
    }
    const actions = section.createDiv('task-settings-actions');
    const editBtn = actions.createEl('button', { text: 'Open scheduler', cls: 'task-settings-primary-btn' });
    editBtn.addEventListener('click', () => this.openDateEditor());
    if (hasAny) {
      const clearBtn = actions.createEl('button', { text: 'Clear dates', cls: 'task-settings-secondary-btn' });
      clearBtn.addEventListener('click', () => {
        let text = this.currentLineText();
        for (const tab of DATE_TABS) text = text.replace(new RegExp(tab.stripRe.source, 'gu'), '');
        this.replaceCurrentLine(text.replace(/\s+$/u, ''));
        this.refresh();
      });
    }
  }

  private openDateEditor(): void {
    const modal = new DateTabsModal(this.app, this.currentLineText(), (changes) => {
      const settings = this.getSettings();
      let text = this.currentLineText();
      for (const tab of DATE_TABS) text = text.replace(new RegExp(tab.stripRe.source, 'gu'), '');
      text = text.replace(/\s+$/u, '');
      let additions = '';
      for (const tab of DATE_TABS) {
        const c = changes[tab.id];
        if (c) additions += tab.buildToken(c.iso, c.time, settings);
      }
      this.replaceCurrentLine(text + additions);
      this.refresh();
    });
    modal.open();
  }

  private renderChoiceSection(
    sectionId: TaskSettingsSection,
    title: string,
    description: string,
    options: ToolbarOption[],
    re: RegExp,
    buildInsert: (value: string) => string,
    valueOf: (line: string) => string,
  ): void {
    const section = this.createSection(sectionId, title, description);
    const current = valueOf(this.currentLineText());
    if (current) {
      let display = current;
      if (sectionId === 'priority' && PRIORITY_META[current]) display = `${current} ${PRIORITY_META[current].label}`;
      this.renderCurrent(section, 'Selected', display);
    }
    const grid = section.createDiv('task-settings-option-grid');
    for (const option of options) {
      const isSelected = current === option.value;
      const btn = grid.createEl('button', { text: option.label, cls: `task-settings-option-btn${isSelected ? ' is-selected' : ''}` });
      if (sectionId === 'priority') btn.dataset.level = PRIORITY_META[option.value]?.level ?? '';
      btn.setAttr('aria-pressed', isSelected ? 'true' : 'false');
      btn.addEventListener('click', () => {
        const stripped = stripTaskSetting(this.currentLineText(), re);
        this.replaceCurrentLine(isSelected ? stripped : stripped + buildInsert(option.value));
        this.refresh();
      });
    }
    if (current) {
      const clearBtn = section.createEl('button', { text: `Clear ${title.toLowerCase()}`, cls: 'task-settings-link-btn' });
      clearBtn.addEventListener('click', () => {
        this.replaceCurrentLine(stripTaskSetting(this.currentLineText(), re));
        this.refresh();
      });
    }
  }

  private renderFollowupSection(): void {
    const section = this.createSection('followup', 'Follow-up', 'Set a date to revisit this task.');
    const current = firstMatchText(this.currentLineText(), FOLLOWUP_RE);
    if (current) this.renderCurrent(section, 'Selected', stripLeadingIcon(current));
    const actions = section.createDiv('task-settings-actions');
    const setBtn = actions.createEl('button', { text: current ? 'Change follow-up date' : 'Set follow-up date', cls: 'task-settings-primary-btn' });
    setBtn.addEventListener('click', () => {
      const modal = new DatePickerModal(this.app, 'Follow-up date', (iso) => {
        const settings = this.getSettings();
        const stripped = stripTaskSetting(this.currentLineText(), FOLLOWUP_RE);
        this.replaceCurrentLine(`${stripped} 👀 ${fmtDate(iso, settings)}`);
        this.refresh();
      });
      modal.open();
    });
    if (current) {
      const clearBtn = actions.createEl('button', { text: 'Clear follow-up', cls: 'task-settings-secondary-btn' });
      clearBtn.addEventListener('click', () => {
        this.replaceCurrentLine(stripTaskSetting(this.currentLineText(), FOLLOWUP_RE));
        this.refresh();
      });
    }
  }

  private renderLabelsSection(): void {
    const section = this.createSection('labels', 'Tags & people', 'Add hashtags and @mentions to the end of the task.');
    const preview = buildTaskPreview(this.currentLineText());
    this.labelInputs['#'] = undefined;
    this.labelInputs['@'] = undefined;
    this.renderTokenGroup(section, 'Tags', 'tag', '#', '#tag', 'Add tag', preview.chips.filter((c) => c.kind === 'tag'));
    this.renderTokenGroup(section, 'People', 'assignee', '@', '@person', 'Add person', preview.chips.filter((c) => c.kind === 'assignee'));
    if (this.pendingLabelFocus) {
      const input = this.labelInputs[this.pendingLabelFocus];
      this.pendingLabelFocus = null;
      if (input) window.setTimeout(() => input.focus(), 0);
    }
  }

  private renderTokenGroup(
    section: HTMLElement,
    heading: string,
    kind: 'tag' | 'assignee',
    prefix: '#' | '@',
    placeholder: string,
    buttonText: string,
    chips: PreviewChip[],
  ): void {
    const group = section.createDiv('task-settings-token-group');
    group.createDiv({ text: heading, cls: 'task-settings-token-heading' });
    if (chips.length) {
      const list = group.createDiv('task-settings-token-chips');
      for (const chip of chips) {
        const el = list.createSpan({ cls: 'task-settings-token-chip' });
        el.dataset.kind = kind;
        el.createSpan({ text: chip.text, cls: 'task-settings-token-chip-text' });
        const remove = el.createSpan({ text: '×', cls: 'task-settings-token-chip-remove' });
        remove.setAttr('aria-label', `Remove ${chip.text}`);
        remove.setAttr('role', 'button');
        remove.addEventListener('click', () => this.removeLabel(chip.text));
      }
    } else {
      group.createDiv({ text: kind === 'tag' ? 'No tags yet.' : 'No one assigned yet.', cls: 'task-settings-token-empty' });
    }
    const row = group.createDiv('task-settings-token-row');
    const input = row.createEl('input', { cls: 'task-settings-token-input' });
    input.type = 'text';
    input.placeholder = placeholder;
    input.setAttr('aria-label', `${heading} to add`);
    this.labelInputs[prefix] = input;
    const btn = row.createEl('button', { text: buttonText, cls: 'task-settings-secondary-btn' });
    const addToken = () => {
      const raw = input.value.trim();
      if (!raw) return;
      const firstToken = raw.split(/\s+/u)[0];
      const token = firstToken.startsWith(prefix) ? firstToken : `${prefix}${firstToken}`;
      this.appendToLine(` ${token}`);
      this.pendingLabelFocus = prefix;
      this.refresh();
    };
    btn.addEventListener('click', addToken);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addToken();
      }
    });
  }

  private removeLabel(token: string): void {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const re = new RegExp(`\\s?${escaped}(?![A-Za-z0-9_/\\-])`, 'u');
    const next = this.currentLineText().replace(re, '').replace(/\s+$/u, '');
    this.replaceCurrentLine(next);
    this.refresh();
  }

  private renderPreview(): void {
    if (!this.previewEl) return;
    this.previewEl.empty();
    const model = buildTaskPreview(this.currentLineText());
    this.previewEl.createSpan({ text: 'Preview', cls: 'task-settings-preview-label' });
    const line = this.previewEl.createDiv('task-settings-preview-line');
    line.createSpan({ text: '\u2610', cls: 'task-settings-preview-check' });
    line.createSpan({
      text: model.description || 'Untitled task',
      cls: model.description ? 'task-settings-preview-desc' : 'task-settings-preview-desc is-empty',
    });
    if (model.chips.length) {
      const chips = line.createDiv('task-settings-preview-chips');
      for (const chip of model.chips) {
        const el = chips.createSpan({ cls: 'task-settings-preview-chip' });
        el.dataset.kind = chip.kind;
        if (chip.level) el.dataset.level = chip.level;
        if (chip.icon) el.createSpan({ text: chip.icon, cls: 'task-settings-preview-chip-icon' });
        el.createSpan({ text: chip.text, cls: 'task-settings-preview-chip-text' });
      }
    }
  }

  /**
   * Lock the content pane to a single height so navigating between sections never
   * resizes the modal. The height is measured once (tallest section) and clamped to
   * the space the viewport actually allows; the cached value is re-applied on every
   * subsequent full render.
   */
  private applyContentSizing(): void {
    const pane = this.contentPaneEl;
    if (!pane) return;
    if (this.lockedContentHeight == null) this.lockedContentHeight = this.computeLockedHeight();
    if (this.lockedContentHeight != null) {
      pane.style.height = `${this.lockedContentHeight}px`;
      pane.style.overflowY = 'auto';
    }
  }

  /** Measure every section offscreen, take the tallest, and clamp to available space. */
  private computeLockedHeight(): number | null {
    const pane = this.contentPaneEl;
    if (!pane) return null;
    const width = pane.clientWidth || pane.getBoundingClientRect().width;
    if (!width) return null;

    // Render each section into an offscreen clone that mirrors the real pane width.
    const measurer = (pane.parentElement ?? pane).createDiv('task-settings-pane-content');
    measurer.style.position = 'absolute';
    measurer.style.left = '-99999px';
    measurer.style.top = '0';
    measurer.style.width = `${width}px`;
    measurer.style.height = 'auto';
    measurer.style.visibility = 'hidden';
    measurer.style.pointerEvents = 'none';

    const realPane = this.contentPaneEl;
    const realActive = this.activeSection;
    this.contentPaneEl = measurer;
    let tallest = 0;
    for (const section of SECTION_ORDER) {
      measurer.empty();
      this.activeSection = section;
      this.renderActiveSection();
      tallest = Math.max(tallest, measurer.scrollHeight);
    }
    this.contentPaneEl = realPane;
    this.activeSection = realActive;
    measurer.remove();

    // Clamp to the height the modal can show without overflowing the viewport.
    const cap = Math.min(window.innerHeight * 0.84, 860);
    const headerH = this.headerEl ? this.headerEl.offsetHeight + 16 : 0; // + margin-bottom
    const previewH = this.previewEl ? this.previewEl.offsetHeight + 16 : 0; // + margin-top
    const contentPadding = 42; // modal-content vertical padding
    const available = cap - headerH - previewH - contentPadding - 8;
    const railH = this.railEl ? this.railEl.offsetHeight : 0;
    // At least as tall as the rail (keeps the body stable), never taller than available.
    const floor = Math.min(railH, available);
    const target = Math.min(Math.max(tallest, floor), available);
    return Math.max(Math.round(target), 160);
  }

  private focusSection(section: TaskSettingsSection): void {
    this.activeSection = section;
    this.render();
  }

  onClose(): void { this.contentEl.empty(); }
}

function viewDispatch(view: EditorView, from: number, to: number, text: string): void {
  view.dispatch(view.state.update({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
  }));
  view.focus();
}

// ── Toolbar item definitions ──────────────────────────────────────────────────

interface ToolbarOption { label: string; value: string; }

interface ToolbarItem {
  id: string;
  emoji: string;
  label: string;
  detect(lineText: string): boolean;
  /** If present, called on click instead of building a menu. */
  openPicker?(app: App, lineFrom: number, view: EditorView, getSettings: () => TaskManagerSettings): void;
  /** Return menu options. Empty array = direct insert. */
  getOptions(settings: TaskManagerSettings): ToolbarOption[];
  buildInsert(optionValue: string, settings: TaskManagerSettings): string;
  /** If true, a separator is added after getOptions() and getOptions2() items follow. */
  hasSections?: boolean;
  /** Second set of options shown after separator (e.g. recurrence "when done" variants). */
  getOptions2?(): ToolbarOption[];
}

function makeDatePicker(
  id: string, emoji: string, label: string,
  detect: (t: string) => boolean,
  prefix: string,
): ToolbarItem {
  return {
    id, emoji, label, detect,
    openPicker(app, lineFrom, view, getSettings) {
      const modal = new DatePickerModal(app, label, (iso) => {
        const s = getSettings();
        const text = ` ${prefix} ${fmtDate(iso, s)}`;
        const state = view.state;
        const line = state.doc.lineAt(lineFrom);
        view.dispatch(state.update({
          changes: { from: line.to, to: line.to, insert: text },
          selection: { anchor: line.to + text.length },
        }));
        view.focus();
      });
      modal.open();
    },
    getOptions: () => [],
    buildInsert: (v, s) => ` ${prefix} ${fmtDate(v, s)}`,
  };
}

const ITEMS: ToolbarItem[] = [
  {
    id: 'dates', emoji: '📅', label: 'Add/edit dates & times',
    // Always keep the date picker available: it opens pre-populated and replaces
    // existing due/scheduled/start values, so it doubles as the edit affordance.
    detect: () => false,
    openPicker(app, lineFrom, view, getSettings) {
      const lineText = view.state.doc.lineAt(lineFrom).text;
      const modal = new DateTabsModal(app, lineText, (changes) => {
        const settings = getSettings();
        const currentState = view.state;
        const line = currentState.doc.lineAt(lineFrom);
        let text = line.text;
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
        view.dispatch(currentState.update({
          changes: { from: line.from, to: line.to, insert: newText },
          selection: { anchor: line.from + newText.length },
        }));
        view.focus();
      });
      modal.open();
    },
    getOptions: () => [],
    buildInsert: () => '',
  },
  {
    id: 'priority', emoji: '🔼', label: 'Priority',
    detect: (t) => /🔺|⏫|🔼|🔽|⏬/.test(t),
    getOptions: () => [
      { label: '🔺 Highest', value: '🔺' },
      { label: '⏫ High',    value: '⏫' },
      { label: '🔼 Medium',  value: '🔼' },
      { label: '🔽 Low',     value: '🔽' },
      { label: '⏬ Lowest',  value: '⏬' },
    ],
    buildInsert: (v) => ` ${v}`,
  },
  {
    id: 'recurrence', emoji: '🔁', label: 'Repeat',
    detect: (t) => /🔁/.test(t),
    hasSections: true,
    getOptions: () => [
      { label: 'Every day',     value: 'every day' },
      { label: 'Every weekday', value: 'every weekday' },
      { label: 'Every week',    value: 'every week' },
      { label: 'Every 2 weeks', value: 'every 2 weeks' },
      { label: 'Every month',   value: 'every month' },
      { label: 'Every year',    value: 'every year' },
    ],
    getOptions2: () => [
      { label: 'Every day — from completion',     value: 'every day when done' },
      { label: 'Every week — from completion',    value: 'every week when done' },
      { label: 'Every 2 weeks — from completion', value: 'every 2 weeks when done' },
      { label: 'Every month — from completion',   value: 'every month when done' },
      { label: 'Every year — from completion',    value: 'every year when done' },
    ],
    buildInsert: (v) => ` 🔁 ${v}`,
  },
  {
    id: 'effort', emoji: '⏱️', label: 'Effort',
    detect: (t) => /⏱/.test(t),
    getOptions: () => [
      { label: '15 minutes', value: '15m' },
      { label: '30 minutes', value: '30m' },
      { label: '45 minutes', value: '45m' },
      { label: '1 hour',     value: '1h' },
      { label: '1.5 hours',  value: '1h 30m' },
      { label: '2 hours',    value: '2h' },
      { label: '3 hours',    value: '3h' },
      { label: '4 hours',    value: '4h' },
      { label: '6 hours',    value: '6h' },
      { label: '8 hours',    value: '8h' },
    ],
    buildInsert: (v) => ` ⏱️ ${v}`,
  },
  makeDatePicker('followup', '👀', 'Follow-up date', (t) => /👀/.test(t), '👀'),
  {
    id: 'assignee', emoji: '👤', label: 'Assignee',
    detect: (t) => /👤/.test(t),
    getOptions: () => [],
    buildInsert: () => ' 👤 @',
  },
  {
    id: 'tag', emoji: '#', label: 'Tag',
    detect: (t) => {
      const m = t.match(/^(?:\s*)(?:[-*+]|\d+[.)])\s+\[[^\]]*\]\s+(.*)/s);
      return m ? /#\w/.test(m[1]) : false;
    },
    getOptions: () => [],
    buildInsert: () => ' #',
  },
];

// ── Widget ────────────────────────────────────────────────────────────────────

class TaskToolbarWidget extends WidgetType {
  constructor(
    private readonly lineText: string,
    private readonly lineFrom: number,
    private readonly app: App,
    private readonly getSettings: () => TaskManagerSettings,
  ) { super(); }

  eq(other: WidgetType): boolean {
    return other instanceof TaskToolbarWidget
      && other.lineFrom === this.lineFrom
      && other.lineText === this.lineText;
  }

  toDOM(view: EditorView): HTMLElement {
    const quickLinks = ITEMS.filter((item) => !item.detect(this.lineText) && item.id !== 'tag' && item.id !== 'assignee');

    const wrapper = document.createElement('span');
    wrapper.className = 'task-line-toolbar';
    wrapper.setAttribute('contenteditable', 'false');

    const openSettings = (section: TaskSettingsSection) => {
      new TaskSettingsPaneModal(this.app, this.lineFrom, view, this.getSettings, section).open();
    };

    for (const item of quickLinks) {
      const section = item.id as TaskSettingsSection;
      const btn = document.createElement('span');
      btn.className = 'task-line-toolbar-btn';
      btn.textContent = item.emoji;
      btn.setAttribute('title', `${item.label} settings`);
      btn.setAttribute('aria-label', `${item.label} settings`);

      btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Dates keep the original full scheduler as the quick action; the
        // ellipsis settings pane still has a Dates section with the same entry.
        if (section === 'dates' && item.openPicker) {
          item.openPicker(this.app, this.lineFrom, view, this.getSettings);
          return;
        }
        openSettings(section);
      });

      wrapper.appendChild(btn);
    }

    const settingsBtn = document.createElement('span');
    settingsBtn.className = 'task-line-toolbar-btn task-line-toolbar-settings-btn';
    settingsBtn.textContent = '…';
    settingsBtn.setAttribute('title', 'Task settings');
    settingsBtn.setAttribute('aria-label', 'Task settings');
    settingsBtn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    settingsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openSettings('dates');
    });
    wrapper.appendChild(settingsBtn);

    return wrapper;
  }

  private insertAtLineEnd(view: EditorView, text: string): void {
    const state = view.state;
    const line = state.doc.lineAt(this.lineFrom);
    view.dispatch(state.update({
      changes: { from: line.to, to: line.to, insert: text },
      selection: { anchor: line.to + text.length },
    }));
    view.focus();
  }

  ignoreEvent(): boolean { return false; }
  get estimatedHeight(): number { return -1; }
  get lineBreaks(): number { return 0; }
}

// ── ViewPlugin ────────────────────────────────────────────────────────────────

const TASK_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([^\]\r\n]*)\]\s+/u;

export function taskLineToolbarCheckbox(lineText: string): string | null {
  const checkbox = TASK_RE.exec(lineText)?.[2];
  if (checkbox === undefined) return null;
  // Avoid treating ordinary Markdown links/list items as tasks, e.g.
  // `- [[01 Demo Tasks]]` or `- [plain bracket link] ...`. Task checkbox
  // markers are intentionally compact: empty/space or a short non-space marker.
  if (checkbox !== ' ' && (/\s/u.test(checkbox) || checkbox.length > 2)) return null;
  return checkbox;
}

export function isTaskLineToolbarEligible(lineText: string): boolean {
  const checkbox = taskLineToolbarCheckbox(lineText);
  return checkbox !== null && !/^[xX]$/u.test(checkbox.trim());
}

export function createTaskLineToolbarExtension(
  app: App,
  getSettings: () => TaskManagerSettings,
): Extension {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      decorations: DecorationSet;

      constructor(view: EditorView) { this.decorations = this.build(view); }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = this.build(update.view);
        }
      }

      destroy(): void { /* nothing to tear down */ }

      build(view: EditorView): DecorationSet {
        if (!getSettings().taskLineToolbarEnabled) return Decoration.none;
        const ranges: Array<{ pos: number; deco: Decoration }> = [];
        for (const { from, to } of view.visibleRanges) {
          let pos = from;
          while (pos <= to) {
            const line = view.state.doc.lineAt(pos);
            if (isTaskLineToolbarEligible(line.text)) {
              ranges.push({
                pos: line.to,
                deco: Decoration.widget({
                  widget: new TaskToolbarWidget(line.text, line.from, app, getSettings),
                  side: 1,
                }),
              });
            }
            if (line.to >= to) break;
            pos = line.to + 1;
          }
        }
        return Decoration.set(ranges.map((r) => r.deco.range(r.pos)), true);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
