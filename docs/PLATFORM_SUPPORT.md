# Platform and capability support

Task Manager requires Obsidian 1.11.4 or later and can run on desktop and mobile. Some features have platform restrictions, and mobile behavior can vary by device.

| Capability | Desktop | iOS / Android | Notes |
|---|---|---|---|
| Markdown scanning, queries, completion logging | Implemented | Intended/implemented | Obsidian and the plugin must be running. |
| Sidebar, dashboard, table/Kanban/calendar/timeline/Gantt | Implemented | Intended, responsive | Spatial views may scroll horizontally. Touch controls and keyboard alternatives are available. |
| File writes, recurrence, archive/collect, quick capture | Implemented | Intended/implemented | Back up before bulk/lifecycle changes. Canvas remains read-only until copied to Markdown. |
| Periodic scans and reminders | While Obsidian is running | Best effort while app/plugin executes | Mobile OS suspension or force-close prevents JavaScript polling. A notification is not guaranteed while Obsidian is closed. Missed-reminder logging is a recovery aid, not background execution. |
| Web Speech voice capture | If browser/OS exposes it | Device-dependent | Processing may be cloud-backed by the browser/OS vendor. |
| Whisper fallback | Opt-in | Opt-in where MediaRecorder/microphone are available | Uploads audio to OpenAI; see privacy guide. |
| HTTP integrations via Obsidian APIs | Opt-in | Intended core transport | Provider OAuth setup may still be easier on desktop. Validate service behavior on the target device. |
| Desktop MCP companion | Separate desktop process only | Not available | The production plugin does not embed Node HTTP/MCP code. Companion is read-only and requires the Obsidian CLI. |
| Obsidian CLI commands | Obsidian versions that expose CLI registration | Not available | Registration is feature-detected; older versions continue without CLI. |
| Apple Reminders native access | Shortcut clipboard import only | Shortcut clipboard import only | Explicit JSON import command; no EventKit, HTTP listener, MCP mutation tool, or native writeback. |
