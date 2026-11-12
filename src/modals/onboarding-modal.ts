import { Modal, type App } from 'obsidian';
import { t, type TranslationKey } from '../i18n';
import { applyLocaleScope } from '../locale-scope';

export const ONBOARDING_VERSION = 1;
export const ONBOARDING_QUERY_SNIPPET = '```task-list\nnot done\n```';

export type OnboardingActionResult = 'task' | 'panel' | 'inserted' | 'copied' | 'copy-failed';

export interface OnboardingActions {
  createFirstTask(): void | Promise<void>;
  openTaskPanel(): void | Promise<void>;
  insertOrCopyQuery(): OnboardingActionResult | Promise<OnboardingActionResult>;
  persistSeen(): void | Promise<void>;
}

export function shouldAutoOpenOnboarding(profileWasUnseen: boolean, versionSeen: number, attemptedThisLoad: boolean): boolean {
  return profileWasUnseen && versionSeen < ONBOARDING_VERSION && !attemptedThisLoad;
}

interface OnboardingStep {
  title: TranslationKey;
  description: TranslationKey;
  action: TranslationKey;
  run: () => Promise<OnboardingActionResult>;
}

export class OnboardingModal extends Modal {
  private step = 0;
  private statusEl?: HTMLElement;
  private headingEl?: HTMLElement;
  private panelEl?: HTMLElement;
  private actionButton?: HTMLButtonElement;
  private backButton?: HTMLButtonElement;
  private nextButton?: HTMLButtonElement;
  private remindLaterButton?: HTMLButtonElement;
  private doNotShowButton?: HTMLButtonElement;
  private actionPending = false;
  private generation = 0;
  private disposeLocaleScope?: () => void;

  constructor(
    app: App,
    private readonly actions: OnboardingActions,
    private readonly onClosed?: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.step = 0;
    this.generation += 1;
    this.buildShell();
    this.renderStep(false);
  }

  private getSteps(): OnboardingStep[] {
    return [
      {
        title: 'onboarding.firstTask.title',
        description: 'onboarding.firstTask.description',
        action: 'onboarding.firstTask.action',
        run: async () => { await this.actions.createFirstTask(); return 'task'; },
      },
      {
        title: 'onboarding.sidebar.title',
        description: 'onboarding.sidebar.description',
        action: 'onboarding.sidebar.action',
        run: async () => { await this.actions.openTaskPanel(); return 'panel'; },
      },
      {
        title: 'onboarding.query.title',
        description: 'onboarding.query.description',
        action: 'onboarding.query.action',
        run: async () => this.actions.insertOrCopyQuery(),
      },
    ];
  }

  private buildShell(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('task-manager-onboarding');
    this.disposeLocaleScope?.();
    this.disposeLocaleScope = applyLocaleScope(contentEl);
    contentEl.createEl('h2', { text: t('onboarding.title') });
    this.statusEl = contentEl.createDiv({ cls: 'task-manager-onboarding-status' });
    this.statusEl.setAttr('role', 'status');
    this.statusEl.setAttr('aria-live', 'polite');
    this.statusEl.setAttr('aria-atomic', 'true');
    this.headingEl = contentEl.createEl('h3', { cls: 'task-manager-onboarding-heading' });
    this.headingEl.setAttr('tabindex', '-1');
    this.headingEl.setAttr('aria-current', 'step');
    this.panelEl = contentEl.createDiv({ cls: 'task-manager-onboarding-panel' });
    this.panelEl.setAttr('role', 'region');

    const navigation = contentEl.createDiv({ cls: 'task-manager-onboarding-navigation' });
    this.backButton = navigation.createEl('button', { text: t('action.back') });
    this.backButton.setAttr('type', 'button');
    this.backButton.addEventListener('click', () => {
      if (this.step === 0) return;
      this.step -= 1;
      this.renderStep(true);
    });
    this.nextButton = navigation.createEl('button', { cls: 'mod-cta' });
    this.nextButton.setAttr('type', 'button');
    this.nextButton.addEventListener('click', () => { void this.advance(); });

    const dismissal = contentEl.createDiv({ cls: 'task-manager-onboarding-dismissal' });
    this.remindLaterButton = dismissal.createEl('button', { text: t('onboarding.remindLater') });
    this.remindLaterButton.setAttr('type', 'button');
    this.remindLaterButton.addEventListener('click', () => this.close());
    this.doNotShowButton = dismissal.createEl('button', { text: t('onboarding.doNotShowAgain') });
    this.doNotShowButton.setAttr('type', 'button');
    this.doNotShowButton.addEventListener('click', () => { void this.persistAndClose(); });
  }

