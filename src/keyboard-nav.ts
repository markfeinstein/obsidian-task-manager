/**
 * Keyboard Navigation & Accessibility Support
 * Provides WCAG 2.1 AA compliant keyboard navigation across all query views
 */

export interface KeyboardNavigationConfig {
  enabled: boolean;
  ariaLabelsEnabled: boolean;
  focusTrapEnabled: boolean;
}

export const DEFAULT_KB_CONFIG: KeyboardNavigationConfig = {
  enabled: true,
  ariaLabelsEnabled: true,
  focusTrapEnabled: true,
};

/**
 * Standard keyboard shortcuts across all views
 */
export const KEYBOARD_SHORTCUTS = {
  CLOSE_MODAL: 'Escape',
  TOGGLE_CHECKBOX: ' ',
  CYCLE_STATUS: 'c',
  EDIT_DATE: 'd',
  EDIT_TASK: 'e',
  DELETE_TASK: 'Delete',
  MOVE_UP: 'ArrowUp',
  MOVE_DOWN: 'ArrowDown',
  FOCUS_SEARCH: 'Control+f',
  ENTER: 'Enter',
  TAB: 'Tab',
  SHIFT_TAB: 'Shift+Tab',
  // Query row hotkeys (Vim-like navigation)
  QUERY_ROW_DOWN: 'j',  // Move down
  QUERY_ROW_UP: 'k',    // Move up
  QUERY_ROW_TOGGLE: 'x', // Toggle checkbox
  QUERY_ROW_EDIT: 'e',   // Edit task
  QUERY_ROW_DATE: 'd',   // Edit date
} as const;

/**
 * Add keyboard navigation support to a container element with query row hotkeys
 */
export function setupQueryRowKeyboardNavigation(
  container: HTMLElement,
  config: KeyboardNavigationConfig,
  handlers: {
    onUp?: () => void;
    onDown?: () => void;
    onEnter?: () => void;
    onEscape?: () => void;
    onToggle?: () => void;  // Space or 'x'
    onEdit?: () => void;    // 'e'
    onEditDate?: () => void; // 'd'
  }
): void {
  if (!config.enabled) return;

  container.addEventListener('keydown', (e: KeyboardEvent) => {
    const { key, shiftKey, ctrlKey, metaKey, altKey } = e;

    // Only process if no modifiers (except for expected ones)
    if (ctrlKey || metaKey || altKey) return;

    // Vim-like navigation: j = down, k = up
    if (key.toLowerCase() === 'j' && handlers.onDown) {
      e.preventDefault();
      handlers.onDown();
      return;
    }

    if (key.toLowerCase() === 'k' && handlers.onUp) {
      e.preventDefault();
      handlers.onUp();
      return;
    }

    // Toggle: x or Space
    if ((key === 'x' || key === ' ') && handlers.onToggle) {
      e.preventDefault();
      handlers.onToggle();
      return;
    }

    // Edit: e
    if (key.toLowerCase() === 'e' && handlers.onEdit) {
      e.preventDefault();
      handlers.onEdit();
      return;
    }

    // Edit date: d
    if (key.toLowerCase() === 'd' && handlers.onEditDate) {
      e.preventDefault();
      handlers.onEditDate();
      return;
    }

    // Escape key
    if (key === 'Escape' && handlers.onEscape) {
      e.preventDefault();
      handlers.onEscape();
      return;
    }

    // Arrow Up (fallback)
    if (key === 'ArrowUp' && handlers.onUp) {
      e.preventDefault();
      handlers.onUp();
      return;
    }

    // Arrow Down (fallback)
    if (key === 'ArrowDown' && handlers.onDown) {
      e.preventDefault();
      handlers.onDown();
      return;
    }

    // Enter
    if (key === 'Enter' && handlers.onEnter) {
      e.preventDefault();
      handlers.onEnter();
      return;
    }

    // Tab navigation between focusable elements
    if (key === 'Tab') {
      const focusableElements = getFocusableElements(container);
      if (focusableElements.length === 0) return;
      const currentIndex = focusableElements.indexOf(document.activeElement as HTMLElement);
      const baseIndex = currentIndex === -1
        ? (shiftKey ? 0 : -1)
        : currentIndex;
      const nextIndex = shiftKey
        ? (baseIndex - 1 + focusableElements.length) % focusableElements.length
        : (baseIndex + 1) % focusableElements.length;
      const nextElement = focusableElements[nextIndex];
      if (nextElement) {
        e.preventDefault();
        nextElement.focus();
      }
    }
  });
}

/**
 * Get all keyboard-focusable elements in a container
 */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector =
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll(selector));
}

/**
 * Add ARIA labels and roles for accessibility
 */
