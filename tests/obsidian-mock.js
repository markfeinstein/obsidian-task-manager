class TAbstractFile {
  constructor(path = '') {
    this.path = path;
    this.name = path.split('/').pop() || path;
    this.parent = null;
    this.vault = null;
  }
}
class TFile extends TAbstractFile {
  constructor(path = '') {
    super(path);
    const dot = this.name.lastIndexOf('.');
    this.extension = dot >= 0 ? this.name.slice(dot + 1) : '';
    this.basename = dot >= 0 ? this.name.slice(0, dot) : this.name;
    this.stat = { ctime: 0, mtime: 0, size: 0 };
  }
}
class TFolder extends TAbstractFile {
  constructor(path = '') { super(path); this.children = []; }
}
function normalizePath(value) {
  return String(value).replace(/\\+/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '');
}
function pad(value) { return String(value).padStart(2, '0'); }
function moment(input, format, strict) {
  let valid = true;
  let date;
  if (input instanceof Date) date = input;
  else if (typeof input === 'string' && format === 'YYYY-MM-DD') {
    const match = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      valid = date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]);
    } else {
      valid = !strict;
      date = new Date();
    }
  } else if (typeof input === 'string' && format === 'MMMM Do YYYY') {
    const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const match = input.match(/^([A-Za-z]+) (\d{1,2})(?:st|nd|rd|th) (\d{4})$/);
    const monthIndex = match ? months.indexOf(match[1].toLowerCase()) : -1;
    if (match && monthIndex >= 0) {
      date = new Date(Number(match[3]), monthIndex, Number(match[2]));
      valid = date.getFullYear() === Number(match[3]) && date.getMonth() === monthIndex && date.getDate() === Number(match[2]);
    } else {
      valid = !strict;
      date = new Date();
    }
  } else if (typeof input === 'string' && strict) {
    valid = false;
    date = new Date();
  } else date = new Date();
  return {
    isValid() { return valid; },
    format(format) {
      const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const hours12 = date.getHours() % 12 || 12;
      return format.replace(/\[([^\]]+)\]|YYYY|YY|MMMM|MMM|MM|DD|dddd|ddd|HH|mm|A|D|h/g, (token, literal) => {
        if (literal !== undefined) return literal;
        if (token === 'YYYY') return String(date.getFullYear());
        if (token === 'YY') return String(date.getFullYear()).slice(-2);
        if (token === 'MMMM') return months[date.getMonth()];
        if (token === 'MMM') return months[date.getMonth()].slice(0, 3);
        if (token === 'MM') return pad(date.getMonth() + 1);
        if (token === 'DD') return pad(date.getDate());
        if (token === 'D') return String(date.getDate());
        if (token === 'dddd') return weekdays[date.getDay()];
        if (token === 'ddd') return weekdays[date.getDay()].slice(0, 3);
        if (token === 'HH') return pad(date.getHours());
        if (token === 'h') return String(hours12);
        if (token === 'mm') return pad(date.getMinutes());
        if (token === 'A') return date.getHours() < 12 ? 'AM' : 'PM';
        return token;
      });
    },
  };
}

