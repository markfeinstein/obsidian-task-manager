#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, launched, connectReady, focusMain, trustGeneratedPlugin, openNote, command, fill, click, screenshot, quitOwned } from './obsidian-desktop-smoke.mjs';
import { canonical, contained, delay, digest, disabledFeatures, validateSession, waitFor } from './obsidian-cdp.mjs';
import { SAMPLE_DATE_ANCHOR } from './seed-sample-vault.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = (file, data) => fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
export const configurations = Object.freeze([
  { id: 'native-compact-light', theme: 'native', density: 'compact', appearance: 'light' },
  { id: 'native-comfortable-light', theme: 'native', density: 'comfortable', appearance: 'light' },
  { id: 'native-spacious-light', theme: 'native', density: 'spacious', appearance: 'light' },
  { id: 'command-center-comfortable-light', theme: 'command-center', density: 'comfortable', appearance: 'light' },
  { id: 'minimal-comfortable-light', theme: 'minimal', density: 'comfortable', appearance: 'light' },
  { id: 'native-comfortable-dark', theme: 'native', density: 'comfortable', appearance: 'dark' },
]);
export const templates = Object.freeze(['default', 'focus', 'planning', 'review', 'analytics', 'project', 'team']);
const view = "app.workspace.getLeavesOfType('task-manager-dashboard')[0]?.view";
const visible = selector => `[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.checkVisibility())`;
const unique = selector => `(()=>{const a=${visible(selector)};if(a.length!==1)throw Error('Expected one visible visual control');return a[0];})()`;

