import { getLocaleMetadata, subscribeLocaleChange } from './i18n';

export const TASK_MANAGER_LOCALE_ATTRIBUTE = 'data-task-manager-locale';

/**
 * Apply the active Task Manager locale to one plugin-owned root.
 * The host document root is deliberately never read or mutated.
 */
export function applyLocaleScope(root: HTMLElement): () => void {
  const update = (): void => {
    const locale = getLocaleMetadata();
    root.setAttribute('lang', locale.tag);
    root.setAttribute('dir', locale.direction);
    root.setAttribute(TASK_MANAGER_LOCALE_ATTRIBUTE, locale.tag);
  };
  update();
  return subscribeLocaleChange(update);
}
