import type { CommandHost } from './command-host';
import { addDocumentedCommand } from './documented-command';

export function registerWorkspaceCommands(host: CommandHost): void {
  addDocumentedCommand(host, {
    id: 'create-project-workspace',
    name: 'Create new project workspace',
    icon: 'layout-dashboard',
    callback: () => { host.createProjectWorkspace(); },
  });

  addDocumentedCommand(host, {
    id: 'refresh-project-workspace',
    name: 'Refresh current project workspace',
    icon: 'refresh-cw',
    callback: async () => { await host.refreshCurrentProjectWorkspace(); },
  });

  addDocumentedCommand(host, {
    id: 'publish-ics-feed',
    name: 'Publish ICS calendar feed',
    icon: 'calendar',
    callback: async () => { await host.publishICSFeed(); },
  });
}
