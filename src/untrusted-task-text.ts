import { normalizeTaskText, stripTaskMetadata } from './task-model';

function normalizeUntrustedTaskText(value: string | undefined): string {
  return normalizeTaskText(stripTaskMetadata(value ?? ''));
}

export function sanitizeUntrustedTaskText(value: string | undefined): string {
  return normalizeUntrustedTaskText(value)
    // Remote titles must remain literal text when the stored task is later
    // rendered as Markdown. Escape link/image/wikilink delimiters and task
    // routing syntax such as #tags or @contexts.
    .replace(/(^|[^\\])([!#@[\]()])/gu, '$1\\$2');
}

export function sanitizeUntrustedTaskTextLines(value: string | undefined): string[] {
  return (value ?? '')
    .split(/\r?\n/gu)
    .map((line) => sanitizeUntrustedTaskText(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+\[[^\]]+\]\s*/u, '')).trim())
    .filter(Boolean);
}

export function sanitizeUntrustedInlineFieldValue(value: string | undefined): string {
  return normalizeUntrustedTaskText(value).replace(/[[\]()]/gu, '').trim();
}

export function sanitizeUntrustedTag(value: string): string {
  return normalizeUntrustedTaskText(value).replace(/^#+/u, '').replace(/[^\p{L}\p{N}_/-]+/gu, '-').replace(/^-+|-+$/gu, '').trim();
}
