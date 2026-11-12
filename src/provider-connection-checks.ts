import type { TaskManagerSettings } from './types';
import type { ProviderRunContext } from './provider-sync-safety';
import { assertProviderRunCurrent, isProviderRunCancellation } from './provider-sync-safety';
import { tokenExpiresSoon } from './oauth-pkce';
import { TodoistAdapter } from './todoist-sync';
import { GoogleTasksAdapter } from './google-tasks-sync';
import { testGoogleCalendarConnection as testCalendarConnection } from './google-calendar-sync';
import { MicrosoftTodoAdapter } from './microsoft-todo-sync';

export interface ProviderConnectionResult {
  success: boolean;
  message: string;
}

type RefreshToken = (context: ProviderRunContext) => Promise<void>;

function failure(error: unknown, context: ProviderRunContext, provider: string): ProviderConnectionResult {
  return isProviderRunCancellation(error) || !context.isCurrent()
    ? { success: false, message: `${provider} connection cancelled` }
    : { success: false, message: error instanceof Error ? error.message : String(error) };
}

export async function testTodoistProviderConnection(settings: TaskManagerSettings, context: ProviderRunContext): Promise<ProviderConnectionResult> {
  try {
    const adapter = new TodoistAdapter({
      apiKey: settings.todoistApiKey,
      projectId: settings.todoistProjectId,
      signal: context.signal,
      assertCurrent: () => assertProviderRunCurrent(context),
    });
    const result = await adapter.testConnection();
    assertProviderRunCurrent(context);
    return result.ok
      ? { success: true, message: 'Authenticated read succeeded for Todoist projects.' }
      : { success: false, message: result.error ?? 'Todoist authenticated read failed.' };
  } catch (error) {
    return failure(error, context, 'Todoist');
  }
}

export async function testGoogleTasksProviderConnection(settings: TaskManagerSettings, context: ProviderRunContext, refresh: RefreshToken): Promise<ProviderConnectionResult> {
  try {
    if (tokenExpiresSoon(settings.googleTasksTokenExpiresAt)) await refresh(context);
    assertProviderRunCurrent(context);
    const listId = settings.googleTasksListId.trim() || '@default';
    const adapter = new GoogleTasksAdapter({
      accessToken: settings.googleTasksAccessToken,
      refreshToken: settings.googleTasksRefreshToken,
      tokenExpiresAt: settings.googleTasksTokenExpiresAt,
      apiKey: settings.googleTasksApiKey,
      listId,
      signal: context.signal,
      assertCurrent: () => assertProviderRunCurrent(context),
    });
    const result = await adapter.testConnection();
    assertProviderRunCurrent(context);
    return result.ok
      ? { success: true, message: `Authenticated read succeeded for Google Tasks list ${listId}.` }
      : { success: false, message: result.error ?? 'Google Tasks authenticated read failed.' };
  } catch (error) {
    return failure(error, context, 'Google Tasks');
  }
}

export async function testGoogleCalendarProviderConnection(settings: TaskManagerSettings, context: ProviderRunContext, refresh: RefreshToken): Promise<ProviderConnectionResult> {
  try {
    if (tokenExpiresSoon(settings.googleCalendarTokenExpiresAt)) await refresh(context);
    assertProviderRunCurrent(context);
    const calendarId = settings.googleCalendarId.trim() || 'primary';
    await testCalendarConnection({
      accessToken: settings.googleCalendarAccessToken,
      refreshToken: settings.googleCalendarRefreshToken,
      tokenExpiresAt: settings.googleCalendarTokenExpiresAt,
      calendarId,
      signal: context.signal,
      assertCurrent: () => assertProviderRunCurrent(context),
    });
    assertProviderRunCurrent(context);
    return { success: true, message: `Authenticated read succeeded for Google Calendar ${calendarId}.` };
  } catch (error) {
    return failure(error, context, 'Google Calendar');
  }
}

export async function testMicrosoftTodoProviderConnection(settings: TaskManagerSettings, context: ProviderRunContext, refresh: RefreshToken): Promise<ProviderConnectionResult> {
  try {
    if (tokenExpiresSoon(settings.msToDoTokenExpiresAt)) await refresh(context);
    assertProviderRunCurrent(context);
    const adapter = new MicrosoftTodoAdapter({
      accessToken: settings.msToDoToken,
      refreshToken: settings.msToDoRefreshToken,
      tokenExpiresAt: settings.msToDoTokenExpiresAt,
      listId: settings.msToDoListId,
      bidirectionalSync: false,
      syncIntervalMinutes: 0,
      vaultImportPath: settings.msToDoInboxPath,
      signal: context.signal,
      assertCurrent: () => assertProviderRunCurrent(context),
    });
    const result = await adapter.testConnection();
    assertProviderRunCurrent(context);
    return result.ok
      ? { success: true, message: 'Authenticated read succeeded for Microsoft To Do lists.' }
      : { success: false, message: result.error ?? 'Microsoft To Do authenticated read failed.' };
  } catch (error) {
    return failure(error, context, 'Microsoft To Do');
  }
}