function createElement(tagName = 'div') {
  const listeners = new Map();
  const classes = new Set();
  const element = {
    tagName: tagName.toUpperCase(),
    children: [],
    attributes: new Map(),
    dataset: {},
    style: { setProperty(name, value) { this[name] = value; } },
    classList: {
      add(...names) { for (const name of names) classes.add(name); },
      remove(...names) { for (const name of names) classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const next = force === undefined ? !classes.has(name) : force;
        if (next) classes.add(name); else classes.delete(name);
        return next;
      },
    },
    setAttr(name, value) { this.attributes.set(name, String(value)); },
    setAttribute(name, value) { this.setAttr(name, value); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    removeAttribute(name) { this.attributes.delete(name); },
    addClass(...names) { this.classList.add(...names); },
    removeClass(...names) { this.classList.remove(...names); },
    toggleClass(name, force) { this.classList.toggle(name, force); },
    setText(value) { this.textContent = String(value); },
    empty() { this.children.length = 0; this.textContent = ''; },
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
    prepend(child) { this.children.unshift(child); child.parentElement = this; },
    createEl(tag, options = {}) {
      const child = createElement(tag);
      if (options.cls) child.addClass(...String(options.cls).split(/\s+/).filter(Boolean));
      if (options.text !== undefined) child.setText(options.text);
      if (options.type) child.type = options.type;
      if (options.attr) for (const [name, value] of Object.entries(options.attr)) child.setAttr(name, value);
      return this.appendChild(child);
    },
    createDiv(options) { return this.createEl('div', typeof options === 'string' ? { cls: options } : options); },
    createSpan(options) { return this.createEl('span', typeof options === 'string' ? { cls: options } : options); },
    onClickEvent(callback) { this.addEventListener('click', callback); return this; },
    addEventListener(type, callback) {
      const callbacks = listeners.get(type) ?? [];
      callbacks.push(callback);
      listeners.set(type, callbacks);
    },
    removeEventListener(type, callback) {
      listeners.set(type, (listeners.get(type) ?? []).filter((candidate) => candidate !== callback));
    },
    dispatchEvent(event) {
      event.target ??= this;
      for (const callback of [...(listeners.get(event.type) ?? [])]) callback.call(this, event);
      return !event.defaultPrevented;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
    querySelectorAll(selector) {
      const results = [];
      const matches = (node) => selector.startsWith('.')
        ? node.classList?.contains(selector.slice(1))
        : selector.startsWith('#')
          ? node.getAttribute?.('id') === selector.slice(1)
          : node.tagName?.toLowerCase() === selector.toLowerCase();
      const visit = (node) => {
        for (const child of node.children ?? []) {
          if (matches(child)) results.push(child);
          visit(child);
        }
      };
      visit(this);
      return results;
    },
    contains(node) {
      if (node === this) return true;
      return this.children.some((child) => child.contains?.(node));
    },
    remove() {
      if (!this.parentElement) return;
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      this.parentElement = null;
    },
    focus() { globalThis.document && (globalThis.document.activeElement = this); },
  };
  Object.defineProperty(element, 'className', {
    get() { return [...classes].join(' '); },
    set(value) { classes.clear(); for (const name of String(value).split(/\s+/).filter(Boolean)) classes.add(name); },
  });
  return element;
}

class Notice {
  static messages = [];
  constructor(message) {
    this.message = String(message);
    this.noticeEl = createElement('div');
    this.hidden = false;
    Notice.messages.push(this.message);
  }
  hide() { this.hidden = true; }
}
class Plugin {
  constructor(app = {}, manifest = {}) {
    this.app = app;
    this.manifest = manifest;
    this._registered = [];
    this._commands = [];
    this._data = null;
  }
  register(disposer) { this._registered.push(disposer); return disposer; }
  registerEvent(eventRef) { this.register(() => eventRef?.off?.()); return eventRef; }
  registerDomEvent(element, type, callback, options) {
    element.addEventListener(type, callback, options);
    this.register(() => element.removeEventListener(type, callback, options));
  }
  registerInterval(id) { this.register(() => clearInterval(id)); return id; }
  addCommand(command) { this._commands.push(command); return command; }
  addSettingTab(tab) { this._settingTab = tab; }
  addRibbonIcon() { return createElement('div'); }
  addStatusBarItem() { return createElement('div'); }
  registerView(type, creator) { this._view = { type, creator }; }
  registerMarkdownCodeBlockProcessor(type, processor) { this._processor = { type, processor }; }
  registerMarkdownPostProcessor(processor) { this._postProcessor = processor; }
  registerEditorSuggest(suggest) { this._editorSuggest = suggest; }
  registerEditorExtension(extension) { this._editorExtensions ??= []; this._editorExtensions.push(extension); }
  registerObsidianProtocolHandler(name, handler) { this._protocolHandler = { name, handler }; }
  registerCliHandler(handler) { this._cliHandler = handler; }
  async loadData() { return this._data; }
  async saveData(value) { this._data = value; }
  unloadForTest() {
    for (const disposer of this._registered.splice(0).reverse()) disposer();
    this.onunload?.();
  }
}
class PluginSettingTab {
  constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = createElement('div'); }
}
function component(target) {
  const api = {
    buttonEl: target,
    inputEl: target,
    selectEl: target,
    toggleEl: target,
    setValue(value) { target.value = value; return api; },
    setPlaceholder(value) { target.placeholder = value; return api; },
    setButtonText(value) { target.textContent = value; return api; },
    setTooltip(value) { target.title = value; return api; },
    setIcon(value) { target.dataset.icon = value; return api; },
    setWarning() { return api; },
    setCta() { return api; },
    setDisabled(value) { target.disabled = value; return api; },
    setLimits(min, max, step) { target.min = min; target.max = max; target.step = step; return api; },
    setDynamicTooltip() { return api; },
    addOption(value, label) {
      if (Array.isArray(target.options)) target.options.push({ value, label });
      else if (target.ownerDocument?.createElement && target.appendChild) {
        const option = target.ownerDocument.createElement('option');
        option.value = value;
        option.textContent = label;
        target.appendChild(option);
      }
      return api;
    },
    onClick(callback) { target.addEventListener('click', callback); return api; },
    onChange(callback) { target._onChange = callback; return api; },
  };
  return api;
}
class Setting {
  constructor(container) {
    this.settingEl = container?.createDiv?.({ cls: 'setting-item' }) ?? createElement('div');
    this.settingEl.addClass?.('setting-item');
    this.infoEl = this.settingEl.createDiv?.({ cls: 'setting-item-info' }) ?? this.settingEl;
    this.infoEl.addClass?.('setting-item-info');
    this.nameEl = this.infoEl.createDiv?.({ cls: 'setting-item-name' }) ?? this.infoEl;
    this.nameEl.addClass?.('setting-item-name');
    this.descEl = this.infoEl.createDiv?.({ cls: 'setting-item-description' }) ?? this.infoEl;
    this.descEl.addClass?.('setting-item-description');
    this.controlEl = this.settingEl.createDiv?.({ cls: 'setting-item-control' }) ?? this.settingEl;
    this.controlEl.addClass?.('setting-item-control');
  }
  setName(value) { this.name = value; this.nameEl.setText?.(String(value)); return this; }
  setDesc(value) { this.desc = value; this.descEl.setText?.(typeof value === 'string' ? value : ''); return this; }
  setClass(value) { this.settingEl.classList?.add?.(value); return this; }
  addButton(callback) { callback(component(this.controlEl.createEl('button'))); return this; }
  addExtraButton(callback) { return this.addButton(callback); }
  addText(callback) { callback(component(this.controlEl.createEl('input'))); return this; }
  addTextArea(callback) { callback(component(this.controlEl.createEl('textarea'))); return this; }
  addDropdown(callback) { callback(component(this.controlEl.createEl('select'))); return this; }
  addSlider(callback) { callback(component(this.controlEl.createEl('input', { type: 'range' }))); return this; }
  addToggle(callback) { callback(component(this.controlEl.createEl('input', { type: 'checkbox' }))); return this; }
}
class Modal {
  constructor(app) {
    this.app = app;
    const useStandardsDom = globalThis.document?.createElement && globalThis.HTMLElement;
    this.modalEl = useStandardsDom ? globalThis.document.createElement('div') : createElement('div');
    this.modalEl.addClass?.('modal');
    this.titleEl = this.modalEl.createEl('h2', { cls: 'modal-title' });
    this.contentEl = this.modalEl.createDiv('modal-content');
    this._open = false;
  }
  open() {
    if (this._open) return this;
    this._open = true;
    if (this.modalEl instanceof (globalThis.HTMLElement ?? Object) && !this.modalEl.isConnected) globalThis.document?.body?.appendChild(this.modalEl);
    this.onOpen?.();
    return this;
  }
  close() {
    if (!this._open) { this.onClose?.(); return this; }
    this._open = false;
    this.onClose?.();
    this.modalEl.remove?.();
    return this;
  }
}
class SuggestModal extends Modal {
  setPlaceholder(value) { this.placeholder = value; return this; }
  open() { return super.open(); }
}
class FuzzySuggestModal extends SuggestModal {
  getItems() { return []; }
  getItemText(item) { return String(item); }
  onChooseItem() {}
}
class EditorSuggest {}
class Menu {
  constructor() { this.items = []; Menu.last = this; }
  addItem(callback) {
    const entry = { title: '', disabled: false, click: null };
    const item = {
      setTitle(value) { entry.title = value; return this; },
      setDisabled(value) { entry.disabled = value; return this; },
      setIcon() { return this; },
      setChecked(value) { entry.checked = value; return this; },
      onClick(handler) { entry.click = handler; return this; },
    };
    callback(item);
    this.items.push(entry);
    return this;
  }
  addSeparator() { this.items.push({ separator: true }); return this; }
  showAtMouseEvent() { return this; }
  showAtPosition() { return this; }
}
const MarkdownRenderer = {
  async renderMarkdown(markdown, element) { if (element?.setText) element.setText(markdown); else if (element) element.textContent = markdown; },
};
class MarkdownRenderChild {
  constructor(containerEl) { this.containerEl = containerEl; this._registered = []; }
  register(disposer) { this._registered.push(disposer); }
  unload() { for (const disposer of this._registered.splice(0).reverse()) disposer(); this.onunload?.(); }
  onunload() {}
}
class ItemView {
  constructor(leaf = {}) { this.leaf = leaf; this.app = leaf.app ?? {}; this.contentEl = createElement('div'); }
  registerEvent(eventRef) { return eventRef; }
}
function setIcon(element, icon) { if (element?.dataset) element.dataset.icon = icon; }
function getAllTags(cache) { return Array.isArray(cache?.tags) ? cache.tags.map((entry) => entry.tag).filter(Boolean) : []; }
function parseYaml(yaml) {
  const result = {};
  for (const line of String(yaml).split(/\r?\n/u)) {
    if (!line.trim() || /^\s*#/u.test(line)) continue;
    const match = line.match(/^([^:#][^:]*):\s*(.*)$/u);
    if (!match) continue;
    const key = match[1].trim();
    const raw = match[2].trim();
    if (raw === 'true' || raw === 'false') result[key] = raw === 'true';
    else if (raw === 'null' || raw === '~') result[key] = null;
    else if (/^-?\d+(?:\.\d+)?$/u.test(raw)) result[key] = Number(raw);
    else if (raw.startsWith('[') && raw.endsWith(']')) {
      try { result[key] = JSON.parse(raw); } catch { result[key] = raw.slice(1, -1).split(',').map((value) => value.trim()).filter(Boolean); }
    } else if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
      result[key] = raw.startsWith('"') ? JSON.parse(raw) : raw.slice(1, -1).replace(/''/gu, "'");
    } else result[key] = raw;
  }
  return result;
}
const Platform = { isPhone: false, isTablet: false, isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false, isMacOS: false, isWin: false, isLinux: false };
function debounce(callback, timeout = 0, resetTimer = true) {
  let timer = null;
  let lastArgs;
  let lastThis;
  const invoke = () => {
    timer = null;
    const args = lastArgs;
    lastArgs = undefined;
    callback.apply(lastThis, args ?? []);
  };
  const wrapped = function (...args) {
    lastArgs = args;
    lastThis = this;
    if (timer !== null && !resetTimer) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(invoke, timeout);
  };
  wrapped.cancel = () => { if (timer !== null) clearTimeout(timer); timer = null; lastArgs = undefined; };
  wrapped.run = () => { if (timer !== null) clearTimeout(timer); if (lastArgs) invoke(); };
  return wrapped;
}

module.exports = {
  moment, normalizePath, TAbstractFile, TFile, TFolder, Notice, Plugin, PluginSettingTab, Setting,
  Modal, SuggestModal, FuzzySuggestModal, EditorSuggest, Menu, MarkdownRenderer, MarkdownRenderChild,
  ItemView, setIcon, getAllTags, parseYaml, debounce, Platform, createElement,
};
