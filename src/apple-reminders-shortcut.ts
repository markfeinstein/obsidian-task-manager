export const DEFAULT_APPLE_REMINDERS_SHORTCUT_NAME = 'Export Reminders to Obsidian';

/** Build the local Shortcuts launch URI without allowing query-parameter injection. */
export function buildAppleRemindersShortcutUrl(shortcutName: string, listName = ''): string {
  const normalizedName = shortcutName.trim() || DEFAULT_APPLE_REMINDERS_SHORTCUT_NAME;
  const input = listName.trim();
  return `shortcuts://run-shortcut?name=${encodeURIComponent(normalizedName)}${input ? `&input=${encodeURIComponent(input)}` : ''}`;
}
