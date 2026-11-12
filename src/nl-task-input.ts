/**
 * nl-task-input.ts
 *
 * CodeMirror 6 extension that intercepts Enter on lines containing a
 * configurable magic prefix (default "!!") and auto-converts the NL text to
 * a properly-formatted task line.
 *
 * Two forms are handled:
 *
 *   1. Bare line (creates a new task):
 *      !! call dentist next Friday urgent
 *      → - [ ] call dentist ⏳ 2026-06-06 ⏫
 *
 *   2. Existing checkbox (expands description in-place):
 *      - [ ] !! standup every Monday at 10am
 *      → - [ ] standup ⏳ 2026-06-09 ⏰ 10:00 🔁 every week
 *
 *      Works with any checkbox state, indentation, or blockquote prefix:
 *      > - [/] !! fix bug due Thursday high priority
 *      → > - [/] fix bug ⏳ 2026-06-05 ⏫
 */

import { ViewPlugin, type PluginValue, type EditorView } from '@codemirror/view';
import { resolveNlTaskDescription } from './modals/task-edit-helpers';
import { todayString } from './date-utils';
import type { TaskManagerSettings } from './types';

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createNlTaskInputExtension(
  getSettings: () => TaskManagerSettings,
) {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      private readonly boundHandler: (e: KeyboardEvent) => void;

      constructor(private readonly view: EditorView) {
        this.boundHandler = this.handleKeydown.bind(this);
        this.view.dom.addEventListener('keydown', this.boundHandler, true);
      }

      destroy(): void {
        this.view.dom.removeEventListener('keydown', this.boundHandler, true);
      }

      private handleKeydown(event: KeyboardEvent): void {
        if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.isComposing) return;

        const settings = getSettings();
        if (!settings.nlInlineConversionEnabled) return;

        const prefix = (settings.nlTaskPrefix ?? '!!').trim();
        if (!prefix) return;

        const state = this.view.state;
        const sel = state.selection.main;
        if (!sel.empty) return;
        if (sel.head !== state.doc.lineAt(sel.head).to) return; // cursor not at end of line

        const line = state.doc.lineAt(sel.head);
        const lineText = line.text;
        const ep = escapeForRegex(prefix);
        const today = todayString();

        // ── Form 2: existing checkbox with !! in description ─────────────────
        // Matches: (optional blockquotes + indent)(list marker + space + [checkbox] + space)(!! )(description)
        const taskRe = new RegExp(
          `^((?:\\s*>\\s*)*)` +         // blockquote prefix
          `(\\s*(?:[-*+]|\\d+[.)])\\s+\\[[^\\]]*\\]\\s+)` + // "- [x] "
          `${ep}\\s+(.+)$`,             // "!! description"
          'u',
        );
        const taskMatch = lineText.match(taskRe);
        if (taskMatch) {
          const linePrefix  = taskMatch[1];
          const checkboxPart = taskMatch[2]; // e.g. "- [ ] "
          const description  = taskMatch[3].trim();
          const expanded     = resolveNlTaskDescription(description, today);
          const newLine      = `${linePrefix}${checkboxPart}${expanded}`;
          this.replace(line, newLine);
          event.preventDefault(); // keep cursor on this line; don't insert newline
          return;
        }

        // ── Form 1: bare line starting with !! (creates a new task) ──────────
        const bareRe = new RegExp(`^((?:\\s*>\\s*)*)(\\s*)${ep}\\s+(.+)$`, 'u');
        const bareMatch = lineText.match(bareRe);
        if (bareMatch) {
          const blockPrefix = bareMatch[1];
          const indent      = bareMatch[2];
          const description = bareMatch[3].trim();
          const expanded    = resolveNlTaskDescription(description, today);
          const newLine     = `${blockPrefix}${indent}- [ ] ${expanded}`;
          this.replace(line, newLine);
          // Allow default Enter to insert a newline after the new task line.
          return;
        }
      }

      private replace(line: { from: number; to: number }, newText: string): void {
        this.view.dispatch(this.view.state.update({
          changes: { from: line.from, to: line.to, insert: newText },
          selection: { anchor: line.from + newText.length },
          scrollIntoView: true,
          userEvent: 'input.nl-task-convert',
        }));
      }
    },
  );
}
