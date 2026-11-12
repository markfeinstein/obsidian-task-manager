/**
 * Mobile URI Capture: Handle Obsidian URI quick capture for mobile
 * Allows users to quickly add tasks via Obsidian URI from mobile devices
 */

import { Notice, TFile, App } from 'obsidian';
import { isHttpsPublicUrl, isSafeHttpsUrlForRequest, resolveSafeHttpsUrlForRequest, type HostnameResolver } from './url-safety';
import { sanitizeUntrustedInlineFieldValue, sanitizeUntrustedTag, sanitizeUntrustedTaskText, sanitizeUntrustedTaskTextLines } from './untrusted-task-text';
import { TASK_CAPTURE_URI_MAX_BYTES, utf8ByteLength } from './input-budgets';

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export interface TaskCaptureURI {
  scheme: 'obsidian' | 'http' | 'https';
  action: 'quick-capture' | 'add-task' | 'schedule-task' | 'focus-note';
  params: {
    title?: string;
    description?: string;
    priority?: 'low' | 'medium' | 'high' | 'urgent';
    due?: string;  // ISO date or relative like 'today', 'tomorrow', 'next-week'
    tags?: string[];
    project?: string;
    callback?: string;  // URL to call after capture
    vault?: string;  // Vault name for multi-vault support
    file?: string;  // Target file path
    secret?: string;
  };
}

/**
 * Parse Obsidian URI and extract task parameters
 */
const VALID_ACTIONS = ['quick-capture', 'add-task', 'schedule-task', 'focus-note'] as const;
type TaskCaptureAction = typeof VALID_ACTIONS[number];
const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
type TaskCapturePriority = typeof VALID_PRIORITIES[number];
const PRIORITY_EMOJIS: Record<TaskCapturePriority, string> = {
  low: '🔽',
  medium: '🔼',
  high: '⏫',
  urgent: '🔺',
};
const TASK_CALLBACK_TIMEOUT_MS = 10_000;

function isValidAction(value: string): value is TaskCaptureAction {
  return (VALID_ACTIONS as readonly string[]).includes(value);
}

function isValidPriority(value: string | null): value is TaskCapturePriority {
  return value !== null && (VALID_PRIORITIES as readonly string[]).includes(value);
}

