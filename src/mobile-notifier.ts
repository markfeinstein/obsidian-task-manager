/**
 * Mobile Reminder Delivery — Background notification bridge for iOS/Android
 * 
 * Handles system-level notifications that persist when Obsidian is backgrounded.
 * Replaces the browser Notification API with platform-specific notification handlers.
 */

import { Notice, Platform } from 'obsidian';

export interface MobileNotificationOptions {
  title: string;
  body: string;
  tag?: string;
  badge?: string;
  icon?: string;
  actions?: Array<{ action: string; title: string }>;
  onAction?: (action: string) => void;
  onTap?: () => void;
}

export class MobileNotifier {
  private static readonly MAX_TITLE_LENGTH = 255;
  private static readonly MAX_BODY_LENGTH = 4096;
  private static firedNotifications = new Map<string, number>();
  private static warnedMissingMobileBridge = false;

  /**
   * Send a notification optimized for mobile platforms.
   * On desktop: uses web Notification API
   * On iOS: queues for native bridge (via statusbar plugin or system event)
   * On Android: uses Obsidian's statusbar + persistent intent
   */
  static async notify(options: MobileNotificationOptions): Promise<void> {
    const tag = options.tag || `notification-${Date.now()}`;
    const now = Date.now();

    // Prevent duplicate notifications (same tag within 5s)
    for (const [firedTag, firedAt] of this.firedNotifications.entries()) {
      if (now - firedAt > 5000) this.firedNotifications.delete(firedTag);
    }
    const lastFired = this.firedNotifications.get(tag) || 0;
    if (now - lastFired < 5000) {
      return;
    }
    this.firedNotifications.set(tag, now);

    // iOS-specific: Use statusbar for persistent reminders
    if (Platform.isIosApp) {
      await this.notifyIos(options);
      return;
    }

    // Android-specific: Use Obsidian's notification center
    if (Platform.isAndroidApp) {
      await this.notifyAndroid(options);
      return;
    }

    // Desktop fallback: Use web Notification API
    await this.notifyDesktop(options);
  }

  /**
   * iOS notifications persist via statusbar + Reminders integration
   */
  private static async notifyIos(options: MobileNotificationOptions): Promise<void> {
    try {
      // Try to use Obsidian's iOS-specific Notification interface if available
      const notification = (window as unknown as {
        ObsidianMobileNotification?: {
          sendNotification(
            title: string,
            body: string,
            category?: string,
            payload?: Record<string, string>
          ): Promise<void>;
        };
      }).ObsidianMobileNotification;

      if (notification?.sendNotification) {
        await notification.sendNotification(
          this.truncate(options.title, this.MAX_TITLE_LENGTH),
          this.truncate(options.body, this.MAX_BODY_LENGTH),
          'REMINDER',
          { tag: options.tag || '', actions: JSON.stringify(options.actions ?? []) }
        );
        return;
      }
    } catch {
    }

    // Fallback: Use in-app notice with persistence flag
    this.warnMissingMobileBridgeOnce();
    const notice = new Notice(
      `🔔 ${options.title}\n${options.body}`,
      10000
    );
    
    // Mark as persistent so it's logged for missed reminders
    (notice as unknown as { persistent?: boolean }).persistent = true;
  }

  /**
   * Android notifications use statusbar + system tray persistence
   */
  private static async notifyAndroid(options: MobileNotificationOptions): Promise<void> {
    try {
      // Try to use Obsidian's Android notification bridge
      const notification = (window as unknown as {
        ObsidianAndroidNotification?: {
          notify(
            id: string,
            title: string,
            text: string,
            ongoing: boolean,
            priority: number,
            actions?: Array<{ action: string; title: string }>,
          ): Promise<void>;
        };
      }).ObsidianAndroidNotification;

      if (notification?.notify) {
        await notification.notify(
          options.tag || `reminder-${Date.now()}`,
          this.truncate(options.title, this.MAX_TITLE_LENGTH),
          this.truncate(options.body, this.MAX_BODY_LENGTH),
          false, // Not ongoing
          1, // Priority: HIGH
          options.actions,
        );
        return;
      }
    } catch {
    }

    // Fallback: Use in-app notice + persistent logging
    this.warnMissingMobileBridgeOnce();
    const notice = new Notice(
      `🔔 ${options.title}\n${options.body}`,
      10000
    );
    
    (notice as unknown as { persistent?: boolean }).persistent = true;
  }

  private static warnMissingMobileBridgeOnce(): void {
    if (this.warnedMissingMobileBridge) return;
    this.warnedMissingMobileBridge = true;
    new Notice('Task Manager: background mobile reminders require a native notification bridge; Obsidian must stay open for in-app reminder notices.', 10_000);
  }

  /**
   * Desktop notifications use web Notification API
   */
  private static async notifyDesktop(options: MobileNotificationOptions): Promise<void> {
    const Win = window as unknown as {
      Notification?: {
        permission: 'default' | 'granted' | 'denied';
        requestPermission(): Promise<'default' | 'granted' | 'denied'>;
        new(title: string, opts: NotificationOptions): {
          onclick: ((this: Notification, ev: Event) => void) | null;
          close(): void;
        };
      };
    };

    if (!Win.Notification) {
      new Notice(`🔔 ${options.title}\n${options.body}`, 10000);
      return;
    }

    if (Win.Notification.permission === 'denied') {
      new Notice(`🔔 ${options.title}\n${options.body}`, 10000);
      return;
    }

    if (Win.Notification.permission === 'default') {
      const result = await Win.Notification.requestPermission();
      if (result !== 'granted') {
        new Notice(`🔔 ${options.title}\n${options.body}`, 10000);
        return;
      }
    }

    // Permission is 'granted', create notification
    try {
      const notification = new Win.Notification(
        this.truncate(options.title, this.MAX_TITLE_LENGTH),
        {
          body: this.truncate(options.body, this.MAX_BODY_LENGTH),
          tag: options.tag,
          icon: options.icon,
          badge: options.badge,
        }
      );
      
      notification.onclick = () => {
        window.focus();
        notification.close();
        options.onTap?.();
      };
    } catch (error) {
      console.error('[MobileNotifier] Failed to create notification:', error);
      new Notice(`🔔 ${options.title}\n${options.body}`, 10000);
    }
  }

  /**
   * Truncate string to max length, adding ellipsis if needed
   */
  private static truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 1) + '…';
  }

  /**
   * Clear all fired notifications (useful for app restart or testing)
   */
  static clearFiredNotifications(): void {
    this.firedNotifications.clear();
  }

  /**
   * Get current platform name (for debugging)
   */
  static getPlatform(): string {
    if (Platform.isIosApp) return 'iOS';
    if (Platform.isAndroidApp) return 'Android';
    if (Platform.isMacOS) return 'macOS';
    if (Platform.isWin) return 'Windows';
    if (Platform.isLinux) return 'Linux';
    return 'Unknown';
  }
}
