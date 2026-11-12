import { t } from './i18n';

function settingsSlug(value: string): string {
  return value.normalize('NFKD').replace(/[^a-zA-Z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').toLowerCase() || 'setting';
}

export function renderSettingsSearch(
  container: HTMLElement,
  options: { value: string; inputId: string; onChange(value: string): void; onClear(): void },
): void {
  const row = container.createDiv({ cls: 'task-manager-settings-search' });
  const label = row.createEl('label', { text: t('settings.searchLabel') });
  const input = row.createEl('input', { type: 'search', cls: 'task-manager-settings-search-input' });
  input.setAttr('placeholder', t('settings.searchPlaceholder'));
  input.setAttr('aria-label', t('settings.searchLabel'));
  input.value = options.value;
  input.id = options.inputId;
  label.htmlFor = input.id;
  input.addEventListener('input', () => {
    const selection = input.selectionStart ?? input.value.length;
    options.onChange(input.value);
    window.setTimeout(() => {
      const next = document.getElementById(options.inputId) as HTMLInputElement | null;
      next?.focus();
      next?.setSelectionRange(selection, selection);
    }, 0);
  });
  if (options.value) {
    const clear = row.createEl('button', { text: t('ui.clearGlyph') });
    clear.setAttr('type', 'button');
    clear.setAttr('aria-label', t('settings.searchClear'));
    clear.addEventListener('click', () => options.onClear());
  }
}

export function indexAndFilterSettings(root: HTMLElement, rawQuery: string, requestedAnchor: string): void {
  const query = rawQuery.trim().toLocaleLowerCase();
  const ids = new Map<string, number>();
  const headingMatches = new Map<HTMLElement, number>();
  let heading: HTMLElement | null = null;
  let matches = 0;
  for (const element of Array.from(root.querySelectorAll<HTMLElement>('h3, h4, .setting-item'))) {
    if (element.matches('h3, h4')) { heading = element; if (query) element.hidden = true; continue; }
    const name = element.querySelector<HTMLElement>('.setting-item-name')?.textContent?.trim() ?? '';
    if (!name) { if (query) element.hidden = true; continue; }
    const section = heading?.textContent?.trim() || 'settings';
    const base = `task-manager-setting-${settingsSlug(section)}-${settingsSlug(name)}`;
    const count = (ids.get(base) ?? 0) + 1;
    ids.set(base, count);
    element.id = count === 1 ? base : `${base}-${count}`;
    element.dataset.settingsSection = section;
    const matched = !query || `${section} ${element.textContent ?? ''}`.toLocaleLowerCase().includes(query);
    element.hidden = !matched;
    if (matched) { matches += 1; if (heading) headingMatches.set(heading, (headingMatches.get(heading) ?? 0) + 1); }
  }
  for (const [sectionHeading, count] of headingMatches) sectionHeading.hidden = count === 0;
  if (query) {
    const status = root.createDiv({ cls: 'task-manager-settings-search-status', text: t(matches === 1 ? 'settings.searchCountSingular' : 'settings.searchCountPlural', { count: matches }) });
    status.setAttr('role', 'status');
    status.setAttr('aria-live', 'polite');
    root.prepend(status);
  }
  if (!requestedAnchor) return;
  const target = /^[A-Za-z0-9_-]+$/u.test(requestedAnchor) ? root.querySelector<HTMLElement>(`#${requestedAnchor}`) : null;
  if (!target) return;
  target.hidden = false;
  target.tabIndex = -1;
  window.setTimeout(() => { target.scrollIntoView?.({ block: 'center' }); target.focus(); }, 0);
}
