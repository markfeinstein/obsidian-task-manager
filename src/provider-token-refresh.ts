import type { TaskManagerSettings } from './types';
import type { OAuthTokenResponse } from './oauth-pkce';
import { tokenExpiresSoon } from './oauth-pkce';
import { refreshGoogleTasksAccessToken } from './google-tasks-sync';
import { refreshGoogleCalendarAccessToken } from './google-calendar-sync';
import { refreshMicrosoftTodoAccessToken } from './microsoft-todo-sync';
import { assertProviderRunCurrent, ProviderRunCancelledError, type ProviderRunContext } from './provider-sync-safety';

type SaveSettings = (shouldContinue: () => boolean) => Promise<boolean | void>;
type TokenField = keyof TaskManagerSettings;

interface TokenFields {
  clientId: TokenField;
  accessToken: TokenField;
  refreshToken: TokenField;
  expiresAt: TokenField;
}

interface TokenRefreshOptions {
  settings: TaskManagerSettings;
  fields: TokenFields;
  context?: ProviderRunContext;
  saveSettings: SaveSettings;
  refresh(input: { clientId: string; refreshToken: string; signal?: AbortSignal }): Promise<OAuthTokenResponse>;
}

function field(settings: TaskManagerSettings, key: TokenField): string {
  const value = settings[key];
  return typeof value === 'string' ? value : '';
}

function setField(settings: TaskManagerSettings, key: TokenField, value: string): void {
  (settings as unknown as Record<string, unknown>)[key] = value;
}

async function refreshProviderTokenIfNeeded(options: TokenRefreshOptions): Promise<void> {
  const { settings, fields, context } = options;
  const clientId = field(settings, fields.clientId).trim();
  const refreshToken = field(settings, fields.refreshToken).trim();
  const accessToken = field(settings, fields.accessToken).trim();
  const expiresAt = field(settings, fields.expiresAt);
  if (!clientId || !refreshToken || (accessToken && !tokenExpiresSoon(expiresAt))) return;

  assertProviderRunCurrent(context);
  const token = await options.refresh({ clientId, refreshToken, signal: context?.signal });
  assertProviderRunCurrent(context);
  const previous = {
    accessToken: field(settings, fields.accessToken),
    refreshToken: field(settings, fields.refreshToken),
    expiresAt: field(settings, fields.expiresAt),
  };
  setField(settings, fields.accessToken, token.accessToken);
  setField(settings, fields.refreshToken, token.refreshToken ?? previous.refreshToken);
  setField(settings, fields.expiresAt, token.expiresAt ?? '');
  if (await options.saveSettings(context?.isCurrent ?? (() => true)) === false) {
    setField(settings, fields.accessToken, previous.accessToken);
    setField(settings, fields.refreshToken, previous.refreshToken);
    setField(settings, fields.expiresAt, previous.expiresAt);
    throw new ProviderRunCancelledError();
  }
  assertProviderRunCurrent(context);
}

export function refreshGoogleTasksTokenSettings(settings: TaskManagerSettings, context: ProviderRunContext | undefined, saveSettings: SaveSettings): Promise<void> {
  return refreshProviderTokenIfNeeded({
    settings, context, saveSettings,
    fields: { clientId: 'googleTasksOAuthClientId', accessToken: 'googleTasksAccessToken', refreshToken: 'googleTasksRefreshToken', expiresAt: 'googleTasksTokenExpiresAt' },
    refresh: refreshGoogleTasksAccessToken,
  });
}

export function refreshGoogleCalendarTokenSettings(settings: TaskManagerSettings, context: ProviderRunContext | undefined, saveSettings: SaveSettings): Promise<void> {
  return refreshProviderTokenIfNeeded({
    settings, context, saveSettings,
    fields: { clientId: 'googleCalendarOAuthClientId', accessToken: 'googleCalendarAccessToken', refreshToken: 'googleCalendarRefreshToken', expiresAt: 'googleCalendarTokenExpiresAt' },
    refresh: refreshGoogleCalendarAccessToken,
  });
}

export function refreshMicrosoftTodoTokenSettings(settings: TaskManagerSettings, context: ProviderRunContext | undefined, saveSettings: SaveSettings): Promise<void> {
  return refreshProviderTokenIfNeeded({
    settings, context, saveSettings,
    fields: { clientId: 'msToDoClientId', accessToken: 'msToDoToken', refreshToken: 'msToDoRefreshToken', expiresAt: 'msToDoTokenExpiresAt' },
    refresh: refreshMicrosoftTodoAccessToken,
  });
}