async function markdownInventory(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('Special fixture path.');
      if (entry.isDirectory()) { if (entry.name !== '.obsidian') await walk(file); }
      else if (entry.name.endsWith('.md')) files.push(path.relative(root, file));
    }
  }
  await walk(root); return files.sort();
}
export async function prepareVisual(options) {
  if (!['normal', 'empty', 'dense'].includes(options.family)) throw new Error('Choose normal, empty, or dense fixture family.');
  const result = await prepare(options);
  const session = JSON.parse(await fs.readFile(result.session, 'utf8'));
  const dateDelta = (Date.parse(`${session.today}T00:00:00Z`) - Date.parse(`${SAMPLE_DATE_ANCHOR}T00:00:00Z`)) / 86_400_000;
  if (options.family !== 'empty') {
    const source = path.join(repository, 'sample-vault');
    for (const name of await markdownInventory(source)) {
      const file = path.join(source, name); await canonical(file);
      const content = (await fs.readFile(file, 'utf8')).replace(/\b\d{4}-\d{2}-\d{2}\b/gu, match => {
        const date = new Date(`${match}T00:00:00Z`);
        if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match) return match;
        date.setUTCDate(date.getUTCDate() + dateDelta); return date.toISOString().slice(0, 10);
      });
      const target = path.join(session.vault, name.replace(SAMPLE_DATE_ANCHOR, session.today));
      if (!contained(session.vault, target)) throw new Error('Escaped sample fixture.');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, { flag: 'wx' });
    }
  } else {
    // Only the just-generated, never-launched fixture is changed. Original seven-note backups remain intact.
    await fs.writeFile(path.join(session.vault, 'Tasks.md'), '---\nsmoke_fixture: generated\n---\n# Empty visual fixture\n\n[[Destination]]\n');
    await fs.writeFile(path.join(session.vault, 'Recovery.md'), '# Empty recovery fixture\n');
    for (const name of ['Tasks.md', 'Recovery.md']) session.fixtureHashes[name] = digest(await fs.readFile(path.join(session.vault, name)));
  }
  const extras = {
    'Visual Dashboard.md': '# Embedded dashboard\n\n```task-manager-dashboard\n```\n',
    'Visual Widget.md': '# Standalone agenda\n\n```task-manager-widget\ntype: agenda\n```\n',
    'Visual Error.md': '# Expected invalid dashboard\n\n```task-manager-dashboard\n{this is not JSON}\n```\n',
    'Visual Widget Error.md': '# Expected invalid widget\n\n```task-manager-widget\ntype: not-a-widget\n```\n',
    'Visual Capture.md': '# Capture to query\n\n```task-list\nnot done\npath includes Inbox.md\nshow stats\nlimit 10\n```\n',
  };
  if (options.family === 'dense') extras['Visual Dense.md'] = '# Dense synthetic tasks\n\n' + Array.from({ length: 120 }, (_, i) => `- [ ] Dense task ${String(i + 1).padStart(3, '0')} — synthetic workload #visual/dense 📅 ${session.today}`).join('\n') + '\n';
  for (const [name, content] of Object.entries(extras)) await fs.writeFile(path.join(session.vault, name), content, { flag: 'wx' });
  const notes = await markdownInventory(session.vault);
  const backup = path.join(session.folder, 'visual-initial-notes'); await fs.mkdir(backup);
  const noteHashes = {};
  for (const name of notes) {
    const bytes = await fs.readFile(path.join(session.vault, name)); noteHashes[name] = digest(bytes);
    await fs.mkdir(path.dirname(path.join(backup, name)), { recursive: true });
    await fs.writeFile(path.join(backup, name), bytes, { flag: 'wx' });
  }
  session.purpose = 'visual';
  session.visual = { family: options.family, expectedTasks: options.family === 'empty' ? 0 : options.family === 'dense' ? 182 : 62, noteHashes, backup: 'visual-initial-notes' };
  await fs.writeFile(result.session, `${JSON.stringify(session, null, 2)}\n`);
  await json(path.join(session.folder, 'visual-mutation-plan.json'), {
    syntheticOnly: true, family: options.family, createsOrEdits: ['Inbox.md (one capture in normal family)', '.obsidian/plugin settings and generated dashboard layouts'],
    initialNoteInventory: noteHashes, backup: 'visual-initial-notes', externalFeatures: 'all disabled',
    scope: 'Real renderer/configuration matrix, not personal-vault operations, real touch, independent accessibility or provider acceptance.',
  });
  return { ...result, family: options.family, expectedTasks: session.visual.expectedTasks };
}
export async function validateVisual(file, initial = false) {
  const session = await validateSession(file, { initial });
  if (session.purpose !== 'visual' || !['normal', 'empty', 'dense'].includes(session.visual?.family)) throw new Error('Expected a generated visual session.');
  if (initial) for (const [name, hash] of Object.entries(session.visual.noteHashes)) {
    const note = path.join(session.vault, name);
    if (!contained(session.vault, note) || name.split(/[\\/]/u).includes('..')) throw new Error('Unsafe visual note.');
    await canonical(note);
    if (digest(await fs.readFile(note)) !== hash) throw new Error(`Visual initial note changed: ${name}`);
  }
  return session;
}
async function key(client, key, code, extra = {}) {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, ...extra });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
}
async function settle(client) {
  await client.evaluate('(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()');
  await delay(180);
}
async function configure(client, config) {
  await client.evaluate(`(async()=>{await app.changeTheme(${JSON.stringify(config.appearance === 'light' ? 'moonstone' : 'obsidian')});const p=app.plugins.plugins['task-manager'];p.settings.dashboardTheme=${JSON.stringify(config.theme)};p.settings.dashboardDensity=${JSON.stringify(config.density)};await p.saveSettings();const v=${view};if(v){v.renderShell();await v.refreshData({live:true});}return true;})()`);
  await settle(client);
  if (!await client.evaluate(`document.body.classList.contains(${JSON.stringify(`theme-${config.appearance}`)})`)) throw new Error('Host appearance did not change.');
}
async function dashboard(client) {
  await command(client, 'task-manager:open-dashboard');
  await client.evaluate(`(()=>{const leaves=app.workspace.getLeavesOfType('task-manager-dashboard');if(leaves.length!==1)throw Error('Ambiguous dashboard leaf');app.workspace.setActiveLeaf(leaves[0],{focus:true});return true;})()`);
  await waitFor(() => client.evaluate(`Boolean(${view}?.loaded)`), 'real dashboard');
  await settle(client);
}
async function metrics(client, embedded = false) {
  return client.evaluate(`(()=>{const v=${embedded ? 'null' : view};const root=${embedded ? "app.workspace.activeLeaf?.view.containerEl.querySelector('.markdown-preview-view .tm-dash')" : "v?.contentEl"};if(!root)throw Error('Missing real rendered dashboard');const cards=[...root.querySelectorAll('.tm-dash-card')];const boxes=cards.map(e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};});const overlaps=[];for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const a=boxes[i],b=boxes[j];if(Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)>1&&Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)>1)overlaps.push([i,j]);}const grid=root.querySelector('.tm-dash-grid');return{cardOverflow:cards.map((e,i)=>{const b=e.querySelector('.tm-dash-card-body');return{type:v?.layout.widgets[i]?.type??null,scroll:b?b.scrollHeight-b.clientHeight:0,height:e.getBoundingClientRect().height};}),modal:document.querySelector('.tm-dash-template-picker-modal,.tm-dash-widget-picker-modal')?{templateOptions:document.querySelectorAll('.tm-dash-template-option').length,widgetOptions:document.querySelectorAll('.tm-dash-widget-option').length,emptySearch:Boolean(document.querySelector('.tm-dash-widget-picker-empty'))}:null,classes:root.className,cards:cards.length,titles:cards.map(e=>e.querySelector('.tm-dash-card-title')?.textContent),heroCount:v?.layout.widgets.filter(w=>w.presentation==='hero').length??null,overlaps,gridHorizontalOverflow:grid?Math.max(0,grid.scrollWidth-grid.clientWidth,grid.getBoundingClientRect().right-root.getBoundingClientRect().right):0,displayCols:v?.displayCols??null,stacked:v?.stacked??null,emptyMessages:root.querySelectorAll('.tm-dash-empty').length,loading:root.querySelectorAll('.tm-dash-loading').length,svg:root.querySelectorAll('svg').length,appearance:document.body.classList.contains('theme-dark')?'dark':'light',viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},coarsePointer:matchMedia('(pointer:coarse)').matches};})()`);
}
export async function runVisual(session) {
  await json(path.join(session.folder, 'visual-run-attempt.json'), { at: new Date().toISOString(), sourceContentIdentity: session.sourceContentIdentity });
  const report = { schemaVersion: 1, status: 'partial', family: session.visual.family, version: session.version,
    sourceContentIdentity: session.sourceContentIdentity, pluginHashes: session.pluginHashes, startedAt: new Date().toISOString(),
    syntheticOnly: true, independentReview: false, realMobileDevice: false, liveProviders: false, osReminderDelivery: false,
    configurationMethod: 'Real host theme API and persisted plugin settings; actual dashboard renderer and picker/control events. Native macOS context menus are outside page CDP: the real template-modal entry point is invoked directly, then actual template buttons are clicked. No mocked task arrays or injected visual DOM.',
    focusEmulation: true, cases: [], artifacts: [], diagnostics: [] };
  const controllerFolder = path.join(session.folder, 'controller-snapshot'); await fs.mkdir(controllerFolder);
  report.controllerHashes = {};
  for (const name of ['obsidian-desktop-visual.mjs', 'obsidian-desktop-smoke.mjs', 'obsidian-cdp.mjs', 'seed-sample-vault.mjs']) {
    const bytes = await fs.readFile(path.join(repository, 'scripts', name)); report.controllerHashes[name] = digest(bytes);
    await fs.writeFile(path.join(controllerFolder, name), bytes, { flag: 'wx' });
  }
  const until = Date.now() + 600_000; let client;
  async function capture(id, category, config, extra = {}) {
    if (Date.now() > until) throw new Error('Visual run deadline exceeded.');
    await settle(client);
    await waitFor(() => client.evaluate(`${visible('.notice')}.length===0`), 'native notices to expire without hiding them', 10_000);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 80 });
    const measured = category === 'error' ? { expectedError: await client.evaluate(`app.workspace.activeLeaf.view.containerEl.querySelectorAll('.markdown-preview-view .tm-dash-embedded-error').length`) } : await metrics(client, category === 'embed');
    if (category !== 'error' && (!measured.classes.includes(`tm-dash-theme-${config.theme}`) || !measured.classes.includes(`tm-dash-density-${config.density}`))) throw new Error('Configured appearance classes missing.');
    if (measured.overlaps?.length || measured.gridHorizontalOverflow > 2 || measured.loading) throw new Error(`Layout mismatch in ${id}: ${JSON.stringify(measured)}`);
    if (category === 'focus-state' && measured.cardOverflow.some(card => card.type === 'quick-capture' && card.scroll > 2)) throw new Error('Expanded quick-action controls are clipped.');
    if (category === 'template' && measured.heroCount !== 1) throw new Error(`Expected one authored hero in ${id}`);
    if (category === 'error' && measured.expectedError !== 1) throw new Error('Expected handled embed error.');
    const image = await screenshot(client, session.folder, `${id}.png`);
    const receipt = { id, category, config, ...extra, measured, image, status: 'passed' };
    report.cases.push(receipt); await json(path.join(session.folder, `${id}.json`), receipt);
    console.log(JSON.stringify({ case: id, status: 'passed' }));
  }
  async function switchLayout(id) {
    await client.evaluate(`(()=>{const e=document.querySelector('.tm-dash-dashboard-select');if(!e)throw Error('Missing actual dashboard switcher');e.value=${JSON.stringify(id)};e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`); await settle(client);
  }
  try {
    client = await connectReady(session); await client.send('Runtime.enable');
    await trustGeneratedPlugin(client, session);
    await waitFor(() => client.evaluate(`app.plugins.plugins['task-manager']?.apiV1?.isTaskIndexReady()&&app.plugins.plugins['task-manager'].apiV1.getAllTasks().length===${session.visual.expectedTasks}`), 'exact visual task index', 20_000);
    await waitFor(() => client.evaluate(`app.vault.getMarkdownFiles().length===${Object.keys(session.visual.noteHashes).length}&&app.vault.getMarkdownFiles().every(f=>Boolean(app.metadataCache.getFileCache(f)))`), 'exact visual file and metadata caches', 20_000);
    report.host = await client.evaluate('({installer:remote.app.getVersion(),electron:remote.process.versions.electron,chrome:remote.process.versions.chrome,platform:remote.process.platform,arch:remote.process.arch,enabled:[...app.plugins.enabledPlugins]})');
    if (report.host.installer !== session.version || report.host.enabled.join(',') !== 'task-manager') throw new Error('Unexpected visual host/plugin.');
    await focusMain(client, session);
    await client.evaluate('(()=>{app.workspace.leftSplit.collapse();app.workspace.rightSplit.collapse();return true;})()');
    await dashboard(client);
    const baseId = await client.evaluate(`${view}.layout.id`);
    const layouts = { default: baseId };
    if (session.visual.family === 'normal') {
      for (const template of templates.slice(1)) {
        // macOS native context menus are outside page CDP; invoke their real modal entry point.
        await client.evaluate(`(()=>{${view}.openTemplatePicker();return true;})()`);
        await waitFor(() => client.evaluate(`${visible('.tm-dash-template-option')}.length===7`), 'seven real template options');
        const names = { focus: 'Focus flow', planning: 'Planning studio', review: 'Review ritual', analytics: 'Analytics lab', project: 'Project control', team: 'Team handoff' };
        await click(client, `(()=>{const r=${visible('.tm-dash-template-option')}.find(e=>e.querySelector('.tm-dash-template-name')?.textContent===${JSON.stringify(names[template])});if(!r)throw Error('Missing built-in template');return r.querySelector('button');})()`);
        await settle(client); layouts[template] = await client.evaluate(`${view}.layout.id`);
      }
    }
    for (const config of configurations) {
      await dashboard(client); await switchLayout(baseId); await configure(client, config);
      if (session.visual.family !== 'normal') {
        await capture(`${session.visual.family}-${config.id}`, 'data-state', config, { indexedTasks: session.visual.expectedTasks }); continue;
      }
      for (const template of templates) { await switchLayout(layouts[template]); await capture(`template-${template}-${config.id}`, 'template', config); }
      await switchLayout(baseId);
      await client.evaluate(`(()=>{${view}.openTemplatePicker();return true;})()`);
      await capture(`picker-template-${config.id}`, 'picker', config, { options: 7, searchSupported: false }); await key(client, 'Escape', 'Escape');
      await click(client, unique('.tm-dash-edit-toggle')); await capture(`state-edit-${config.id}`, 'edit-state', config);
      await click(client, unique('.tm-dash-add')); await capture(`picker-widget-${config.id}`, 'picker', config);
      await fill(client, '.tm-dash-widget-picker-input', 'calendar'); await capture(`picker-search-${config.id}`, 'picker', config);
      await fill(client, '.tm-dash-widget-picker-input', '__no_matching_synthetic_widget__');
      if (!await client.evaluate(`Boolean(document.querySelector('.tm-dash-widget-picker-empty'))`)) throw new Error('Missing empty search state.');
      await capture(`picker-empty-${config.id}`, 'picker', config); await key(client, 'Escape', 'Escape');
      await click(client, unique('.tm-dash-edit-toggle'));
      await click(client, `document.querySelector('.tm-dash-card [aria-label="Collapse widget"]')`);
      await capture(`state-collapsed-${config.id}`, 'collapsed-state', config);
      await click(client, `document.querySelector('.tm-dash-card [aria-label="Expand widget"]')`);
      await key(client, 'Tab', 'Tab'); await client.evaluate('(()=>{const b=document.querySelector(".tm-dash-card [aria-label=\\"Collapse widget\\"]");b.focus();return true;})()');
      await capture(`state-focus-${config.id}`, 'focus-state', config);
      for (const width of [900, 560]) {
        await client.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
        await capture(`responsive-${width}-${config.id}`, 'responsive', config, { width, realMobileDevice: false });
      }
      await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await capture(`responsive-coarse-${config.id}`, 'responsive', config, { coarseEmulation: true, realTouchAcceptance: false });
      await client.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      for (const [file, name, category] of [['Visual Dashboard.md', 'dashboard', 'embed'], ['Visual Widget.md', 'widget', 'embed'], ['Visual Error.md', 'dashboard', 'error'], ['Visual Widget Error.md', 'widget', 'error']]) {
        await openNote(client, file); await capture(`${category}-${name}-${config.id}`, category, config);
      }
      await dashboard(client);
      await client.evaluate(`(()=>{${view}.createBlankDashboard('Visual empty board');return true;})()`);
      await capture(`state-blank-${config.id}`, 'blank-dashboard', config);
      await switchLayout(baseId);
    }
    if (session.visual.family === 'normal') {
      await configure(client, configurations[1]); await openNote(client, 'Visual Capture.md');
      const frames = path.join(session.folder, 'animation-frames'); await fs.mkdir(frames);
      const timeline = []; let stop = false;
      const recording = (async () => { while (!stop) { const startedMs = performance.now(); const image = await screenshot(client, frames, `frame-${String(timeline.length).padStart(4, '0')}.png`); timeline.push({ startedMs, ...image }); await delay(120); } })();
      try {
        await delay(600); await command(client, 'task-manager:quick-capture-task'); await delay(600);
        await fill(client, '.modal-content .setting-item:first-of-type input[type="text"]', 'Plan the release walkthrough'); await delay(800);
        await click(client, unique('.modal-content button.mod-cta'));
        await waitFor(() => client.evaluate(`${visible('.task-manager-query-item')}.filter(e=>e.textContent.includes('Plan the release walkthrough')).length===1`), 'actual captured query row');
        const content = await fs.readFile(path.join(session.vault, 'Inbox.md'), 'utf8'); if (content.split('Plan the release walkthrough').length !== 2) throw new Error('Animation capture did not persist once.');
        await delay(1200);
      } finally { stop = true; await recording; }
      report.animation = { status: 'passed', unretouchedFrames: true, realControlJourney: true, title: 'Plan the release walkthrough', persistedOnce: true, timeline: timeline.map(t => ({ ...t, startedMs: Math.round((t.startedMs - timeline[0].startedMs) * 1000) / 1000 })) };
      await json(path.join(session.folder, 'animation-timeline.json'), report.animation);
    }
    const safe = await client.evaluate(`(()=>{const p=app.plugins.plugins['task-manager'];if(${JSON.stringify(disabledFeatures)}.some(k=>p.settings[k]!==false))throw Error('Unsafe visual feature');return true;})()`);
    report.safetyPreserved = safe; report.diagnostics = client.diagnostics;
    if (report.diagnostics.length) throw new Error('Unexpected visual runtime exception.');
    const expectedCases = session.visual.family === 'normal' ? 132 : 6;
    if (report.cases.length !== expectedCases) throw new Error(`Expected ${expectedCases} visual cases; got ${report.cases.length}.`);
    await client.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await client.send('Emulation.clearDeviceMetricsOverride');
    await quitOwned(client, session); report.status = 'passed'; report.completedAt = new Date().toISOString();
    await json(path.join(session.folder, 'visual-report.json'), report);
    return { folder: session.folder, status: report.status, cases: report.cases.length };
  } catch (error) {
    report.error = error.message; report.diagnostics = client?.diagnostics ?? [];
    try { report.artifacts.push(await screenshot(client, session.folder, 'visual-failure.png')); } catch { /* Preserve original failure. */ }
    try { await client.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await client.send('Emulation.clearDeviceMetricsOverride'); } catch { /* Unknown target state; never replay mutation. */ }
    client?.close(); await json(path.join(session.folder, 'visual-report.json'), report); throw error;
  }
}
async function main() {
  const [action, ...args] = process.argv.slice(2); const options = {};
  for (let i = 0; i < args.length; i += 2) { const key = args[i]; if (!['--app', '--version', '--parent', '--family', '--session', '--allow-runtime'].includes(key) || Object.hasOwn(options, key)) throw new Error('Unknown/duplicate visual option.'); if (key === '--allow-runtime') { options[key] = true; i -= 1; } else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing visual option value.'); options[key] = args[i + 1]; } }
  if (action === 'prepare') { console.log(JSON.stringify(await prepareVisual({ app: options['--app'], version: options['--version'], parent: options['--parent'], family: options['--family'] }))); return; }
  if (action !== 'run' || !options['--allow-runtime'] || !options['--session']) throw new Error('Use prepare, or run --session <exact generated session> --allow-runtime.');
  const session = await launched(await validateVisual(options['--session'], true)); console.log(JSON.stringify(await runVisual(session)));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
