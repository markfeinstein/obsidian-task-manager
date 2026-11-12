import test from 'node:test';
import assert from 'node:assert/strict';

class TestElement extends EventTarget {
  tagName: string;
  className = '';
  textContent = '';
  id = '';
  children: TestElement[] = [];
  parent: TestElement | null = null;
  style: Record<string, string> = {};
  href = '';
  private attrs = new Map<string, string>();

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  removeAttribute(name: string): void { this.attrs.delete(name); if (name === 'id') this.id = ''; }
  appendChild<T extends TestElement>(child: T): T { child.parent = this; this.children.push(child); return child; }
  insertBefore<T extends TestElement>(child: T, before: TestElement | null): T {
    child.parent = this;
    const index = before ? this.children.indexOf(before) : -1;
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
    return child;
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  focus(): void { testDocument.activeElement = this; }
  querySelector(selector: string): TestElement | null { return findElement(this, selector); }
  querySelectorAll(): TestElement[] { return []; }
  get firstChild(): TestElement | null { return this.children[0] ?? null; }
}

function findElement(root: TestElement, selector: string): TestElement | null {
  for (const child of root.children) {
    if (selector.startsWith('.') && child.className.split(/\s+/u).includes(selector.slice(1))) return child;
    if (selector.startsWith('#') && child.id === selector.slice(1)) return child;
    const nested = findElement(child, selector);
    if (nested) return nested;
  }
  return null;
}

const testDocument = Object.assign(new EventTarget(), {
  body: new TestElement('body'),
  activeElement: null as TestElement | null,
  createElement: (tagName: string) => new TestElement(tagName),
  getElementById(id: string): TestElement | null { return findElement(this.body, `#${id}`); },
  querySelector(selector: string): TestElement | null { return findElement(this.body, selector); },
});

class TestKeyboardEvent extends Event {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;

