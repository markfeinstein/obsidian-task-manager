import test from 'node:test';
import assert from 'node:assert/strict';
import type { Component, MarkdownPostProcessorContext } from 'obsidian';
import { DashboardMarkdownRenderer, type WidgetDisposer, type WidgetRenderContext } from '../src/dashboard';
import type { DashboardLayout, DashboardWidgetConfig } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/types';
import { FakeDOMElement } from './test-utils';

class DashboardTestElement extends FakeDOMElement {
  clientWidth = 900;
  hidden = false;
  override style: Record<string, unknown> & {
    setProperty: (name: string, value: string) => void;
    removeProperty: (name: string) => void;
  } = {
    setProperty: (name: string, value: string) => { this.style[name] = value; },
    removeProperty: (name: string) => { delete this.style[name]; },
  };

  get parentElement(): DashboardTestElement | null {
    return this.parent as DashboardTestElement | null;
  }

  override createDiv(opts?: string | { cls?: string; text?: string }): DashboardTestElement {
    const element = new DashboardTestElement('div');
    if (typeof opts === 'string') element.addClass(...opts.split(' '));
    else {
      if (opts?.cls) element.addClass(...opts.cls.split(' '));
      if (opts?.text) element.setText(opts.text);
    }
    this.appendChild(element);
    return element;
  }

  createSpan(opts?: string | { cls?: string; text?: string }): DashboardTestElement {
    const normalized = typeof opts === 'string' ? { cls: opts } : opts;
    return this.createEl('span', normalized);
  }

  override createEl(tag: string, opts?: { cls?: string; text?: string; type?: string }): DashboardTestElement {
    const element = new DashboardTestElement(tag);
    if (opts?.cls) element.addClass(...opts.cls.split(' '));
    if (opts?.text) element.setText(opts.text);
    if (opts?.type) element.setAttr('type', opts.type);
    this.appendChild(element);
    return element;
  }

  hide(): void { this.hidden = true; }
  show(): void { this.hidden = false; }
  closest(): null { return null; }
}

interface TestCard {
  config: DashboardWidgetConfig;
  renderBody(): Promise<void>;
}

interface RendererInternals {
  registry: {
    register(type: DashboardWidgetConfig['type'], renderer: {
      title: string;
      icon: string;
      render: (container: HTMLElement, config: DashboardWidgetConfig, context: WidgetRenderContext) => Promise<WidgetDisposer> | WidgetDisposer;
    }): void;
  };
  disposers: WeakMap<HTMLElement, Set<WidgetDisposer>>;
  generations: WeakMap<HTMLElement, number>;
  createEmbeddedCard: (...args: unknown[]) => TestCard;
}

function createRenderer(): { renderer: DashboardMarkdownRenderer; internals: RendererInternals; metrics: { scans: number } } {
  const metrics = { scans: 0 };
  const app = {
    vault: {
      getMarkdownFiles: () => {
        metrics.scans += 1;
        return [];
      },
      getAbstractFileByPath: () => null,
    },
    metadataCache: { getFileCache: () => null },
  };
  const renderer = new DashboardMarkdownRenderer({
    app: app as never,
    scanner: { scanFile: async () => [] } as never,
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
  });
  return { renderer, internals: renderer as unknown as RendererInternals, metrics };
}

function layoutSource(): string {
  const now = Date.now();
  const layout: DashboardLayout = {
    id: 'lifecycle-test',
    name: 'Lifecycle test',
    createdAt: now,
    updatedAt: now,
    widgets: [
      { type: 'today', title: 'First', size: 'small' },
      { type: 'agenda', title: 'Second', size: 'small' },
    ],
  };
  return JSON.stringify(layout);
}

function captureCards(internals: RendererInternals): TestCard[] {
  const cards: TestCard[] = [];
  const createCard = internals.createEmbeddedCard;
  internals.createEmbeddedCard = function (...args: unknown[]): TestCard {
    const card = createCard.apply(this, args);
    cards.push(card);
    return card;
  };
  return cards;
}

