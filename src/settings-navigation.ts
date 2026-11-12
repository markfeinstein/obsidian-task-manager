export type TaskManagerSettingsTabId = 'general' | 'query' | 'views' | 'sync' | 'automation' | 'advanced';

let requestedTab: TaskManagerSettingsTabId | null = null;

export function requestTaskManagerSettingsTab(tab: TaskManagerSettingsTabId): void {
  requestedTab = tab;
}

export function consumeTaskManagerSettingsTabRequest(): TaskManagerSettingsTabId | null {
  const requested = requestedTab;
  requestedTab = null;
  return requested;
}
