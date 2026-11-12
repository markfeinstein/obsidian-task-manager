/**
 * Reminder Manager — Coordinates the lifecycle of reminders
 * 
 * Features:
 * - Snooze: Reschedule reminders with preset durations (5min, 15min, 1hr, tomorrow)
 * - Quiet Hours: Suppress and queue notifications during configured hours
 * - Missed Reminders: Track reminders that fired while app was closed
 * - Notification Actions: Done, Snooze, Open actions on notifications
 */

import type { TaskManagerSettings } from './types';
import type { StateStore, PersistedState } from './state-store';

export interface ReminderManagerConfig {
  stateStore: StateStore;
  settings: TaskManagerSettings;
}

export interface SnoozeModalOptions {
  taskFilePath: string;
  taskLineNumber: number;
  taskText: string;
  reminderKey: string;
  originalReminderTime: string;
  onSnooze: (minutes: number) => void;
  onDone: () => void;
}

export class ReminderManager {
  private stateStore: StateStore;
  private settings: TaskManagerSettings;
  private quietHoursStartTotalMin: number | null = null;
  private quietHoursEndTotalMin: number | null = null;

  constructor(config: ReminderManagerConfig) {
    this.stateStore = config.stateStore;
    this.settings = config.settings;
    this.updateQuietHoursCache();
  }

  /**
   * Refresh the cached quiet-hours minute values from the current settings.
   * Must be called whenever quiet-hours settings change (e.g. after saveSettings()).
   */
  refreshCache(): void {
    this.updateQuietHoursCache();
  }

  private updateQuietHoursCache(): void {
    if (!this.settings.quietHoursEnabled) {
      this.quietHoursStartTotalMin = null;
      this.quietHoursEndTotalMin = null;
      return;
    }
    const [startHour, startMin] = this.settings.quietHoursStart.split(':').map(Number);
    this.quietHoursStartTotalMin = startHour * 60 + startMin;

    const [endHour, endMin] = this.settings.quietHoursEnd.split(':').map(Number);
    this.quietHoursEndTotalMin = endHour * 60 + endMin;
  }

  /**
   * Check if current time is within quiet hours window
   * Handles midnight-spanning windows (e.g., 22:00 to 08:00)
   */
  isInQuietHours(now: Date = new Date()): boolean {
    if (!this.settings.quietHoursEnabled || this.quietHoursStartTotalMin === null || this.quietHoursEndTotalMin === null) {
      return false;
    }

    const startTotalMin = this.quietHoursStartTotalMin;
    const endTotalMin = this.quietHoursEndTotalMin;
    
    if (startTotalMin === endTotalMin) return false;

    const nowHour = now.getHours();
    const nowMin = now.getMinutes();
    const nowTotalMin = nowHour * 60 + nowMin;

    if (startTotalMin < endTotalMin) {
      // Normal window (no midnight cross): 08:00 to 22:00
      return nowTotalMin >= startTotalMin && nowTotalMin < endTotalMin;
    }
    // Midnight-spanning window: 22:00 to 08:00
    // In quiet hours if: after 22:00 OR before 08:00
    return nowTotalMin >= startTotalMin || nowTotalMin < endTotalMin;
  }

  /**
   * Calculate the time when quiet hours end
   */
  getQuietHoursEndTime(now: Date = new Date()): Date {
    const [endHour, endMin] = this.settings.quietHoursEnd.split(':').map(Number);
    const endTime = new Date(now);
    endTime.setHours(endHour, endMin, 0, 0);

    if (endTime <= now) {
      // End time has already passed today, so it's tomorrow
      endTime.setDate(endTime.getDate() + 1);
    }

    return endTime;
  }

  /**
   * Create a snoozed reminder and return the next fire time
   */
  snoozeReminder(state: PersistedState, reminder: {
    reminderKey: string;
    taskFilePath: string;
    taskLineNumber: number;
    taskText: string;
    originalReminderTime: string;
  }, minutes: number): PersistedState {
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new Error('Snooze minutes must be a positive finite number');
    }

    const nextFireDate = new Date();
    nextFireDate.setMinutes(nextFireDate.getMinutes() + minutes);

    const nextFireTime = this.stateStore.formatReminderTime(nextFireDate);

