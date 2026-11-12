import test from 'node:test';
import assert from 'node:assert/strict';
import type { App, EditorSuggestContext } from 'obsidian';
import { TaskManagerAutoSuggest } from '../src/modals/autosuggest';
import { DEFAULT_SETTINGS } from '../src/types';

test('TaskManagerAutoSuggest awaits vault reads before returning @ assignee suggestions', async () => {
  const files = [{ path: 'Tasks/A.md' }, { path: 'Tasks/B.md' }];
  const contents = new Map<string, string>([
    ['Tasks/A.md', '- [ ] Review draft 👤 @alice\n- [ ] Pair with teammate 👤️ @team/bob'],
    ['Tasks/B.md', '- [ ] Follow up 👤 @carol\n- [ ] Reassign 👤 @alice'],
  ]);
  const app = {
    vault: {
      getMarkdownFiles: () => files,
      cachedRead: async (file: { path: string }) => contents.get(file.path) ?? '',
    },
    metadataCache: {
      getFileCache: () => null,
    },
  } as unknown as App;

  const suggest = new TaskManagerAutoSuggest(app, () => ({
    ...DEFAULT_SETTINGS,
    atAssigneeInEditor: true,
  }));

  const suggestions = await suggest.getSuggestions({
    query: '@',
    editor: { getLine: () => '- [ ] Review @' },
    start: { line: 0, ch: 11 },
    end: { line: 0, ch: 12 },
    file: {},
  } as unknown as EditorSuggestContext);

  assert.deepEqual(suggestions, ['@alice', '@carol', '@team/bob']);
});
