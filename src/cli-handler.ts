/**
 * CLI Handler for Task Manager
 * Registers an Obsidian CLI handler for headless task query execution.
 * Allows external scripts to query tasks via `obsidian cli task-query <query>`
 * Returns JSON results without opening the GUI.
 */

import type { App, CliData, CliFlags } from 'obsidian';
import { obsidianTaskFileInfoProvider, TaskQueryService } from './task-query-service';
import { serializeTaskQueryCsv, serializeTaskQueryMarkdown } from './task-query-output';
import type { ParsedTask, TaskScanner } from './task-scanner';
import type { TaskManagerSettings } from './types';

export interface CliQueryResult {
  apiVersion: 1;
  success: boolean;
  data?: {
    tasks: ParsedTask[];
    count: number;
  };
  error?: string;
  executionTime: number;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

export type OutputFormat = 'json' | 'csv' | 'markdown';

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = globalThis.atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

export type CliRegistrar = (command: string, description: string, flags: CliFlags | null, handler: (params: CliData) => string | Promise<string>) => void;

export class CliHandler {
  constructor(
    private readonly app: App,
    private readonly scanner: TaskScanner,
    private readonly getSettings: () => TaskManagerSettings,
    private readonly getAllTasks: () => ParsedTask[],
    private readonly registerCliHandler?: CliRegistrar,
    private readonly whenTasksReady?: () => Promise<void>,
  ) {}

  /** Register the Obsidian 1.12.2+ CLI query command through Plugin.registerCliHandler. */
  register(): void {
    if (!this.registerCliHandler) {
      console.warn('Task Manager: Obsidian CLI handler API not available (requires Obsidian 1.12.2+).');
      return;
    }
    const flags: CliFlags = {
      query: { value: '<query>', description: 'Task Manager query DSL', required: false },
      query64: { value: '<base64url>', description: 'Base64url-encoded query DSL', required: false },
      format: { value: '<json|csv|markdown>', description: 'Output format', required: false },
      source: { value: '<vault-path>', description: 'Optional source note for Query File Defaults', required: false },
    };
    this.registerCliHandler('task-manager:query', 'Query Task Manager tasks', flags, async (params) => {
      const formatValue = params.format;
      const format: OutputFormat = formatValue === 'csv' || formatValue === 'markdown' ? formatValue : 'json';
      const queryString = typeof params.query64 === 'string' && params.query64
        ? decodeBase64Url(params.query64)
        : typeof params.query === 'string' ? params.query : '';
      const result = await this.executeQuery(queryString, format, typeof params.source === 'string' ? params.source : undefined);
      return this.formatOutput(result, format);
    });
  }

  /**
   * Execute a query string and return matching tasks.
   * @param queryString The query DSL string (e.g., "not done sort by urgency")
   * @param format Output format: json, csv, or markdown (default: json)
   * @returns CliQueryResult with tasks array, execution time, and optional snapshots
   */
  async executeQuery(queryString: string, _format: OutputFormat = 'json', sourcePath?: string): Promise<CliQueryResult> {
    await this.whenTasksReady?.();
    const startTime = performance.now();

    try {
      if (!queryString || queryString.trim().length === 0) {
        return {
          apiVersion: 1,
          success: false,
          error: 'Query string is empty',
          executionTime: performance.now() - startTime,
        };
      }

      const queryService = new TaskQueryService(this.getSettings, obsidianTaskFileInfoProvider(this.app));
      const { tasks } = queryService.execute(this.getAllTasks(), queryString.trim(), { ...(sourcePath ? { sourcePath } : {}) });

      return {
        apiVersion: 1,
        success: true,
        data: {
          tasks,
          count: tasks.length,
        },
        executionTime: performance.now() - startTime,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        apiVersion: 1,
        success: false,
        error: `Query execution failed: ${errorMessage}`,
        executionTime: performance.now() - startTime,
      };
    }
  }

  /**
   * Format query results as CSV, Markdown, or JSON.
   * @param result The CliQueryResult to format
   * @param format The desired output format
   * @returns Formatted string
   */
  formatOutput(result: CliQueryResult, format: OutputFormat = 'json'): string {
    if (!result.success || !result.data) {
      return JSON.stringify(result, null, 2);
    }

    const tasks = result.data.tasks;

    switch (format) {
      case 'csv':
        return serializeTaskQueryCsv(tasks);

      case 'markdown':
        return serializeTaskQueryMarkdown(tasks);

      case 'json':
      default:
        return JSON.stringify(result, null, 2);
    }
  }

  /**
   * Quick query helper: get all tasks matching a status.
   */
  async getTasksByStatus(status: string): Promise<ParsedTask[]> {
    const normalizedStatus = status.trim();
    if (!normalizedStatus) return [];

    const queryString = `status is ${normalizedStatus}`;
    const result = await this.executeQuery(queryString);
    return result.data?.tasks ?? [];
  }

  /**
   * Quick query helper: get all overdue tasks.
   */
  async getOverdueTasks(): Promise<ParsedTask[]> {
    const queryString = 'not done due before today';
    const result = await this.executeQuery(queryString);
    return result.data?.tasks ?? [];
  }

  /**
   * Quick query helper: get all tasks due today.
   */
  async getDueToday(): Promise<ParsedTask[]> {
    const queryString = 'not done due on today';
    const result = await this.executeQuery(queryString);
    return result.data?.tasks ?? [];
  }
}