  private async advance(): Promise<void> {
    if (this.step >= this.getSteps().length - 1) {
      await this.persistAndClose();
      return;
    }
    this.step += 1;
    this.renderStep(true);
  }

  private async persistAndClose(): Promise<void> {
    if (this.actionPending) return;
    const generation = this.generation;
    this.setPending(true);
    try {
      await this.actions.persistSeen();
      if (generation === this.generation) this.close();
    } catch (error) {
      if (generation === this.generation && this.statusEl) {
        this.statusEl.setText(error instanceof Error ? error.message : String(error));
        this.doNotShowButton?.focus();
      }
    } finally {
      if (generation === this.generation) this.setPending(false);
    }
  }

  private renderStep(focusHeading: boolean): void {
    if (!this.statusEl || !this.headingEl || !this.panelEl || !this.backButton || !this.nextButton) return;
    const steps = this.getSteps();
    const current = steps[this.step];
    if (!current) return;
    this.statusEl.setText(t('onboarding.progress', { current: this.step + 1, total: steps.length }));
    this.headingEl.setText(t(current.title));
    this.panelEl.empty();
    this.panelEl.setAttr('aria-labelledby', this.headingEl.id || this.assignHeadingId());
    this.panelEl.createEl('p', { text: t(current.description) });
    this.actionButton = this.panelEl.createEl('button', { text: t(current.action), cls: 'task-manager-onboarding-action' });
    this.actionButton.setAttr('type', 'button');
    this.actionButton.addEventListener('click', () => { void this.runCurrentAction(); });
    this.backButton.hidden = this.step === 0;
    this.nextButton.setText(this.step === steps.length - 1 ? t('onboarding.finish') : t('action.next'));
    if (focusHeading) this.headingEl.focus();
  }

  private assignHeadingId(): string {
    if (!this.headingEl) return '';
    this.headingEl.id = 'task-manager-onboarding-step-heading';
    return this.headingEl.id;
  }

  private async runCurrentAction(): Promise<void> {
    const current = this.getSteps()[this.step];
    if (!current || !this.statusEl || this.actionPending) return;
    const generation = this.generation;
    this.setPending(true);
    let result: OnboardingActionResult;
    try {
      result = await current.run();
    } catch (error) {
      if (generation === this.generation) {
        this.statusEl.setText(error instanceof Error ? error.message : String(error));
        this.actionButton?.focus();
      }
      return;
    } finally {
      if (generation === this.generation) this.setPending(false);
    }
    if (generation !== this.generation) return;
    const keys: Record<OnboardingActionResult, TranslationKey> = {
      task: 'onboarding.status.task',
      panel: 'onboarding.status.panel',
      inserted: 'onboarding.status.inserted',
      copied: 'onboarding.status.copied',
      'copy-failed': 'onboarding.status.copyFailed',
    };
    this.statusEl.setText(t(keys[result]));
  }

  private setPending(pending: boolean): void {
    this.actionPending = pending;
    if (pending) this.contentEl.setAttr('aria-busy', 'true');
    else this.contentEl.removeAttribute('aria-busy');
    for (const button of [this.actionButton, this.backButton, this.nextButton, this.remindLaterButton, this.doNotShowButton]) {
      if (button) button.disabled = pending;
    }
  }

  onClose(): void {
    this.generation += 1;
    this.actionPending = false;
    this.statusEl = undefined;
    this.headingEl = undefined;
    this.panelEl = undefined;
    this.actionButton = undefined;
    this.backButton = undefined;
    this.nextButton = undefined;
    this.remindLaterButton = undefined;
    this.doNotShowButton = undefined;
    this.disposeLocaleScope?.();
    this.disposeLocaleScope = undefined;
    this.contentEl.empty();
    this.onClosed?.();
  }
}