export function addAriaAttributes(element: HTMLElement, options: {
  role?: string;
  label?: string;
  labelledBy?: string;
  pressed?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  describedBy?: string;
  ariaLive?: 'polite' | 'assertive';
}): void {
  if (options.role) element.setAttribute('role', options.role);
  if (options.label) element.setAttribute('aria-label', options.label);
  if (options.labelledBy) element.setAttribute('aria-labelledby', options.labelledBy);
  if (typeof options.pressed === 'boolean') element.setAttribute('aria-pressed', String(options.pressed));
  if (typeof options.expanded === 'boolean') element.setAttribute('aria-expanded', String(options.expanded));
  if (typeof options.disabled === 'boolean') element.setAttribute('aria-disabled', String(options.disabled));
  if (options.describedBy) element.setAttribute('aria-describedby', options.describedBy);
  if (options.ariaLive) element.setAttribute('aria-live', options.ariaLive);
}

/**
 * Make an element focusable and mark it as such
 */
export function makeFocusable(element: HTMLElement, tabIndex: number = 0): void {
  element.setAttribute('tabindex', String(tabIndex));
}

/**
 * Focus management helper
 */
export class FocusManager {
  private previousElement: HTMLElement | null = typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null;

  captureCurrentFocus(): void {
    if (typeof document !== 'undefined') this.previousElement = document.activeElement as HTMLElement | null;
  }

  focus(element: HTMLElement): void {
    if (!this.previousElement && typeof document !== 'undefined') this.previousElement = document.activeElement as HTMLElement;
    element.focus();
  }

  restoreFocus(): void {
    if (this.previousElement && this.previousElement.isConnected !== false) {
      this.previousElement.focus();
    }
  }

  focusElement(selector: string, container: HTMLElement = document.body): void {
    const element = container.querySelector(selector) as HTMLElement;
    if (element) this.focus(element);
  }

  focusNext(container: HTMLElement): void {
    const focusable = getFocusableElements(container);
    const current = document.activeElement as HTMLElement;
    const index = focusable.indexOf(current);
    const next = focusable[(index + 1) % focusable.length];
    if (next) this.focus(next);
  }

  focusPrevious(container: HTMLElement): void {
    const focusable = getFocusableElements(container);
    const current = document.activeElement as HTMLElement;
    const index = focusable.indexOf(current);
    // When the active element is outside the container (index === -1), treat it
    // as if focus is just before the first element so that the previous element
    // wraps around to the LAST focusable element.  The unadjusted formula
    // (-1 - 1 + n) % n = n - 2 would incorrectly land on the second-to-last.
    const adjustedIndex = index === -1 ? focusable.length : index;
    const prev = focusable[(adjustedIndex - 1 + focusable.length) % focusable.length];
    if (prev) this.focus(prev);
  }
}

/**
 * Keyboard event helper
 */
export function isKeyboardEvent(e: KeyboardEvent, key: string, modifiers?: {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}): boolean {
  if (e.key.toLowerCase() !== key.toLowerCase()) return false;
  if (modifiers?.ctrl && !e.ctrlKey) return false;
  if (modifiers?.shift && !e.shiftKey) return false;
  if (modifiers?.alt && !e.altKey) return false;
  if (modifiers?.meta && !e.metaKey) return false;
  return true;
}

/**
 * Helper to create a keyboard hint element
 */
export function createKeyboardHint(text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'task-manager-kb-hint';
  span.textContent = text;
  span.setAttribute('aria-label', `Keyboard shortcut: ${text}`);
  return span;
}

/**
 * Check if element is visible (for focus management)
 */
