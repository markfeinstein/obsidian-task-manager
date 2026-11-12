import type { App, PluginManifest } from 'obsidian';
import type { TaskManagerSettings } from './types';

export interface SettingsHost {
  readonly app: App;
  readonly manifest: PluginManifest;
  settings: TaskManagerSettings;
  saveSettings(): Promise<void>;
  refreshWatchers(): void;
  refreshTaskConfiguration(rebaselineSnapshot?: boolean): Promise<void>;
  requestSystemNotificationPermission(): Promise<void>;
  openGoogleCalendarQuickCaptureModal(): void;
  openGoogleCalendarSetupWizard(): void;
  showExperimentalSyncConfirmation(serviceName: string, onConfirm: () => Promise<void>, onCancel?: () => void): void;
  showSyncTestConnection(serviceName: string, testFn: () => Promise<{ success: boolean; message: string }>): void;
  testTodoistConnection(): Promise<{ success: boolean; message: string }>;
  testGoogleTasksConnection(): Promise<{ success: boolean; message: string }>;
  testGoogleCalendarConnection(): Promise<{ success: boolean; message: string }>;
  testMicrosoftTodoConnection(): Promise<{ success: boolean; message: string }>;
  testCalDAVConnection(): Promise<{ success: boolean; message: string }>;
}
