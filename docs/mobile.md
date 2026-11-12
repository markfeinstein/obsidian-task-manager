# Using Task Manager on mobile

Task Manager supports core tasks, queries, the sidebar, dashboard, and planning views on Obsidian for iOS and Android. See [Platform support](PLATFORM_SUPPORT.md) for limitations.

## Built-in workflow

- **Quick capture:** configure an inbox, then run the quick-capture command. External `obsidian://` Task Manager actions are off by default; if explicitly enabled, every URI must name the currently open `vault` and include the configured `secret`. Treat those URIs as credentials. URI inputs are normalized, and `file` is accepted only by `focus-note`. Callback parameters remain blocked because the production transport cannot pin DNS and reject redirects.
- **Tasks sidebar:** Today, Upcoming, Agenda, File, All, optional saved-query/habit/planning tabs; List, Kanban, and Calendar modes.
- **Touch:** quick actions are visible without hover, controls use coarse-pointer hit areas, and optional swipes expose task actions without a press-and-hold delay. Sidebar swipes preview Complete/Defer before release; query and Dashboard rows use a left swipe for their contextual menu. Safe one-off completion offers Undo; destructive or recurring lifecycle actions do not claim reversible undo.
- **Create/Edit modal:** preferred over hand-typing metadata; date fields accept supported date expressions.
- **Dashboard:** stacks to a single column in narrow panes without changing the saved desktop layout.

## Reminders and background limits

Task Manager is JavaScript running inside Obsidian, not a mobile background service. Polling and notifications require the app/plugin to execute. The mobile OS may suspend Obsidian in the background; force-closing it prevents checks. Missed-reminder logging can surface elapsed reminders on return but cannot make a closed app run.

System notification availability/permission varies by Obsidian and OS. Test on the exact device and keep a calendar/OS-native fallback for critical reminders.

## Voice privacy

Browser/OS Web Speech can be cloud-backed even though Task Manager needs no API key. Whisper fallback explicitly uploads recorded audio to OpenAI. Review [`PRIVACY.md`](PRIVACY.md) before first use and do not speak confidential content unless the chosen provider is acceptable.

## Calendar export

The iCal export is a one-way snapshot. Import it into a calendar app for that app's alerts, then re-export after task changes. Importing or editing the calendar does not write back unless a separately configured, documented sync integration is used.

## Mobile safety checklist

1. Back up the vault and keep integrations off for the first run.
2. Test create/edit/complete/query and one reminder while Obsidian remains open.
3. Background and force-close the app to understand actual OS behavior.
4. Confirm desktop-only companion controls are absent/not started.
5. Test swipe preview, contextual-menu swipe, vertical-scroll cancellation, completion Undo, and Defer failure feedback against normal scrolling and large text/zoom.
6. Never copy desktop plugin folders or sample-vault configuration into a real mobile vault without reviewing settings/data.
