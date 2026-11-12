import { Notice } from 'obsidian';

export function showDurableLifecycleEditorNotice(): void {
  new Notice('Task Manager: archive/collect completion requires a saved task. Save the note, then complete it from a query, dashboard, or reading view.');
}

export function replaceEditorLineWithLines(
  editor: {
    setLine: (line: number, text: string) => void;
    replaceRange?: (text: string, from: { line: number; ch: number }, to: { line: number; ch: number }) => void;
    getLine?: (line: number) => string;
  },
  lineNumber: number,
  lines: readonly string[],
): void {
  if (lines.length > 1 && editor.replaceRange && editor.getLine) {
    const existingLine = editor.getLine(lineNumber);
    editor.replaceRange(lines.join('\n'), { line: lineNumber, ch: 0 }, { line: lineNumber, ch: existingLine.length });
    return;
  }
  editor.setLine(lineNumber, lines.join('\n'));
}

export function commandSafeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'space';
}
