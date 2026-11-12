#!/usr/bin/env node
import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSourceIdentity } from './source-identity.mjs';
import { canonical, connectObsidian, delay, digest, disabledFeatures, settingsSurface, validateSession, waitFor } from './obsidian-cdp.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function parseOptions(args) {
  const result = { action: args[0] };
  if (!['prepare', 'launch', 'run', 'quit', 'help'].includes(result.action)) throw new Error('Choose prepare, launch, run, quit, or help.');
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--allow-runtime') { if (result.allowRuntime) throw new Error('Duplicate runtime option.'); result.allowRuntime = true; }
    else if (['--app', '--version', '--parent', '--session'].includes(option)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}.`);
      if (Object.hasOwn(result, option.slice(2))) throw new Error(`Duplicate option ${option}.`);
      result[option.slice(2)] = value;
    } else throw new Error(`Unknown option ${option}.`);
  }
  if (['launch', 'run', 'quit'].includes(result.action) && (!result.allowRuntime || !result.session)) throw new Error('Runtime operations need an exact --session and explicit --allow-runtime. Coordinate the global CLI lane first.');
  return result;
}
const json = (file, data) => fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
export async function prepare({ app, version, parent }) {
  if (!app || !/^\d+\.\d+\.\d+$/u.test(version ?? '') || !parent) throw new Error('Prepare needs --app, --version, and --parent.');
  await canonical(app, true); await canonical(parent, true);
  const binary = await canonical(path.join(app, 'Contents/MacOS/Obsidian'));
  const sourceContentIdentity = computeSourceIdentity(repository).sha256;
  if (!(await fs.readFile(path.join(repository, 'main.js'), 'utf8')).includes(sourceContentIdentity)) throw new Error('Build current plugin artifacts before preparing a host fixture.');
  const folder = await fs.mkdtemp(path.join(parent, `task-manager-smoke-${version}-`));
  const vault = path.join(folder, 'Task Manager Smoke');
  const profile = path.join(folder, 'Profile');
  const plugin = path.join(vault, '.obsidian/plugins/task-manager');
  await fs.mkdir(plugin, { recursive: true }); await fs.mkdir(profile);
  const pluginHashes = {};
  for (const name of ['main.js', 'manifest.json', 'styles.css', 'versions.json']) {
    const bytes = await fs.readFile(path.join(repository, name));
    await fs.writeFile(path.join(plugin, name), bytes, { flag: 'wx' });
    pluginHashes[name] = digest(bytes);
  }
  const nonce = randomUUID(); const vaultId = digest(vault).slice(0, 16);
  await json(path.join(vault, '.task-manager-smoke.json'), { nonce, vault, syntheticOnly: true });
  await json(path.join(vault, '.obsidian/community-plugins.json'), ['task-manager']);
  await json(path.join(vault, '.obsidian/core-plugins.json'), ['file-explorer', 'global-search', 'properties', 'page-preview', 'bases']);
  await json(path.join(vault, '.obsidian/app.json'), { alwaysUpdateLinks: true, trashOption: 'local', readableLineLength: false, showInlineTitle: false });
  await json(path.join(plugin, 'data.json'), { settings: {
    ...Object.fromEntries(disabledFeatures.map(key => [key, false])),
    quickCaptureInboxPath: 'Inbox.md', enableBasesIntegration: true, basesAutoRefreshEnabled: false,
    setCreatedDate: true, setDoneDate: true, taskFormat: 'emoji', completionLoggingEnabled: false,
  } });
  await json(path.join(profile, 'obsidian.json'), { vaults: { [vaultId]: { path: vault, ts: Date.now(), open: true } }, updateDisabled: true });
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const fixtures = {
    'Inbox.md': '# Synthetic inbox\n',
    'Tasks.md': `---\nsmoke_fixture: generated\n---\n# Synthetic tasks\n\n[[Destination]]\n\n- [ ] Recurring smoke 🔁 every day 📅 ${today}\n- [ ] Reminder smoke [reminder:: ${today} 9:00]\n- [ ] Move smoke\n  details preserved\n`,
    'Destination.md': '# Synthetic destination\n',
    'Recovery.md': '# Recovery source\n\n- [ ] Recovery smoke\n  recovery detail\n',
    'Recovery Target.md': '# Recovery destination\n',
    'Smoke Query.md': '```task-list\nnot done\nshow edit button\nshow stats\nlimit 20\n```\n',
    'Smoke Table.md': '```task-list\nnot done\nview: table\nlimit 20\n```\n',
  };
  const initial = path.join(folder, 'initial-notes');
  await fs.mkdir(initial);
  const fixtureHashes = {};
  for (const [name, content] of Object.entries(fixtures)) {
    fixtureHashes[name] = digest(content);
    await fs.writeFile(path.join(vault, name), content, { flag: 'wx' });
    await fs.writeFile(path.join(initial, name), content, { flag: 'wx' });
  }
  await json(path.join(folder, 'mutation-plan.json'), { syntheticOnly: true, vault, backup: initial,
    createsOrEdits: ['Inbox.md', 'Tasks.md'], moves: [{ source: 'Tasks.md', target: 'Destination.md' }, { source: 'Recovery.md', target: 'Recovery Target.md', faultInjected: true }],
    generatedOnly: 'Task Manager Bases/', excludes: ['personal vaults', 'provider accounts', 'OS notification delivery'], recovery: 'Initial synthetic notes retained separately; do not restore over unexpected changes.' });
  const session = { schemaVersion: 1, nonce, folder, vault, profile, binary, version, vaultId, today,
    sourceContentIdentity, pluginHashes, fixtureHashes, createdAt: new Date().toISOString(), syntheticOnly: true };
  const file = path.join(folder, 'session.json'); await json(file, session);
  return { session: file, prepared: true, sourceContentIdentity: session.sourceContentIdentity };
}
function verifySignature(binary) {
  const bundle = path.resolve(binary, '../../..');
  for (const [command, args] of [['codesign', ['--verify', '--deep', '--strict', bundle]], ['spctl', ['--assess', '--type', 'execute', bundle]]]) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 });
    if (result.error || result.status !== 0) throw new Error(`App signature assessment failed: ${command}`);
  }
}
export async function launch(session, label) {
  verifySignature(session.binary);
  await json(path.join(session.folder, `${label}-attempt.json`), { at: new Date().toISOString(), binary: session.binary });
  const output = openSync(path.join(session.folder, `${label}-process.log`), 'wx');
  const args = [`--user-data-dir=${session.profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'];
  const child = spawn(session.binary, args, { detached: true, stdio: ['ignore', output, output] });
  closeSync(output);
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  const receipt = { pid: child.pid, binary: session.binary, args, at: new Date().toISOString() };
  await json(path.join(session.folder, `${label}.json`), receipt);
  return { ...session, pid: child.pid };
}
export async function launched(session, label = 'launch') {
  const receipt = JSON.parse(await fs.readFile(path.join(session.folder, `${label}.json`), 'utf8'));
  if (receipt.binary !== session.binary || !receipt.args.includes(`--user-data-dir=${session.profile}`)) throw new Error('Launch receipt mismatch.');
  return { ...session, pid: receipt.pid };
}
export async function connectReady(session) {
  const until = Date.now() + 20_000;
  let failure;
  do {
    let client;
    try { client = await connectObsidian(session); await client.evaluate('true'); return client; }
    catch (error) { client?.close(); failure = error; await delay(200); }
  } while (Date.now() < until);
  throw failure;
}
export async function focusMain(client, session) {
  await client.evaluate(`(()=>{const prefix=${JSON.stringify(`Settings - ${path.basename(session.vault)} - Obsidian `)};const windows=remote.BrowserWindow.getAllWindows().filter(w=>w.getTitle().startsWith(prefix)&&w.webContents.getURL()==='about:blank');if(windows.length>1)throw Error('Ambiguous owned Settings windows');for(const w of windows)w.close();app.setting.close();app.plugins.plugins['task-manager']?.activeOnboarding?.close();remote.getCurrentWindow().focus();return true;})()`);
  await waitFor(() => client.evaluate('activeDocument===document'), 'owned native main document');
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
}
export async function trustGeneratedPlugin(client, session) {
  await focusMain(client, session);
  let needsTrust = false;
  await waitFor(async () => {
    const state = await client.evaluate(`({ready:Boolean(app.plugins.plugins['task-manager']?.apiV1?.isTaskIndexReady()),trustPrompt:[...document.querySelectorAll('button')].filter(e=>e.checkVisibility()&&!e.disabled&&e.textContent.trim()==='Trust author and enable plugins').length})`);
    if (state.trustPrompt > 1) throw new Error('Ambiguous generated-vault trust prompt.');
    needsTrust = state.trustPrompt === 1;
    return needsTrust || state.ready;
  }, 'owned generated-plugin trust prompt or ready index', 20_000);
  if (needsTrust) {
    // Setup activation uses the actual button, not coordinates during the native modal's entrance.
    // A failed/unknown click is never retried; a new attempt needs explicit inspection/fresh fixture.
    await client.evaluate(`(()=>{const buttons=[...document.querySelectorAll('button')].filter(e=>e.checkVisibility()&&!e.disabled&&e.textContent.trim()==='Trust author and enable plugins');if(buttons.length!==1)throw Error('Expected one generated-vault trust prompt');buttons[0].click();return true;})()`);
  }
  await waitFor(() => client.evaluate('Boolean(app.plugins.plugins["task-manager"]?.apiV1?.isTaskIndexReady())'), 'Task Manager ready index', 20_000);
  const enabled = await client.evaluate('[...app.plugins.enabledPlugins]');
  if (enabled.length !== 1 || enabled[0] !== 'task-manager') throw new Error('Unexpected enabled community plugin.');
  await focusMain(client, session);
  return { enabled };
}
export async function openNote(client, file, mode = 'preview', task) {
  await client.evaluate(`(async()=>{const f=app.vault.getAbstractFileByPath(${JSON.stringify(file)});if(!f||f.extension!=='md')throw Error('Missing synthetic note');const l=app.workspace.getLeaf(false);await l.openFile(f,{active:true});await l.setViewState({type:'markdown',state:{file:f.path,mode:${JSON.stringify(mode)},source:${mode === 'source'}}});app.workspace.setActiveLeaf(l,{focus:true});${task ? `const lines=l.view.editor.getValue().split('\\n');const matches=lines.map((line,index)=>({line,index})).filter(x=>x.line.includes(${JSON.stringify(task)}));if(matches.length!==1)throw Error('Ambiguous synthetic task cursor');l.view.editor.setCursor({line:matches[0].index,ch:0});l.view.editor.focus();` : ''}return true;})()`);
  await delay(200);
}
export async function command(client, id) {
  if (!id.startsWith('task-manager:')) throw new Error('Unexpected plugin command.');
  await client.evaluate(`(()=>{if(!app.commands.executeCommandById(${JSON.stringify(id)}))throw Error('Plugin command unavailable');return true;})()`);
}
export async function fill(client, selector, value) {
  await client.evaluate(`(()=>{const matches=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.checkVisibility());if(matches.length!==1)throw Error('Expected one visible input');const e=matches[0];if(!(e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement))throw Error('Not an input');e.focus();e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
}
export async function click(client, expression) {
  const point = await client.evaluate(`(()=>{const e=(${expression});if(!e||!e.checkVisibility())throw Error('Expected visible owned control');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await client.send('Input.dispatchMouseEvent', { type, ...point, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
}
export const visibleCount = selector => `[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.checkVisibility()).length`;
const taskMatches = title => `app.plugins.plugins['task-manager'].apiV1.getAllTasks().filter(t=>t.body.includes(${JSON.stringify(title)}))`;
const ownedControl = selector => `(()=>{const controls=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.checkVisibility());if(controls.length!==1)throw Error('Expected one owned control');return controls[0];})()`;
export async function rowControl(client, title, selector) {
  const point = await client.evaluate(`(()=>{const rows=[...document.querySelectorAll('.task-manager-query-item')].filter(e=>e.checkVisibility()&&e.textContent.includes(${JSON.stringify(title)}));if(rows.length!==1)throw Error('Ambiguous synthetic hover row');rows[0].scrollIntoView({block:'center'});const r=rows[0].getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await delay(100);
  await click(client, `(()=>{const rows=[...document.querySelectorAll('.task-manager-query-item')].filter(e=>e.checkVisibility()&&e.textContent.includes(${JSON.stringify(title)}));if(rows.length!==1)throw Error('Ambiguous synthetic query row');return rows[0].querySelector(${JSON.stringify(selector)});})()`);
}
export async function screenshot(client, folder, name) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const bytes = Buffer.from(shot.data, 'base64');
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid host screenshot.');
  await fs.writeFile(path.join(folder, name), bytes, { flag: 'wx' });
  return { file: name, sha256: digest(bytes), bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
export async function quitOwned(client, session) {
  await client.evaluate('(()=>{setTimeout(()=>remote.app.quit(),100);return true;})()');
  client.close();
  await waitFor(() => { try { process.kill(session.pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }, 'exact owned process exit', 15_000);
}

export async function runSmoke(session) {
  await json(path.join(session.folder, 'run-attempt.json'), { at: new Date().toISOString(), pid: session.pid });
  let client;
  const report = { schemaVersion: 1, status: 'partial', version: session.version, sourceContentIdentity: session.sourceContentIdentity,
    pluginHashes: session.pluginHashes, startedAt: new Date().toISOString(), syntheticOnly: true, independentReview: false,
    realMobileDevice: false, liveProviders: false, osReminderDelivery: false,
    viewport: { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, focusEmulation: true,
    stages: [], artifacts: [], runtimeDiagnostics: [] };
  const until = Date.now() + 180_000;
  async function stage(name, action) {
    if (Date.now() > until) throw new Error('Desktop smoke deadline exceeded.');
    report.activeStage = name;
    const started = performance.now(); const result = await action();
    const receipt = { name, status: 'passed', durationMs: Math.round(performance.now() - started), result };
    report.stages.push(receipt);
    await json(path.join(session.folder, `stage-${String(report.stages.length).padStart(2, '0')}.json`), receipt);
    console.log(JSON.stringify({ stage: name, status: 'passed' }));
  }
  try {
    await stage('guarded debugger connection', async () => { client = await connectReady(session); return { targetId: client.targetId }; });
    await client.send('Runtime.enable');
    await stage('signed installer and exact isolated identity', async () => {
      const identity = await client.evaluate('({installer:remote.app.getVersion(),pid:remote.process.pid,profile:remote.app.getPath("userData"),vault:app.vault.adapter.getBasePath(),electron:remote.process.versions.electron,chrome:remote.process.versions.chrome})');
      if (identity.installer !== session.version) throw new Error('Unexpected installer version.');
      if ((await fs.readdir(session.profile)).some(name => /\.asar(?:\.gz)?$/u.test(name))) throw new Error('Unexpected downloaded app archive.');
      return { installer: identity.installer, electron: identity.electron, chrome: identity.chrome, pid: identity.pid, freshProfile: true, automaticUpdatesDisabled: true };
    });
    await stage('trust only generated Task Manager plugin', () => trustGeneratedPlugin(client, session));
    await stage('exact host file and metadata-cache readiness', async () => {
      await waitFor(() => client.evaluate(`(()=>{const files=app.vault.getMarkdownFiles();const f=app.vault.getAbstractFileByPath('Tasks.md');const c=app.metadataCache.getFileCache(f);return files.length===7&&files.every(f=>Boolean(app.metadataCache.getFileCache(f)))&&c?.frontmatter?.smoke_fixture==='generated'&&c.links?.some(l=>l.link==='Destination');})()`), 'seven indexed notes and frontmatter/link caches', 20_000);
      return { markdownFiles: 7, allFileCachesReady: true, frontmatterReady: true, destinationLinkReady: true };
    });
    const safe = async () => client.evaluate(`(()=>{const s=app.plugins.plugins['task-manager'].settings;const keys=${JSON.stringify(disabledFeatures)};if(keys.some(k=>s[k]!==false))throw Error('Unsafe runtime feature flag');return Object.fromEntries(keys.map(k=>[k,s[k]]));})()`);
    await stage('provider AI and notification safety', safe);
    await stage('real plain-query footer', async () => {
      await openNote(client, 'Smoke Query.md');
      await waitFor(() => client.evaluate(`${visibleCount('.task-manager-query-stats-bar')}===1`), 'actual query footer');
      const result = await client.evaluate(`({rows:${visibleCount('.task-manager-query-item')},errors:${visibleCount('.task-manager-query-error')}})`);
      if (result.rows !== 4 || result.errors) throw new Error('Initial plain query did not render four synthetic tasks.');
      return result;
    });
    await stage('quick-capture UI persists and indexes once', async () => {
      await command(client, 'task-manager:quick-capture-task');
      await waitFor(() => client.evaluate('Boolean(document.querySelector("#task-manager-quick-capture-status"))'), 'Quick capture modal');
      await fill(client, '.modal-content .setting-item:first-of-type input[type="text"]', 'Capture smoke');
      const dueSelector = await client.evaluate(`(()=>{const root=document.querySelector('#task-manager-quick-capture-status').parentElement;const fields=[...root.querySelectorAll('input[type=text]')];if(fields.length!==2)throw Error('Unexpected capture inputs');return fields[1].placeholder;})()`);
      await fill(client, `.modal-content input[placeholder=${JSON.stringify(dueSelector)}]`, 'tomorrow');
      await click(client, ownedControl('.modal-content button.mod-cta'));
      await waitFor(() => client.evaluate(`${taskMatches('Capture smoke')}.length===1`), 'captured task index');
      const content = await fs.readFile(path.join(session.vault, 'Inbox.md'), 'utf8');
      if (content.split('Capture smoke').length !== 2) throw new Error('Capture was missing or duplicated.');
      return { persistedOnce: true };
    });
    await stage('task-edit UI persists description', async () => {
      await openNote(client, 'Smoke Query.md');
      await waitFor(() => client.evaluate(`${visibleCount('.task-manager-query-item')}===5`), 'captured query row');
      await rowControl(client, 'Capture smoke', '.task-manager-query-edit');
      await waitFor(() => client.evaluate('Boolean(document.querySelector(".task-manager-modal-description"))'), 'edit modal');
      await fill(client, '.task-manager-modal-description', 'Edited smoke');
      await click(client, ownedControl('.modal-content button.mod-cta'));
      await waitFor(() => client.evaluate(`${taskMatches('Edited smoke')}.length===1&&${taskMatches('Capture smoke')}.length===0`), 'edited task index');
      return { persistedAndIndexed: true };
    });
    async function completeThroughDefaultStates(title) {
      await rowControl(client, title, '.task-manager-query-marker');
      await waitFor(() => client.evaluate(`(()=>{const rows=[...document.querySelectorAll('.task-manager-query-item')].filter(e=>e.checkVisibility()&&e.textContent.includes(${JSON.stringify(title)}));return ${taskMatches(title)}.some(t=>t.status==='in_progress')&&rows.length===1&&rows[0].getAttribute('data-task-status-type-local')==='in_progress';})()`), 'verified in-progress state before the separate completion click');
      await rowControl(client, title, '.task-manager-query-marker');
    }
    await stage('query completion persists done state', async () => {
      await completeThroughDefaultStates('Edited smoke');
      await waitFor(() => client.evaluate(`${taskMatches('Edited smoke')}.some(t=>t.status==='done')`), 'completed task');
      if (!(await fs.readFile(path.join(session.vault, 'Inbox.md'), 'utf8')).includes('- [x] Edited smoke')) throw new Error('Completion was not durable.');
      return { persistedDone: true };
    });
    await stage('recurrence completion advances active occurrence', async () => {
      await completeThroughDefaultStates('Recurring smoke');
      await waitFor(() => client.evaluate(`${taskMatches('Recurring smoke')}.some(t=>t.status!=='done'&&t.status!=='cancelled'&&t.metadata.dates.due>${JSON.stringify(session.today)})`), 'next recurring occurrence');
      return client.evaluate(`${taskMatches('Recurring smoke')}.map(t=>({status:t.status,due:t.metadata.dates.due}))`);
    });
    await stage('reminder index normalizes time without OS delivery', async () => {
      const result = await client.evaluate(`(async()=>{const p=app.plugins.plugins['task-manager'];await p.ensureReminderIndexReady();const entries=[...p.reminderIndex.entries.values()].filter(e=>e.task.body.includes('Reminder smoke'));if(p.settings.enableReminderNotifications!==false||entries.length!==1||!entries[0].fireTime.endsWith('09:00'))throw Error('Reminder normalization/index mismatch');return{fireTime:entries[0].fireTime,deliveryEnabled:false};})()`);
      return result;
    });
    async function move(source, title, target) {
      await openNote(client, source, 'source', title);
      await command(client, 'task-manager:move-task-to-file');
      await waitFor(() => client.evaluate('Boolean(document.querySelector("input[placeholder=\\"Notes/Tasks.md\\"]"))'), 'move modal');
      await fill(client, 'input[placeholder="Notes/Tasks.md"]', target);
      await click(client, '(()=>{const buttons=[...document.querySelectorAll(".modal-content button")].filter(e=>e.textContent==="Move");if(buttons.length!==1)throw Error("Expected one Move button");return buttons[0];})()');
    }
    await stage('journaled move preserves task block once', async () => {
      await move('Tasks.md', 'Move smoke', 'Destination.md');
      await waitFor(async () => !(await fs.readFile(path.join(session.vault, 'Tasks.md'), 'utf8')).includes('Move smoke'), 'durable source removal');
      const target = await fs.readFile(path.join(session.vault, 'Destination.md'), 'utf8');
      if (target.split('Move smoke').length !== 2 || !target.includes('  details preserved') || target.includes('task-manager-move:')) throw new Error('Moved task block or marker mismatch.');
      return { preservedDetails: true, duplicateCount: 0 };
    });
    await stage('plugin unload cleans owners and reloads durable state', async () => {
      const before = await client.evaluate('app.plugins.plugins["task-manager"].apiV1.getAllTasks().length');
      const cleanup = await client.evaluate(`(async()=>{const old=app.plugins.plugins['task-manager'];await app.plugins.disablePlugin('task-manager');return{removed:!app.plugins.plugins['task-manager'],inactive:old.lifecycleActive===false,remindersDisposed:old.reminderIndex===null,networkAborted:old.networkAbortController===null,scanAborted:old.scanAbortController===null,commandsRemoved:!Object.keys(app.commands.commands).some(k=>k.startsWith('task-manager:'))};})()`);
      if (Object.values(cleanup).some(value => value !== true)) throw new Error('Plugin unload left owned work active.');
      await client.evaluate('(async()=>{await app.plugins.enablePlugin("task-manager");return true;})()');
      await waitFor(() => client.evaluate(`app.plugins.plugins['task-manager']?.apiV1?.isTaskIndexReady()&&app.plugins.plugins['task-manager'].apiV1.getAllTasks().length===${before}`), 'reloaded task index');
      return cleanup;
    });
    await stage('fault-injected move retains recoverable journal', async () => {
      await client.evaluate(`(()=>{if(window.__taskManagerSmokeProcess)throw Error('Existing fault injection');window.__taskManagerSmokeProcess=app.vault.process;let targetCalls=0;app.vault.process=async function(file,...args){if(file.path==='Recovery.md'||(file.path==='Recovery Target.md'&&++targetCalls>1))throw Error('Injected synthetic smoke write failure');return window.__taskManagerSmokeProcess.call(this,file,...args);};return true;})()`);
      try {
        await move('Recovery.md', 'Recovery smoke', 'Recovery Target.md');
        await waitFor(() => client.evaluate(`(async()=>{const s=await app.plugins.plugins['task-manager'].stateStore.loadState();return(s.taskMoveJournals??[]).some(j=>j.sourcePath==='Recovery.md'&&j.phase==='reconciliation-required');})()`), 'durable recovery journal');
      } finally {
        await client.evaluate('(()=>{if(window.__taskManagerSmokeProcess){app.vault.process=window.__taskManagerSmokeProcess;delete window.__taskManagerSmokeProcess;}return true;})()');
      }
      const source = await fs.readFile(path.join(session.vault, 'Recovery.md'), 'utf8');
      const target = await fs.readFile(path.join(session.vault, 'Recovery Target.md'), 'utf8');
      if (!source.includes('Recovery smoke') || !target.includes('task-manager-move:')) throw new Error('Missing recoverable source/target evidence.');
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
      return { faultInjected: true, sourceRetained: true, targetMarked: true };
    });
    await stage('owned application restart reconciles pending move', async () => {
      report.runtimeDiagnostics.push(...client.diagnostics);
      await quitOwned(client, session);
      session = await launch(session, 'restart');
      client = await connectReady(session);
      await client.send('Runtime.enable');
      await waitFor(() => client.evaluate('Boolean(app.plugins.plugins["task-manager"]?.apiV1?.isTaskIndexReady())'), 'restart task index', 20_000);
      await focusMain(client, session);
      const state = await client.evaluate('(async()=>{const s=await app.plugins.plugins["task-manager"].stateStore.loadState();return{journals:(s.taskMoveJournals??[]).length};})()');
      const source = await fs.readFile(path.join(session.vault, 'Recovery.md'), 'utf8');
      const target = await fs.readFile(path.join(session.vault, 'Recovery Target.md'), 'utf8');
      if (state.journals !== 0 || source.split('Recovery smoke').length !== 2 || target.includes('Recovery smoke') || target.includes('task-manager-move:')) throw new Error('Restart recovery did not safely roll back the unfinalized move.');
      return { journals: 0, sourcePreservedOnce: true, targetRollback: true, restartedPid: session.pid };
    });
    await stage('generated Bases renders in the actual core view', async () => {
      await command(client, 'task-manager:export-bases-index');
      await waitFor(() => client.evaluate('app.vault.getFiles().filter(f=>f.path.startsWith("Task Manager Bases/")&&f.extension==="base").length>=4'), 'generated Bases files');
      const result = await client.evaluate(`(async()=>{const files=app.vault.getFiles().filter(f=>f.path.startsWith('Task Manager Bases/')&&f.extension==='base');const f=files.find(f=>f.basename==='Upcoming');if(!f)throw Error('Missing generated Upcoming Base');const l=app.workspace.getLeaf(false);await l.openFile(f,{active:true});app.workspace.setActiveLeaf(l,{focus:true});return{path:f.path,type:l.view.getViewType(),views:files.length};})()`);
      await waitFor(() => client.evaluate('app.workspace.activeLeaf?.view.containerEl.innerText.includes("Recurring smoke")'), 'real Bases task row');
      if (!['bases', 'base'].includes(result.type)) throw new Error('Generated Base opened as an unexpected view type.');
      report.artifacts.push(await screenshot(client, session.folder, 'bases-rendered.png'));
      return result;
    });
    await stage('actual plugin Settings in inline or native document', async () => {
      await client.evaluate('(()=>{app.setting.open();app.setting.openTabById("task-manager");return true;})()');
      await delay(300);
      const surface = await settingsSurface(session, client);
      try {
        await waitFor(() => surface.evaluate('Boolean(document.querySelector(".task-manager-settings"))'), 'actual plugin Settings controls');
        const result = await surface.evaluate('(()=>{const root=document.querySelector(".task-manager-settings");if(!root)throw Error("Actual plugin Settings did not render");return{title:document.title,rows:root.querySelectorAll(".setting-item").length,namedControls:root.querySelectorAll("input,select,button").length};})()');
        if (result.rows < 10 || result.namedControls < 10) throw new Error('Plugin Settings controls missing.');
        return result;
      } finally { surface.close(); await focusMain(client, session); }
    });
    await stage('final safety and no unexpected runtime exception', async () => {
      await safe();
      report.runtimeDiagnostics.push(...client.diagnostics);
      if (report.runtimeDiagnostics.length) throw new Error('Unexpected runtime exception; inspect retained diagnostics.');
      return { safetyPreserved: true, runtimeExceptions: 0 };
    });
    await client.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await client.send('Emulation.clearDeviceMetricsOverride');
    await quitOwned(client, session);
    report.status = 'passed'; report.completedAt = new Date().toISOString();
    await json(path.join(session.folder, 'smoke-report.json'), report);
    return { folder: session.folder, status: report.status, stages: report.stages.length };
  } catch (error) {
    report.error = error.message; report.diagnostics = client?.diagnostics ?? [];
    try { report.artifacts.push(await screenshot(client, session.folder, 'failure.png')); } catch { /* Retain the original failure; never repeat a mutation. */ }
    try { await client.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await client.send('Emulation.clearDeviceMetricsOverride'); } catch { /* A closed target has unknown runtime state. */ }
    client?.close(); await json(path.join(session.folder, 'smoke-report.json'), report); throw error;
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.action === 'help') { console.log('prepare --app <signed Obsidian.app> --version <exact installer> --parent <existing directory>\nlaunch|run|quit --session <generated session.json> --allow-runtime\nUses only isolated synthetic fixtures and exact-profile CDP. Never touches the native CLI or installs software. Coordinate app launches with the native CLI lane owner. Failed/unknown mutations are not retried; inspect the retained report and prepare a fresh case.'); return; }
  if (options.action === 'prepare') { console.log(JSON.stringify(await prepare(options))); return; }
  let session = await validateSession(options.session, { initial: ['launch', 'run'].includes(options.action) });
  if (options.action === 'launch') { session = await launch(session, 'launch'); console.log(JSON.stringify({ pid: session.pid, folder: session.folder })); return; }
  const restarted = await fs.stat(path.join(session.folder, 'restart.json')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  session = await launched(session, restarted ? 'restart' : 'launch');
  if (options.action === 'quit') { const client = await connectReady(session); await quitOwned(client, session); console.log('Quit only the exact guarded smoke process.'); return; }
  console.log(JSON.stringify(await runSmoke(session)));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
