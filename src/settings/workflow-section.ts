import { Setting } from 'obsidian';
import type { SettingsHost } from '../settings-contract';
import { confirmSettingsRemoval } from './confirm-removal';

/**
 * Render the Workflow settings section.
 */
export function renderWorkflowSection(
  containerEl: HTMLElement,
  plugin: SettingsHost,
  display: () => void,
): void {
// ── Workflow automation (#5) ──
containerEl.createEl('h3', { text: 'Workflow automation' });
containerEl.createEl('p', {
  text: 'Define workflows: when a task tagged with the trigger tag is marked done, the plugin automatically inserts the next step task beneath it.',
  cls: 'setting-item-description',
});
new Setting(containerEl)
  .setName('Enable workflow automation')
  .setDesc('When enabled, completing a task with a workflow trigger tag auto-creates the next step task.')
  .addToggle((toggle) =>
    toggle.setValue(plugin.settings.workflowsEnabled).onChange(async (value) => {
      plugin.settings.workflowsEnabled = value;
      await plugin.saveSettings();
    }),
  );

if (plugin.settings.workflowsEnabled) {
  const addWorkflowBtn = containerEl.createEl('button', { text: '+ Add workflow', cls: 'mod-cta task-manager-add-workflow-btn' });
  addWorkflowBtn.addEventListener('click', () => {
    plugin.settings.workflows.push({
      id: `wf-${Date.now()}`,
      name: 'New Workflow',
      triggerTag: 'wf:new',
      steps: [{ name: 'Step 1', description: '{{prev}} — follow-up', status: ' ', priority: '' }],
    });
    void plugin.saveSettings().then(() => { display(); });
  });

  for (let wfIdx = 0; wfIdx < plugin.settings.workflows.length; wfIdx++) {
    const wf = plugin.settings.workflows[wfIdx];
    const wfBox = containerEl.createDiv({ cls: 'task-manager-workflow-box' });
    wfBox.style.cssText = 'border:1px solid var(--background-modifier-border);border-radius:6px;padding:12px;margin:8px 0;';

    new Setting(wfBox)
      .setName(`Workflow: ${wf.name}`)
      .setDesc(`Trigger tag: #${wf.triggerTag} \u2022 ${wf.steps.length} step(s)`)
      .addText((t) => t.setPlaceholder('Workflow name').setValue(wf.name).onChange(async (v) => {
        wf.name = v.trim() || 'Unnamed';
        await plugin.saveSettings();
      }))
      .addText((t) => t.setPlaceholder('Trigger tag (without #)').setValue(wf.triggerTag).onChange(async (v) => {
        wf.triggerTag = v.replace(/^#/u, '').trim();
        await plugin.saveSettings();
      }))
      .addExtraButton((btn) => btn.setIcon('trash').setTooltip(`Remove workflow ${wf.name}`).onClick(() => {
        confirmSettingsRemoval(plugin.app, `workflow “${wf.name}”`, async () => {
          plugin.settings.workflows.splice(wfIdx, 1);
          await plugin.saveSettings();
          display();
        });
      }));

    // Steps editor
    for (let stepIdx = 0; stepIdx < wf.steps.length; stepIdx++) {
      const step = wf.steps[stepIdx];
      const stepRow = wfBox.createDiv({ cls: 'task-manager-workflow-step' });
      stepRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin:4px 0;';
      stepRow.createEl('span', { text: `Step ${stepIdx + 1}:`, cls: 'task-manager-step-label' });
      const descInput = stepRow.createEl('input', { type: 'text', placeholder: 'Task description ({{prev}} = source task)', value: step.description });
      descInput.style.cssText = 'flex:1;font-size:0.9em;';
      descInput.addEventListener('change', () => {
        step.description = descInput.value;
        void plugin.saveSettings();
      });
      const priInput = stepRow.createEl('select');
      for (const p of ['', 'highest', 'high', 'medium', 'low', 'lowest']) {
        const opt = priInput.createEl('option', { text: p || '(inherit)', value: p });
        if (step.priority === p) opt.selected = true;
      }
      priInput.addEventListener('change', () => {
        step.priority = priInput.value;
        void plugin.saveSettings();
      });
      const removeStepBtn = stepRow.createEl('button', { text: '×' });
      removeStepBtn.setAttr('aria-label', `Remove step ${stepIdx + 1} from ${wf.name}`);
      removeStepBtn.addEventListener('click', () => {
        confirmSettingsRemoval(plugin.app, `step ${stepIdx + 1} from workflow “${wf.name}”`, async () => {
          wf.steps.splice(stepIdx, 1);
          await plugin.saveSettings();
          display();
        });
      });
    }

    const addStepBtn = wfBox.createEl('button', { text: '+ Add step' });
    addStepBtn.style.marginTop = '6px';
    addStepBtn.addEventListener('click', () => {
      wf.steps.push({ name: `Step ${wf.steps.length + 1}`, description: '{{prev}} — follow-up', status: ' ', priority: '' });
      void plugin.saveSettings().then(() => { display(); });
    });
  }
}

}