function activeCount(internals: RendererInternals, container: DashboardTestElement): number {
  return internals.disposers.get(container as unknown as HTMLElement)?.size ?? 0;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test('Markdown dashboard tracks every live card disposer across card and container rerenders and errors', async () => {
  const { renderer, internals } = createRenderer();
  const container = new DashboardTestElement();
  const cards = captureCards(internals);
  const calls: Array<{ widget: string; disposed: number }> = [];

  for (const type of ['today', 'agenda'] as const) {
    internals.registry.register(type, {
      title: type,
      icon: 'circle',
      render: () => {
        const call = { widget: type, disposed: 0 };
        calls.push(call);
        return () => { call.disposed += 1; };
      },
    });
  }

  await renderer.renderDashboard(layoutSource(), container as unknown as HTMLElement);
  await settle();
  assert.equal(activeCount(internals, container), 2);

  await cards[0].renderBody();
  await cards[0].renderBody();
  assert.equal(activeCount(internals, container), 2, 'one card rerender replaces only its own tracked disposer');
  assert.deepEqual(calls.slice(0, 3).map((call) => call.disposed), [1, 0, 1]);

  await renderer.renderDashboard(layoutSource(), container as unknown as HTMLElement);
  await settle();
  assert.equal(activeCount(internals, container), 2);
  await renderer.renderDashboard(layoutSource(), container as unknown as HTMLElement);
  await settle();
  assert.equal(activeCount(internals, container), 2);

  await renderer.renderDashboard('{ invalid json', container as unknown as HTMLElement);
  assert.equal(activeCount(internals, container), 0, 'error rendering removes the container active entry');
  assert.equal(internals.disposers.has(container as unknown as HTMLElement), false);
  assert.ok(calls.length >= 7);
  assert.ok(calls.every((call) => call.disposed === 1), 'every created disposer runs exactly once');
});

test('Markdown render child unload disposes all widgets exactly once and clears the active entry', async () => {
  const { renderer, internals } = createRenderer();
  const container = new DashboardTestElement();
  const disposeCounts: number[] = [];
  const children: Array<Component & { onunload?: () => void }> = [];

  for (const type of ['today', 'agenda'] as const) {
    internals.registry.register(type, {
      title: type,
      icon: 'circle',
      render: () => {
        const index = disposeCounts.push(0) - 1;
        return () => { disposeCounts[index] += 1; };
      },
    });
  }

  const context = {
    sourcePath: 'Dashboard.md',
    addChild: (child: Component) => { children.push(child as Component & { onunload?: () => void }); },
  } as unknown as MarkdownPostProcessorContext;
  await renderer.renderDashboard(layoutSource(), container as unknown as HTMLElement, context);
  await settle();
  assert.equal(children.length, 1);
  assert.equal(activeCount(internals, container), 2);

  children[0].onunload?.();
  children[0].onunload?.();
  assert.equal(activeCount(internals, container), 0);
  assert.equal(internals.disposers.has(container as unknown as HTMLElement), false);
  assert.deepEqual(disposeCounts, [1, 1]);
});

test('obsolete requestRefresh callback cannot supersede or rescan after a newer render', async () => {
  const { renderer, internals, metrics } = createRenderer();
  const container = new DashboardTestElement();
  const refreshes: Array<() => void> = [];
  const disposeCounts: number[] = [];
  let renders = 0;

  for (const type of ['today', 'agenda'] as const) {
    internals.registry.register(type, {
      title: type,
      icon: 'circle',
      render: (_body, _config, context) => {
        renders += 1;
        refreshes.push(context.requestRefresh);
        const index = disposeCounts.push(0) - 1;
        return () => { disposeCounts[index] += 1; };
      },
    });
  }

  await renderer.renderDashboard(layoutSource(), container as unknown as HTMLElement);
  await settle();
  const staleRefresh = refreshes[0];
  assert.ok(staleRefresh);
  assert.equal(metrics.scans, 1);
  assert.equal(renders, 2);

  await renderer.renderDashboard(layoutSource(), container as unknown as HTMLElement);
  await settle();
  const currentGeneration = internals.generations.get(container as unknown as HTMLElement);
  assert.equal(metrics.scans, 2);
  assert.equal(renders, 4);
  assert.deepEqual(disposeCounts, [1, 1, 0, 0]);
  assert.equal(activeCount(internals, container), 2);

  staleRefresh();
  await settle();
  assert.equal(internals.generations.get(container as unknown as HTMLElement), currentGeneration);
  assert.equal(metrics.scans, 2, 'stale refresh must return before scanning');
  assert.equal(renders, 4, 'stale refresh must not render widgets');
  assert.deepEqual(disposeCounts, [1, 1, 0, 0], 'stale refresh must not dispose current widgets');
  assert.equal(activeCount(internals, container), 2);

  renderer.dispose(container as unknown as HTMLElement);
  assert.deepEqual(disposeCounts, [1, 1, 1, 1]);
  assert.equal(internals.disposers.has(container as unknown as HTMLElement), false);
});

test('obsolete requestRefresh callback cannot restart rendering after Markdown unload', async () => {
  const { renderer, internals, metrics } = createRenderer();
  const container = new DashboardTestElement();
  const refreshes: Array<() => void> = [];
  const disposeCounts: number[] = [];
  const children: Array<Component & { onunload?: () => void }> = [];
  let renders = 0;

  for (const type of ['today', 'agenda'] as const) {
    internals.registry.register(type, {
      title: type,
      icon: 'circle',
      render: (_body, _config, context) => {
        renders += 1;
        refreshes.push(context.requestRefresh);
        const index = disposeCounts.push(0) - 1;
        return () => { disposeCounts[index] += 1; };
      },
    });
  }

  const context = {
    sourcePath: 'Dashboard.md',
    addChild: (child: Component) => { children.push(child as Component & { onunload?: () => void }); },
  } as unknown as MarkdownPostProcessorContext;
  await renderer.renderDashboard(layoutSource(), container as unknown as HTMLElement, context);
  await settle();
  const staleRefresh = refreshes[0];
  assert.ok(staleRefresh);
  assert.equal(metrics.scans, 1);
  assert.equal(renders, 2);
  assert.equal(activeCount(internals, container), 2);

  children[0].onunload?.();
  const unloadedGeneration = internals.generations.get(container as unknown as HTMLElement);
  assert.deepEqual(disposeCounts, [1, 1]);
  assert.equal(activeCount(internals, container), 0);

  staleRefresh();
  await settle();
  assert.equal(internals.generations.get(container as unknown as HTMLElement), unloadedGeneration);
  assert.equal(metrics.scans, 1, 'stale refresh must return before scanning after unload');
  assert.equal(renders, 2, 'stale refresh must not render after unload');
  assert.deepEqual(disposeCounts, [1, 1]);
  assert.equal(internals.disposers.has(container as unknown as HTMLElement), false);
});

test('late async card completion is disposed immediately and cannot register into newer content', async () => {
  const { renderer, internals } = createRenderer();
  const container = new DashboardTestElement();
  const cards = captureCards(internals);
  const pending: Array<(dispose: WidgetDisposer) => void> = [];
  let agendaDisposals = 0;
  let staleDisposals = 0;
  let currentDisposals = 0;

  internals.registry.register('today', {
    title: 'today',
    icon: 'circle',
    render: () => new Promise<WidgetDisposer>((resolve) => { pending.push(resolve); }),
  });
  internals.registry.register('agenda', {
    title: 'agenda',
    icon: 'circle',
    render: () => () => { agendaDisposals += 1; },
  });

  await renderer.renderDashboard(layoutSource(), container as unknown as HTMLElement);
  await settle();
  assert.equal(activeCount(internals, container), 1);
  assert.equal(pending.length, 1);

  const currentRender = cards[0].renderBody();
  assert.equal(pending.length, 2);
  pending[0](() => { staleDisposals += 1; });
  await settle();
  assert.equal(staleDisposals, 1);
  assert.equal(activeCount(internals, container), 1, 'obsolete completion is never added to the active set');

  pending[1](() => { currentDisposals += 1; });
  await currentRender;
  assert.equal(activeCount(internals, container), 2);

  renderer.dispose(container as unknown as HTMLElement);
  renderer.dispose(container as unknown as HTMLElement);
  assert.equal(activeCount(internals, container), 0);
  assert.equal(internals.disposers.has(container as unknown as HTMLElement), false);
  assert.equal(staleDisposals, 1);
  assert.equal(currentDisposals, 1);
  assert.equal(agendaDisposals, 1);
});