  constructor(type: string, init: { key?: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}) {
    super(type);
    this.key = init.key ?? '';
    this.ctrlKey = Boolean(init.ctrlKey);
    this.shiftKey = Boolean(init.shiftKey);
    this.altKey = Boolean(init.altKey);
    this.metaKey = Boolean(init.metaKey);
  }
}

const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
test.before(() => {
  const replacements: Record<string, unknown> = {
    document: testDocument,
    KeyboardEvent: TestKeyboardEvent,
    window: {
      setTimeout,
      clearTimeout,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    },
  };
  for (const [name, value] of Object.entries(replacements)) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});
test.after(() => {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
import {
  handleQueryRowHotkey,
  setupQueryRowKeyboardNavigation,
  setupSwipeHandler,
  FocusManager,
  FocusTrap,
  ScreenReaderAnnouncer,
  addAriaAttributes,
  makeFocusable,
  createKeyboardHint,
  initializeAccessibility,
  isKeyboardEvent,
} from '../src/keyboard-nav';

/**
 * Test hotkey handler for query row operations (j/k/x/e/d)
 */
test('Hotkey handler: j key triggers onDown', () => {
  let called = false;
  const result = handleQueryRowHotkey('j', {
    onDown: () => { called = true; },
  });
  assert.equal(result, true);
  assert.equal(called, true);
});

test('Hotkey handler: k key triggers onUp', () => {
  let called = false;
  const result = handleQueryRowHotkey('k', {
    onUp: () => { called = true; },
  });
  assert.equal(result, true);
  assert.equal(called, true);
});

test('Hotkey handler: x key triggers onToggle', () => {
  let called = false;
  const result = handleQueryRowHotkey('x', {
    onToggle: () => { called = true; },
  });
  assert.equal(result, true);
  assert.equal(called, true);
});

test('Hotkey handler: e key triggers onEdit', () => {
  let called = false;
  const result = handleQueryRowHotkey('e', {
    onEdit: () => { called = true; },
  });
  assert.equal(result, true);
  assert.equal(called, true);
});

test('Hotkey handler: d key triggers onEditDate', () => {
  let called = false;
  const result = handleQueryRowHotkey('d', {
    onEditDate: () => { called = true; },
  });
  assert.equal(result, true);
  assert.equal(called, true);
});

test('Hotkey handler: J key (uppercase) triggers onDown', () => {
  let called = false;
  const result = handleQueryRowHotkey('J', {
    onDown: () => { called = true; },
  });
  assert.equal(result, true);
  assert.equal(called, true);
});

test('Hotkey handler: unknown key returns false', () => {
  const result = handleQueryRowHotkey('z', {});
  assert.equal(result, false);
});

 test('Hotkey handler: known key without handler returns false', () => {
  assert.equal(handleQueryRowHotkey('x', {}), false);
  assert.equal(handleQueryRowHotkey('e', {}), false);
  assert.equal(handleQueryRowHotkey('d', {}), false);
});

test('Hotkey handler: all handlers can be called', () => {
  const handlers = {
    downCalls: 0,
    upCalls: 0,
    toggleCalls: 0,
    editCalls: 0,
    dateCalls: 0,
  };

  handleQueryRowHotkey('j', { onDown: () => { handlers.downCalls++; } });
  handleQueryRowHotkey('k', { onUp: () => { handlers.upCalls++; } });
  handleQueryRowHotkey('x', { onToggle: () => { handlers.toggleCalls++; } });
  handleQueryRowHotkey('e', { onEdit: () => { handlers.editCalls++; } });
  handleQueryRowHotkey('d', { onEditDate: () => { handlers.dateCalls++; } });

  assert.equal(handlers.downCalls, 1);
  assert.equal(handlers.upCalls, 1);
  assert.equal(handlers.toggleCalls, 1);
  assert.equal(handlers.editCalls, 1);
  assert.equal(handlers.dateCalls, 1);
});

/**
 * Test ARIA attributes
 */
test('Accessibility: addAriaAttributes adds role', () => {
  const el = document.createElement('div');
  addAriaAttributes(el, { role: 'button' });
  assert.equal(el.getAttribute('role'), 'button');
});

test('Accessibility: addAriaAttributes adds label', () => {
  const el = document.createElement('div');
  addAriaAttributes(el, { label: 'Test label' });
  assert.equal(el.getAttribute('aria-label'), 'Test label');
});

test('Accessibility: addAriaAttributes adds pressed state', () => {
  const el = document.createElement('button');
  addAriaAttributes(el, { pressed: true });
  assert.equal(el.getAttribute('aria-pressed'), 'true');
});

test('Accessibility: addAriaAttributes adds expanded state', () => {
  const el = document.createElement('div');
  addAriaAttributes(el, { expanded: false });
  assert.equal(el.getAttribute('aria-expanded'), 'false');
});

test('Accessibility: addAriaAttributes adds disabled state', () => {
  const el = document.createElement('button');
  addAriaAttributes(el, { disabled: true });
  assert.equal(el.getAttribute('aria-disabled'), 'true');
});

test('Accessibility: addAriaAttributes adds live region', () => {
  const el = document.createElement('div');
  addAriaAttributes(el, { ariaLive: 'polite' });
  assert.equal(el.getAttribute('aria-live'), 'polite');
});

/**
 * Test keyboard event detection
 */
test('Keyboard event detection: isKeyboardEvent matches key', () => {
  const event = new KeyboardEvent('keydown', { key: 'Enter' });
  const result = isKeyboardEvent(event, 'Enter');
  assert.equal(result, true);
});

test('Keyboard event detection: isKeyboardEvent case-insensitive', () => {
  const event = new KeyboardEvent('keydown', { key: 'j' });
  const result = isKeyboardEvent(event, 'J');
  assert.equal(result, true);
});

test('Keyboard event detection: isKeyboardEvent checks modifiers', () => {
  const event = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true });
  const result = isKeyboardEvent(event, 'Enter', { ctrl: true });
  assert.equal(result, true);
});

test('Keyboard event detection: isKeyboardEvent fails without required modifiers', () => {
  const event = new KeyboardEvent('keydown', { key: 'Enter' });
  const result = isKeyboardEvent(event, 'Enter', { ctrl: true });
  assert.equal(result, false);
});

test('Query row keyboard navigation ignores Alt-modified hotkeys', () => {
  const container = document.createElement('div');
  let downCalls = 0;
  setupQueryRowKeyboardNavigation(
    container,
    { enabled: true, ariaLabelsEnabled: true, focusTrapEnabled: true },
    { onDown: () => { downCalls++; } },
  );

  container.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', altKey: true }));
  assert.equal(downCalls, 0);

  container.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
  assert.equal(downCalls, 1);
});

test('Query row keyboard navigation handles Tab when focusables are added later', () => {
  const container = document.createElement('div') as unknown as TestElement;
  const button = document.createElement('button') as unknown as TestElement;
  let focusables: TestElement[] = [];
  (container as unknown as { querySelectorAll: () => TestElement[] }).querySelectorAll = () => focusables;
  setupQueryRowKeyboardNavigation(
    container as unknown as HTMLElement,
    { enabled: true, ariaLabelsEnabled: true, focusTrapEnabled: true },
    {},
  );

  container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
  assert.equal(document.activeElement, null);

  focusables = [button];
  container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
  assert.equal(document.activeElement, button);
});

test('Query row keyboard navigation focuses the first element on initial Tab', () => {
  const container = document.createElement('div') as unknown as TestElement;
  const first = document.createElement('button') as unknown as TestElement;
  const second = document.createElement('button') as unknown as TestElement;
  (container as unknown as { querySelectorAll: () => TestElement[] }).querySelectorAll = () => [first, second];
  testDocument.activeElement = null;

  setupQueryRowKeyboardNavigation(
    container as unknown as HTMLElement,
    { enabled: true, ariaLabelsEnabled: true, focusTrapEnabled: true },
    {},
  );

  container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
  assert.equal(document.activeElement, first);

  container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
  assert.equal(document.activeElement, second);
});

/**
 * Test makeFocusable
 */
test('Accessibility: makeFocusable adds tabindex', () => {
  const el = document.createElement('div');
  makeFocusable(el);
  assert.equal(el.getAttribute('tabindex'), '0');
});

test('Accessibility: makeFocusable with custom tabindex', () => {
  const el = document.createElement('div');
  makeFocusable(el, -1);
  assert.equal(el.getAttribute('tabindex'), '-1');
});

/**
 * Test keyboard hint creation
 */
test('Accessibility: createKeyboardHint creates span element', () => {
  const hint = createKeyboardHint('Ctrl+K');
  assert.equal(hint.tagName, 'SPAN');
  assert.equal(hint.textContent, 'Ctrl+K');
  assert.equal(hint.className, 'task-manager-kb-hint');
});

test('Accessibility: createKeyboardHint adds aria-label', () => {
  const hint = createKeyboardHint('Ctrl+K');
  assert.equal(hint.getAttribute('aria-label'), 'Keyboard shortcut: Ctrl+K');
});

test('Accessibility: initializeAccessibility leaves Obsidian global landmarks untouched', () => {
  const workspace = document.createElement('div') as unknown as TestElement;
  workspace.className = 'workspace-leaf-content';
  testDocument.body.appendChild(workspace);

  const cleanup = initializeAccessibility();
  assert.equal(testDocument.body.children.some((child) => child.className === 'task-manager-skip-to-content'), false);
  assert.equal(workspace.id, '');
  assert.equal(workspace.getAttribute('role'), null);

  cleanup();
  assert.equal(workspace.id, '');
  assert.equal(workspace.getAttribute('role'), null);
  workspace.remove();
});

/**
 * Test ScreenReaderAnnouncer
 */
test('Accessibility: ScreenReaderAnnouncer announces message', () => {
  const announcer = new ScreenReaderAnnouncer('polite');
  announcer.announce('Test message');
  assert.ok(announcer);
  announcer.destroy();
});

test('Accessibility: FocusTrap wraps Tab and destroy removes listener', () => {
  const container = document.createElement('div') as unknown as TestElement;
  const first = document.createElement('button') as unknown as TestElement;
  const last = document.createElement('button') as unknown as TestElement;
  (container as unknown as { querySelectorAll: () => TestElement[] }).querySelectorAll = () => [first, last];
  const trap = new FocusTrap(container as unknown as HTMLElement);
  last.focus();
  const tab = new KeyboardEvent('keydown', { key: 'Tab' });
  container.dispatchEvent(tab);
  assert.equal(document.activeElement, first);
  trap.destroy();
  last.focus();
  container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
  assert.equal(document.activeElement, last);
});

/**
 * Test swipe handler
 */
test('Mobile: setupSwipeHandler returns cleanup function', () => {
  const el = document.createElement('div');
  const cleanup = setupSwipeHandler(el, () => {});
  assert.equal(typeof cleanup, 'function');
  cleanup();
});

/**
 * Hotkey integration test
 */
/**
 * FocusManager.focusPrevious off-by-one regression
 * When the active element is outside the container, indexOf returns -1.
 * The old formula (-1 - 1 + n) % n = n-2 focused the second-to-last element.
 * The fixed formula uses adjustedIndex = n so it wraps to the last element.
 */
test('FocusManager.focusPrevious wraps to last element when active element is outside container', () => {
  const container = document.createElement('div') as unknown as TestElement;
  const first  = document.createElement('button') as unknown as TestElement;
  const second = document.createElement('button') as unknown as TestElement;
  const last   = document.createElement('button') as unknown as TestElement;
  (container as unknown as { querySelectorAll: () => TestElement[] }).querySelectorAll = () => [first, second, last];
  // activeElement is NOT in the container (simulates focus outside)
  testDocument.activeElement = null;
  const mgr = new FocusManager();
  mgr.focusPrevious(container as unknown as HTMLElement);
  assert.strictEqual(testDocument.activeElement, last, 'should focus last element when focus is outside container');
});

test('FocusManager.focusPrevious wraps from first to last element', () => {
  const container = document.createElement('div') as unknown as TestElement;
  const first  = document.createElement('button') as unknown as TestElement;
  const second = document.createElement('button') as unknown as TestElement;
  const last   = document.createElement('button') as unknown as TestElement;
  (container as unknown as { querySelectorAll: () => TestElement[] }).querySelectorAll = () => [first, second, last];
  // activeElement is the first element
  testDocument.activeElement = first;
  const mgr = new FocusManager();
  mgr.focusPrevious(container as unknown as HTMLElement);
  assert.strictEqual(testDocument.activeElement, last, 'should wrap from first to last element');
});

test('Hotkey integration: all j/k/x/e/d keys work in sequence', () => {
  const sequence: string[] = [];

  handleQueryRowHotkey('j', { onDown: () => sequence.push('down') });
  handleQueryRowHotkey('k', { onUp: () => sequence.push('up') });
  handleQueryRowHotkey('x', { onToggle: () => sequence.push('toggle') });
  handleQueryRowHotkey('e', { onEdit: () => sequence.push('edit') });
  handleQueryRowHotkey('d', { onEditDate: () => sequence.push('date') });

  assert.deepEqual(sequence, ['down', 'up', 'toggle', 'edit', 'date']);
});