function parseTagList(value: string | null): string[] {
  return (value || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

export function parseTaskURI(uri: string): TaskCaptureURI | null {
  if (utf8ByteLength(uri) > TASK_CAPTURE_URI_MAX_BYTES) return null;
  try {
    // Handle obsidian:// URIs
    if (uri.startsWith('obsidian://')) {
      // Parse as obsidian://action?params
      const withoutScheme = uri.replace('obsidian://', '');
      const [actionPart, paramsPart] = withoutScheme.split('?');

      if (!actionPart || !isValidAction(actionPart)) {
        return null;
      }
      const action: TaskCaptureAction = actionPart;

      const params: TaskCaptureURI['params'] = {};

      if (paramsPart) {
        const urlParams = new URLSearchParams(paramsPart);

        if (urlParams.has('title')) {
          params.title = urlParams.get('title') || undefined;
        }
        if (urlParams.has('description')) {
          params.description = urlParams.get('description') || undefined;
        }
        if (urlParams.has('priority')) {
          const p = urlParams.get('priority');
          if (isValidPriority(p)) params.priority = p;
        }
        if (urlParams.has('due')) {
          params.due = urlParams.get('due') || undefined;
        }
        if (urlParams.has('tags')) {
          params.tags = parseTagList(urlParams.get('tags'));
        }
        if (urlParams.has('project')) {
          params.project = urlParams.get('project') || undefined;
        }
        if (urlParams.has('callback')) {
          params.callback = urlParams.get('callback') || undefined;
        }
        if (urlParams.has('vault')) {
          params.vault = urlParams.get('vault') || undefined;
        }
        if (urlParams.has('file')) {
          params.file = urlParams.get('file') || undefined;
        }
        if (urlParams.has('secret')) {
          params.secret = urlParams.get('secret') || undefined;
        }
      }

      return {
        scheme: 'obsidian',
        action,
        params,
      };
    }

    // Handle http(s) URIs (web clipper or IFTTT integration)
    if (uri.startsWith('http://') || uri.startsWith('https://')) {
      const url = new URL(uri);

      // Check for task-manager specific parameters
      if (!url.searchParams.has('task-action')) {
        return null;
      }

      const rawAction = url.searchParams.get('task-action') ?? '';
      if (!isValidAction(rawAction)) {
        return null;
      }
      const action: TaskCaptureAction = rawAction;

      const rawPriority = url.searchParams.get('priority');
      const params: TaskCaptureURI['params'] = {
        title: url.searchParams.get('title') || undefined,
        description: url.searchParams.get('description') || undefined,
        priority: isValidPriority(rawPriority) ? rawPriority : undefined,
        due: url.searchParams.get('due') || undefined,
        tags: parseTagList(url.searchParams.get('tags')),
        project: url.searchParams.get('project') || undefined,
        callback: url.searchParams.get('callback') || undefined,
        vault: url.searchParams.get('vault') || undefined,
        file: url.searchParams.get('file') || undefined,
        secret: url.searchParams.get('secret') || undefined,
      };

      return {
        scheme: uri.startsWith('https') ? 'https' : 'http',
        action,
        params,
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Generate a task capture URI
 */
export function generateTaskCaptureURI(
  action: 'quick-capture' | 'add-task' | 'schedule-task' | 'focus-note',
  params: Partial<TaskCaptureURI['params']> = {},
): string {
  const searchParams = new URLSearchParams();

    if (params.title) searchParams.set('title', params.title);
    if (params.description) searchParams.set('description', params.description);
    if (params.priority) searchParams.set('priority', params.priority);
    if (params.due) searchParams.set('due', params.due);
    if (params.tags && params.tags.length > 0) {
      searchParams.set('tags', params.tags.join(','));
    }
    if (params.project) searchParams.set('project', params.project);
    if (params.file) searchParams.set('file', params.file);
    if (params.vault) searchParams.set('vault', params.vault);
    if (params.callback) searchParams.set('callback', params.callback);
    if (params.secret) searchParams.set('secret', params.secret);

  const queryString = searchParams.toString();
  return queryString ? `obsidian://${action}?${queryString}` : `obsidian://${action}`;
}

export function isSafeTaskCallbackUrl(callback: string): boolean {
  return isHttpsPublicUrl(callback);
}

export function isSafeTaskCallbackUrlForRequest(callback: string, resolver?: HostnameResolver): Promise<boolean> {
  return isSafeHttpsUrlForRequest(callback, resolver);
}

export interface SafeTaskCallbackRequest {
  url: URL;
  address: string;
  timeoutMs: number;
}

export type SafeTaskCallbackTransport = (request: SafeTaskCallbackRequest) => Promise<void>;

async function fetchTaskCallback(
  callback: string,
  resolver?: HostnameResolver,
  transport?: SafeTaskCallbackTransport,
): Promise<boolean> {
  // A capture URI is untrusted input. The plugin runtime cannot pin DNS or
  // reject redirect hops with requestUrl, so callbacks are disabled unless a
  // trusted caller supplies a transport that enforces both.
  if (!transport) return false;
  const target = await resolveSafeHttpsUrlForRequest(callback, resolver);
  if (!target) return false;

  await transport({
    url: target.url,
    address: target.address,
    timeoutMs: TASK_CALLBACK_TIMEOUT_MS,
  });
  return true;
}

/**
 * Mobile URI Handler - Process captured tasks
 */
export class MobileURIHandler {
  constructor(
    private app: App,
    private createTask: (title: string) => Promise<void>,
    private callbackHostnameResolver?: HostnameResolver,
    private callbackTransport?: SafeTaskCallbackTransport,
    private externalActionsEnabled: () => boolean = () => true,
    private requireMatchingVault = false,
    private expectedSecret: () => string = () => '',
  ) {}

  /**
   * Handle a captured URI and create task
   */
  async handleCaptureURI(uri: string): Promise<void> {
    const parsed = parseTaskURI(uri);

    if (!parsed) {
      new Notice('Invalid task URI format');
      return;
    }

    if (!this.externalActionsEnabled()) {
      new Notice('External Task Manager URI actions are disabled');
      return;
    }

    const expectedSecret = this.expectedSecret();
    if (this.requireMatchingVault && (!expectedSecret || parsed.params.secret !== expectedSecret)) {
      new Notice('External Task Manager URI secret is missing or invalid');
      return;
    }

    const currentVaultName = this.app.vault?.getName?.();
    if ((this.requireMatchingVault && (!parsed.params.vault || !currentVaultName))
      || (parsed.params.vault && currentVaultName && parsed.params.vault !== currentVaultName)) {
      new Notice(`Vault mismatch: expected ${parsed.params.vault}, but Obsidian is open to ${currentVaultName}`);
      return;
    }

    if (parsed.action !== 'focus-note' && parsed.params.file) {
      new Notice('The file parameter is supported only for focus-note');
      return;
    }

    switch (parsed.action) {
      case 'quick-capture':
        await this.handleQuickCapture(parsed);
        break;
      case 'add-task':
        await this.handleAddTask(parsed);
        break;
      case 'schedule-task':
        await this.handleScheduleTask(parsed);
        break;
      case 'focus-note':
        await this.handleFocusNote(parsed);
        break;
    }
  }

  private async handleQuickCapture(uri: TaskCaptureURI): Promise<void> {
    if (!uri.params.title) {
      new Notice('No task title provided');
      return;
    }

    const taskTitle = this.buildTaskText(uri.params, this.getOptionalDueIso(uri.params.due));

    await this.createTask(taskTitle);
    new Notice(`✓ Task captured: ${uri.params.title}`);

    // Call callback if provided
    if (uri.params.callback) {
      try {
        const sent = await fetchTaskCallback(uri.params.callback, this.callbackHostnameResolver, this.callbackTransport);
        if (!sent) new Notice('Task callback URL blocked');
      } catch (error) {
        new Notice(`Task captured, but callback delivery failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async handleAddTask(uri: TaskCaptureURI): Promise<void> {
    if (!uri.params.title) {
      new Notice('No task title provided');
      return;
    }

    const taskTitle = this.buildTaskText(uri.params, this.getOptionalDueIso(uri.params.due));

    await this.createTask(taskTitle);
    new Notice(`✓ Task added: ${uri.params.title}`);
  }

  private async handleScheduleTask(uri: TaskCaptureURI): Promise<void> {
    if (!uri.params.title || !uri.params.due) {
      new Notice('Task title and due date required for scheduling');
      return;
    }

    const dueDate = this.parseDueDate(uri.params.due);
    if (!dueDate) {
      new Notice(`Invalid due date: ${uri.params.due}`);
      return;
    }

    const dueIso = formatLocalDate(dueDate);
    const taskTitle = this.buildTaskText(uri.params, dueIso);

    await this.createTask(taskTitle);
    new Notice(`✓ Task scheduled for ${dueIso}: ${uri.params.title}`);
  }

  private buildTaskText(params: TaskCaptureURI['params'], dueIso?: string): string {
    const metadata: string[] = [];
    if (params.priority) metadata.push(PRIORITY_EMOJIS[params.priority]);
    if (dueIso) metadata.push(`📅 ${dueIso}`);
    const project = sanitizeUntrustedInlineFieldValue(params.project);
    if (project) metadata.push(`[project:: ${project}]`);
    if (params.tags) {
      metadata.push(
        ...params.tags
          .map(sanitizeUntrustedTag)
          .filter((tag) => tag.length > 0)
          .map((tag) => `#${tag}`),
      );
    }

    let taskTitle = sanitizeUntrustedTaskText(params.title) || 'Untitled task';
    if (metadata.length > 0) {
      taskTitle += ` ${metadata.join(' ')}`;
    }
    const description = sanitizeUntrustedTaskTextLines(params.description).join('\n');
    if (description) {
      taskTitle += `\n${description}`;
    }
    return taskTitle;
  }

  private getOptionalDueIso(due?: string): string | undefined {
    if (!due) return undefined;
    const dueDate = this.parseDueDate(due);
    return dueDate ? formatLocalDate(dueDate) : undefined;
  }

  private async handleFocusNote(uri: TaskCaptureURI): Promise<void> {
    if (!uri.params.file) {
      new Notice('No file specified');
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(uri.params.file);

    if (!file || !(file instanceof TFile)) {
      new Notice(`File not found: ${uri.params.file}`);
      return;
    }

    await this.app.workspace.getLeaf().openFile(file);
    new Notice(`📄 Opened: ${uri.params.file}`);
  }

  private parseDueDate(dueDateStr: string): Date | undefined {
    const rawDueDate = dueDateStr.trim();
    // Handle relative dates
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    switch (rawDueDate.toLowerCase()) {
      case 'today': {
        return today;
      }
      case 'tomorrow': {
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        return tomorrow;
      }
      case 'next-week': {
        const nextWeek = new Date(today);
        nextWeek.setDate(nextWeek.getDate() + 7);
        return nextWeek;
      }
      case 'next-month': {
        const nextMonth = new Date(today);
        const currentDay = nextMonth.getDate();
        nextMonth.setDate(1); // anchor to day 1 to prevent month overflow
        nextMonth.setMonth(nextMonth.getMonth() + 1);
        const lastDayOfMonth = new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0).getDate();
        nextMonth.setDate(Math.min(currentDay, lastDayOfMonth));
        return nextMonth;
      }
      default: {
        // Parse only explicit ISO date/date-time strings deterministically. Do not
        // delegate to JavaScript's runtime-dependent Date parser for ambiguous
        // values such as 06/07/2026.
        const isoDate = rawDueDate.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u);
        if (!isoDate) return undefined;
        const [, year, month, day, hour = '0', minute = '0', second = '0'] = isoDate;
        const parsedHour = Number(hour);
        const parsedMinute = Number(minute);
        const parsedSecond = Number(second);
        if (parsedHour > 23 || parsedMinute > 59 || parsedSecond > 59) return undefined;
        const parsed = new Date(Number(year), Number(month) - 1, Number(day));
        return parsed.getFullYear() === Number(year)
          && parsed.getMonth() === Number(month) - 1
          && parsed.getDate() === Number(day)
          ? parsed
          : undefined;
      }
    }
  }
}
