export const APPLE_REMINDERS_CLIPBOARD_MAX_BYTES = 1024 * 1024;
export const APPLE_REMINDERS_MAX_ITEMS = 1000;
export const APPLE_REMINDER_ID_MAX_BYTES = 4 * 1024;
export const APPLE_REMINDER_TITLE_MAX_BYTES = 4 * 1024;
export const APPLE_REMINDER_NOTES_MAX_BYTES = 32 * 1024;
export const APPLE_REMINDERS_RENDERED_MAX_BYTES = 4 * 1024 * 1024;
export const TASK_CAPTURE_URI_MAX_BYTES = 32 * 1024;
export const AI_QUERY_PROMPT_MAX_BYTES = 32 * 1024;

export function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const point = value.codePointAt(index) ?? 0;
    if (point > 0xffff) index += 1;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}
