# Apple Reminders Shortcut JSON import

> **Status:** Experimental, import-only, off by default. No EventKit access, native writeback, HTTP listener, or MCP mutation tool is bundled.

Task Manager can launch an Apple Shortcut and explicitly import a JSON payload copied to the clipboard. The user remains in control of the import command; the mobile-safe plugin does not start a webhook server.

## Shortcut name contract

The default Shortcut name is exactly **`Export Reminders to Obsidian`**. Create the Shortcut with that name, or set **Shortcut name** in the Apple Reminders settings to the exact name you use. You may instead rename either side, but the names must match. A mismatch typically opens Shortcuts without running the intended export, so no JSON is copied for the subsequent import command.

Task Manager URL-encodes the configured name, including spaces, non-ASCII characters, `&`, `?`, and other reserved characters, before opening `shortcuts://run-shortcut?name=...`. The optional Reminders list is encoded separately as the `input` parameter; it cannot alter the Shortcut name or inject another query parameter. Blank or multiline Shortcut names normalize back to `Export Reminders to Obsidian`.

Launching the Shortcut does not bypass the import controls: dry run, the optional payload shared secret, clipboard exposure, explicit clipboard import, and payload validation all continue to apply.

## Safety model

- Enable **Apple Reminders sync** and **clipboard JSON import** explicitly.
- Start with **Dry-run mode**.
- An optional shared secret in the payload identifies the Shortcut producer but does not encrypt clipboard data.
- IDs are stored as `[id:: apple-reminder:<id>]`; repeated IDs are updated/skipped according to the configured conflict direction rather than blindly duplicated.
- Imported text is normalized as untrusted remote content.
- Clipboard contents can be visible to the OS/other applications; do not include sensitive notes unless that is acceptable.

## Payload

```json
{
  "protocol": "task-manager.apple-reminders.webhook.v1",
  "secret": "optional shared secret",
  "listName": "Reminders",
  "reminders": [
    {
      "id": "apple-reminder-id",
      "title": "Buy milk",
      "notes": "Optional notes",
      "dueDate": "2026-07-15",
      "isCompleted": false,
      "priority": 3,
      "modifiedDate": "2026-07-11T12:00:00Z"
    }
  ]
}
```

`items` is accepted as an alias for `reminders`. Every item needs a durable `id`; malformed/duplicate identities are rejected or skipped safely.

Priority mapping is importer-specific: 3 high, 2 medium, 1 low, 0/omitted normal.

## Workflow

1. Back up the destination vault note.
2. Enable Apple Reminders and **clipboard JSON import**.
3. Keep the default Shortcut name `Export Reminders to Obsidian`, or configure the exact custom Shortcut name; enable dry run and optionally configure a payload secret/list/inbox path.
4. Build/verify an Apple Shortcut that reads reminders, serializes the schema above, and copies the JSON result to the clipboard. Treat the Shortcut itself as trusted code.
5. Run **Open Apple Reminders export Shortcut**.
6. Run **Import Apple Reminders JSON from clipboard**.
7. Review the dry-run Notice and synthetic payload.
8. Disable dry run, import, and review the Markdown diff.

The configured inbox path is vault-relative and validated. The import can create/update Markdown tasks; it never mutates Apple Reminders.

## Revocation and cleanup

Disable clipboard import/Apple integration, clear the payload secret, remove clipboard contents, and delete imported Markdown only after backup/review. Removing imported lines does not delete the source Apple reminders.