    return this.stateStore.addSnoozedReminder(state, {
      reminderKey: reminder.reminderKey,
      taskFilePath: reminder.taskFilePath,
      taskLineNumber: reminder.taskLineNumber,
      taskText: reminder.taskText,
      originalReminderTime: reminder.originalReminderTime,
      nextFireTime,
      snoozedAtIso: new Date().toISOString(),
    });
  }

  /**
   * Get formatted snooze presets with display labels
   */
  getSnoozePresets(): Array<{ label: string; minutes: number }> {
    const presets = this.settings.reminderSnoozePresets || [5, 15, 60, 1440];
    return presets.map(minutes => ({
      minutes,
      label: this.formatSnoozeLabel(minutes),
    }));
  }

  /**
   * Format snooze duration as human-readable label
   */
  formatSnoozeLabel(minutes: number): string {
    if (minutes === 5) return '5 minutes';
    if (minutes === 15) return '15 minutes';
    if (minutes === 60) return '1 hour';
    if (minutes === 1440) return 'Tomorrow morning';
    if (minutes < 60) return `${minutes} minutes`;
    const hours = Math.floor(minutes / 60);
    if (minutes % 60 === 0) return `${hours} hour${hours > 1 ? 's' : ''}`;
    return `${hours}h ${minutes % 60}m`;
  }

  /**
   * Queue a notification for delivery when quiet hours end
   */
  queueNotification(state: PersistedState, reminder: {
    taskFilePath: string;
    taskLineNumber: number;
    taskText: string;
    reminderKey: string;
    reminderTime: string;
  }): PersistedState {
    return this.stateStore.addQueuedNotification(state, {
      ...reminder,
      enqueuedAtIso: new Date().toISOString(),
    });
  }

  /**
   * Deliver all queued notifications and clear the queue
   */
  deliverQueuedNotifications(state: PersistedState): {
    state: PersistedState;
    notifications: Array<{ taskText: string; reminderKey: string }>;
  } {
    const queued = this.stateStore.getQueuedNotifications(state);
    const notifications = queued.map(q => ({
      taskText: q.taskText,
      reminderKey: q.reminderKey,
    }));
    const newState = this.stateStore.clearQueuedNotifications(state);
    return { state: newState, notifications };
  }

  /**
   * Record a missed reminder (reminder fired while app was closed)
   */
  recordMissedReminder(state: PersistedState, reminder: {
    reminderKey: string;
    taskFilePath: string;
    taskLineNumber: number;
    taskText: string;
    reminderTime: string;
  }): PersistedState {
    return this.stateStore.addMissedReminder(state, {
      ...reminder,
      firedAtIso: new Date().toISOString(),
      acknowledged: false,
    });
  }

  /**
   * Get unacknowledged missed reminders for display in startup notice
   */
  getUnacknowledgedMissedReminders(state: PersistedState): Array<{
    reminderKey: string;
    taskFilePath: string;
    taskLineNumber: number;
    taskText: string;
    reminderTime: string;
    firedAtIso: string;
  }> {
    return this.stateStore.getUnacknowledgedMissedReminders(state).map(r => ({
      reminderKey: r.reminderKey,
      taskFilePath: r.taskFilePath,
      taskLineNumber: r.taskLineNumber,
      taskText: r.taskText,
      reminderTime: r.reminderTime,
      firedAtIso: r.firedAtIso,
    }));
  }

  /**
   * Check if any reminders are due to re-fire from the snooze queue
   */
  getDueSnoozedReminders(state: PersistedState): Array<{
    reminderKey: string;
    taskFilePath: string;
    taskLineNumber: number;
    taskText: string;
    originalReminderTime: string;
  }> {
    const due = this.stateStore.getDueSnoozedReminders(state, new Date());
    return due.map(r => ({
      reminderKey: r.reminderKey,
      taskFilePath: r.taskFilePath,
      taskLineNumber: r.taskLineNumber,
      taskText: r.taskText,
      originalReminderTime: r.originalReminderTime,
    }));
  }

  /**
   * Remove a snoozed reminder after it's been re-fired
   */
  clearSnoozedReminder(state: PersistedState, reminderKey: string): PersistedState {
    return this.stateStore.removeSnoozedReminder(state, reminderKey);
  }

  /**
   * Acknowledge a single missed reminder
   */
  acknowledgeMissedReminder(state: PersistedState, reminderKey: string): PersistedState {
    return this.stateStore.acknowledgeMissedReminder(state, reminderKey);
  }

  /**
   * Acknowledge all missed reminders (bulk dismiss from startup notice)
   */
  acknowledgeAllMissedReminders(state: PersistedState): PersistedState {
    return this.stateStore.acknowledgeAllMissedReminders(state);
  }

  /**
   * Prune old missed reminders (beyond retention period)
   */
  pruneMissedReminders(state: PersistedState, retentionDays: number = 7): PersistedState {
    return this.stateStore.pruneMissedReminders(state, retentionDays);
  }
}
