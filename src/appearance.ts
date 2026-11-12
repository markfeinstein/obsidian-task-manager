import type { TaskManagerSettings } from './types';

export type AppearanceSubset = Pick<
  TaskManagerSettings,
  'taskFontSize' | 'taskDensity' | 'priorityColorOverrides' | 'statusColorOverrides' | 'showPriorityPills' | 'showStatusIcons'
>;

const VALID_HEX_COLOR = /^#[0-9a-fA-F]{6}$/u;

const FONT_SIZE_VALUES: Record<AppearanceSubset['taskFontSize'], string> = {
  small: '0.9em',
  normal: '1em',
  large: '1.1em',
};

const DENSITY_VALUES: Record<AppearanceSubset['taskDensity'], { padding: string; lineHeight: string }> = {
  compact: { padding: '2px', lineHeight: '1.2' },
  comfortable: { padding: '4px', lineHeight: '1.35' },
  spacious: { padding: '8px', lineHeight: '1.6' },
};

const KNOWN_PRIORITIES = ['highest', 'high', 'medium', 'normal', 'low', 'lowest'];

function cssEscapeValue(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, '-');
}

/**
 * Returns '#ffffff' or '#000000' — whichever has sufficient WCAG contrast against
 * the given hex background color.  Used so that custom priority-pill text remains
 * legible when the user overrides the background with a single hex color.
 *
 * Formula: relative luminance per WCAG 2.1 (IEC 61966-2-1).
 */
export function contrastingTextColor(hex: string): '#ffffff' | '#000000' {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.179 ? '#000000' : '#ffffff';
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && VALID_HEX_COLOR.test(value.trim());
}

export function normalizeColorOverrides(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.trim() || !isHexColor(value)) continue;
    result[key.trim()] = value.trim();
  }
  return result;
}

export function buildAppearanceCss(settings: AppearanceSubset): string {
  const density = DENSITY_VALUES[settings.taskDensity] ?? DENSITY_VALUES.comfortable;
  const lines: string[] = [':root {'];
  lines.push(`  --task-manager-task-font-size: ${FONT_SIZE_VALUES[settings.taskFontSize] ?? FONT_SIZE_VALUES.normal};`);
  lines.push(`  --task-manager-query-padding-block: ${density.padding};`);
  lines.push(`  --task-manager-query-line-height: ${density.lineHeight};`);
  for (const priority of KNOWN_PRIORITIES) {
    const rawColor = settings.priorityColorOverrides?.[priority];
    if (isHexColor(rawColor)) {
      const color = rawColor.trim();
      const safe = cssEscapeValue(priority);
      const textColor = contrastingTextColor(color);
      lines.push(`  --task-priority-${safe}: ${color};`);
      lines.push(`  --task-priority-${safe}-bg: ${color};`);
      lines.push(`  --task-priority-${safe}-border: ${color};`);
      lines.push(`  --task-priority-${safe}-text: ${textColor};`);
    }
  }
  for (const [status, rawColor] of Object.entries(settings.statusColorOverrides ?? {})) {
    if (!isHexColor(rawColor)) continue;
    const color = rawColor.trim();
    lines.push(`  --task-status-${cssEscapeValue(status)}: ${color};`);
  }
  lines.push('}');
  if (!settings.showPriorityPills) {
    lines.push('.task-manager-query .task-manager-priority-pill { background: transparent !important; border-color: transparent !important; padding: 0 !important; }');
  }
  if (!settings.showStatusIcons) {
    lines.push('.task-manager-query .task-status-icon, .task-manager-query-marker-icon { display: none !important; }');
  }
  return lines.join('\n');
}

export function applyAppearanceSettingsToDocument(settings: AppearanceSubset, doc: Document = document): HTMLStyleElement {
  const existing = doc.getElementById('task-manager-appearance') as HTMLStyleElement | null;
  const style = existing ?? doc.createElement('style');
  style.id = 'task-manager-appearance';
  style.textContent = buildAppearanceCss(settings);
  if (!existing) doc.head.appendChild(style);

  const root = doc.documentElement;
  if (root) {
    root.classList.remove('task-manager-density-compact', 'task-manager-density-comfortable', 'task-manager-density-spacious');
    root.classList.add(taskDensityClass(settings.taskDensity));
  }
  for (const container of Array.from(doc.querySelectorAll<HTMLElement>('.task-manager-query'))) {
    container.classList.remove('task-manager-density-compact', 'task-manager-density-comfortable', 'task-manager-density-spacious');
    container.classList.add(taskDensityClass(settings.taskDensity));
  }
  return style;
}

export function taskDensityClass(density: AppearanceSubset['taskDensity']): string {
  if (density === 'compact') return 'task-manager-density-compact';
  if (density === 'spacious') return 'task-manager-density-spacious';
  return 'task-manager-density-comfortable';
}
