import { JSDOM } from 'jsdom';

interface DomHarness {
  window: Window & typeof globalThis;
  document: Document;
  cleanup: () => void;
}

/** Install a standards-based DOM plus the small HTMLElement helpers Obsidian exposes. */
export function installDomHarness(): DomHarness {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://obsidian.local/' });
  const window = dom.window as unknown as Window & typeof globalThis;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const globals: Record<string, unknown> = {
    window,
    document: window.document,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLButtonElement: window.HTMLButtonElement,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    CustomEvent: window.CustomEvent,
    Event: window.Event,
    navigator: window.navigator,
    getComputedStyle: window.getComputedStyle.bind(window),
  };
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  const prototype = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  type HarnessElementOptions = { cls?: string; text?: string; type?: string; value?: string; attr?: Record<string, string> };
  const createChild = (parent: HTMLElement, tag: string, options: HarnessElementOptions = {}): HTMLElement => {
    const child = window.document.createElement(tag);
    if (options.cls) child.classList.add(...options.cls.split(/\s+/u).filter(Boolean));
    if (options.text !== undefined) child.textContent = options.text;
    if (options.type) child.setAttribute('type', options.type);
    if (options.value !== undefined) child.setAttribute('value', options.value);
    for (const [name, value] of Object.entries(options.attr ?? {})) child.setAttribute(name, value);
    parent.appendChild(child);
    return child;
  };
  prototype.addClass = function (this: HTMLElement, ...names: string[]): void { this.classList.add(...names); };
  prototype.removeClass = function (this: HTMLElement, ...names: string[]): void { this.classList.remove(...names); };
  prototype.toggleClass = function (this: HTMLElement, name: string, force?: boolean): void { this.classList.toggle(name, force); };
  prototype.setAttr = function (this: HTMLElement, name: string, value: string): void { this.setAttribute(name, value); };
  prototype.setText = function (this: HTMLElement, value: string): void { this.textContent = value; };
  prototype.empty = function (this: HTMLElement): void { this.replaceChildren(); };
  prototype.createEl = function (this: HTMLElement, tag: string, options?: HarnessElementOptions): HTMLElement { return createChild(this, tag, options); };
  prototype.createDiv = function (this: HTMLElement, options?: string | HarnessElementOptions): HTMLElement { return createChild(this, 'div', typeof options === 'string' ? { cls: options } : options); };
  prototype.createSpan = function (this: HTMLElement, options?: string | HarnessElementOptions): HTMLElement { return createChild(this, 'span', typeof options === 'string' ? { cls: options } : options); };
  prototype.show = function (this: HTMLElement): void { this.style.display = ''; };
  prototype.hide = function (this: HTMLElement): void { this.style.display = 'none'; };

  return {
    window,
    document: window.document,
    cleanup: () => {
      dom.window.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}