export function isElementVisible(el: HTMLElement): boolean {
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

/**
 * Trap focus within a container (useful for modals)
 */
export class FocusTrap {
  private focusableElements: HTMLElement[];
  private firstElement: HTMLElement | undefined;
  private lastElement: HTMLElement | undefined;
  private readonly boundKeydown: (e: KeyboardEvent) => void;

  constructor(private container: HTMLElement) {
    this.focusableElements = getFocusableElements(container);
    this.firstElement = this.focusableElements[0];
    this.lastElement = this.focusableElements[this.focusableElements.length - 1];
    this.boundKeydown = (e) => this.handleKeydown(e);
    this.container.addEventListener('keydown', this.boundKeydown);
  }

  refresh(): void {
    this.focusableElements = getFocusableElements(this.container);
    this.firstElement = this.focusableElements[0];
    this.lastElement = this.focusableElements[this.focusableElements.length - 1];
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return;
    if (!this.firstElement || !this.lastElement) return;

    if (e.shiftKey) {
      if (document.activeElement === this.firstElement) {
        e.preventDefault();
        this.lastElement.focus();
      }
    } else {
      if (document.activeElement === this.lastElement) {
        e.preventDefault();
        this.firstElement.focus();
      }
    }
  }

  destroy(): void {
    this.container.removeEventListener('keydown', this.boundKeydown);
  }
}

/**
 * Announce updates to screen readers
 */
export class ScreenReaderAnnouncer {
  private liveRegion: HTMLDivElement;

  constructor(ariaLive: 'polite' | 'assertive' = 'polite') {
    this.liveRegion = document.createElement('div');
    this.liveRegion.setAttribute('aria-live', ariaLive);
    this.liveRegion.setAttribute('aria-atomic', 'true');
    this.liveRegion.className = 'task-manager-sr-only';
    this.liveRegion.style.position = 'absolute';
    this.liveRegion.style.left = '-10000px';
    this.liveRegion.style.width = '1px';
    this.liveRegion.style.height = '1px';
    this.liveRegion.style.overflow = 'hidden';
    document.body.appendChild(this.liveRegion);
  }

  announce(message: string): void {
    this.liveRegion.textContent = message;
  }

  clear(): void {
    this.liveRegion.textContent = '';
  }

  destroy(): void {
    this.liveRegion.remove();
  }
}

/**
 * Initialize global accessibility features
 */
export function initializeAccessibility(): () => void {
  // Do not rewrite Obsidian's global landmarks or install a body-level skip
  // target. Each Task Manager surface owns a local skip link and landmark.
  return () => undefined;
}

/**
 * Add comprehensive ARIA attributes to an element for accessibility
 */
export function makeAccessible(element: HTMLElement, options: {
  role?: string;
  label?: string;
  describedBy?: string;
  live?: 'polite' | 'assertive' | 'off';
  hidden?: boolean;
  expanded?: boolean;
  pressed?: boolean;
  disabled?: boolean;
  valueNow?: number;
  valueMax?: number;
  valueMin?: number;
}): HTMLElement {
  if (options.role) element.setAttribute('role', options.role);
  if (options.label) element.setAttribute('aria-label', options.label);
  if (options.describedBy) element.setAttribute('aria-describedby', options.describedBy);
  if (options.live) element.setAttribute('aria-live', options.live);
  if (typeof options.hidden === 'boolean') element.setAttribute('aria-hidden', String(options.hidden));
  if (typeof options.expanded === 'boolean') element.setAttribute('aria-expanded', String(options.expanded));
  if (typeof options.pressed === 'boolean') element.setAttribute('aria-pressed', String(options.pressed));
  if (typeof options.disabled === 'boolean') element.setAttribute('aria-disabled', String(options.disabled));
  if (typeof options.valueNow === 'number') {
    element.setAttribute('aria-valuenow', String(options.valueNow));
    if (typeof options.valueMin === 'number') element.setAttribute('aria-valuemin', String(options.valueMin));
    if (typeof options.valueMax === 'number') element.setAttribute('aria-valuemax', String(options.valueMax));
  }
  return element;
}

/**
 * Hotkey handler for query row operations (j/k/x/e/d)
 * Used for testing and consistent hotkey handling
 */
export function handleQueryRowHotkey(
  key: string,
  handlers: {
    onDown?: () => void;
    onUp?: () => void;
    onToggle?: () => void;
    onEdit?: () => void;
    onEditDate?: () => void;
    onEnter?: () => void;
    onEscape?: () => void;
  }
): boolean {
  const lowerKey = key.toLowerCase();
  
  switch (lowerKey) {
    case 'arrowdown':
    case 'j':
      if (!handlers.onDown) return false;
      handlers.onDown();
      return true;
    case 'arrowup':
    case 'k':
      if (!handlers.onUp) return false;
      handlers.onUp();
      return true;
    case ' ':
    case 'x':
      if (!handlers.onToggle) return false;
      handlers.onToggle();
      return true;
    case 'e':
      if (!handlers.onEdit) return false;
      handlers.onEdit();
      return true;
    case 'd':
      if (!handlers.onEditDate) return false;
      handlers.onEditDate();
      return true;
    case 'enter':
      if (!handlers.onEnter) return false;
      handlers.onEnter();
      return true;
    case 'escape':
      if (!handlers.onEscape) return false;
      handlers.onEscape();
      return true;
    default:
      return false;
  }
}

/**
 * Swipe gesture detection for mobile
 * Returns the swipe direction ('left', 'right', 'up', 'down') or null
 */
export function setupSwipeHandler(
  element: HTMLElement,
  onSwipe: (direction: 'left' | 'right' | 'up' | 'down') => void,
  threshold: number = 50
): () => void {
  let touchStartX = 0;
  let touchStartY = 0;

  const handleTouchStart = (e: TouchEvent): void => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  };

  const handleTouchEnd = (e: TouchEvent): void => {
    const touchEndX = e.changedTouches[0].clientX;
    const touchEndY = e.changedTouches[0].clientY;
    const deltaX = touchEndX - touchStartX;
    const deltaY = touchEndY - touchStartY;

    // Determine if swipe is horizontal or vertical
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > threshold) {
      onSwipe(deltaX > 0 ? 'right' : 'left');
    } else if (Math.abs(deltaY) > threshold) {
      onSwipe(deltaY > 0 ? 'down' : 'up');
    }
  };

  element.addEventListener('touchstart', handleTouchStart);
  element.addEventListener('touchend', handleTouchEnd);

  // Return cleanup function
  return () => {
    element.removeEventListener('touchstart', handleTouchStart);
    element.removeEventListener('touchend', handleTouchEnd);
  };
}
