# apps/client design rules

One client for web, desktop (Tauri), iOS and Android. Native pages render on the web through react-native-web; web-only rendering lives in `*.web.tsx`. Never build a parallel DOM app.

## Layout

- Phone (< 760): drawer sidebar under the place, one column, 44 pt targets, sheets for objects. iPad regular width keeps the sidebar as a split view.
- Wide (≥ 760, `WIDE_MIN`): rail 72 · secondary column 264 · main · inspector (default 400, 360–520). Constants live in `src/shell/wide-model.ts`; never write the numbers again.
- Secondary column collapses below 1100 (`SECONDARY_MIN`), toggles with Cmd/Ctrl+\; a place that portals nothing into it gets no column.
- Inspector docks from 1440 (`DOCK_MIN`), floats below with a transparent dismiss target; the main pane beside a docked inspector stays clickable.
- Rail: built-in places (Chat, Knowledge, Drive, Tables, Projects, Schedule, gated by the station manifest), a divider, then More; Admin (super), Activity and the account avatar sit at its foot.
- More holds every app that is not a built-in place, in a flyout beside the rail (hover, click or Enter opens; leaving, Escape or a click elsewhere closes). Keep the rail short.
- Chat width: 948 centered with 28 gutters; headers are 52 tall and opaque.

## Surfaces

- A conversation is the only full page; every other object opens through `openObject` (`src/shell/open-object.ts`): a sheet on the phone, the inspector on wide screens, at most three deep, the fourth replaces the top.
- Every web popup that is not anchored to its trigger is a centered dialog with a fixed size from `DIALOG_SIZES` (`src/ui/overlay.web.tsx`): `sm` 420 wide (confirm, prompt), `md` 560×600 (lists, short forms, Activity, Feedback), `lg` 760×640 (documents, previews, long forms), `xl` 960×680 (the settings window). Content scrolls inside `DialogBody`; the box never resizes with its content.
- Centered route sheets (`sheet-edge.web.tsx`) use the same sizes; add a route to `LARGE_SHEETS` when it needs `lg`.
- The command palette is the one top-anchored dialog: 640×480, 120 from the top.
- Anchored menus and context menus are one surface: `MenuPanel` (`src/ui/menu.web.tsx`) through `NativeMenu` or `PlaceContext`. Rows are 32 tall with optional icon, check and shortcut; destructive items are red.
- Edits happen in a sheet or dialog; the page underneath never changes behind them. A form dialog has one title bar, a scrolling body and a footer with Cancel and the primary action; Cmd/Ctrl+Enter submits.
- Every overlay restores focus when dismissed; Escape closes the top one.
- Entry pages (activation, OAuth consent, a connector's sign-in return, a binding result) are one card on the brand canvas like sign-in, without the rail; the primary action is the accent button, the way back secondary.

## Components (use these, do not re-create them)

- Pages: `Screen` / `SheetScreen` (`src/ui/screen.tsx`). Places on wide screens: `Place`, `PlaceSidebar`, `PlaceRow`, `PlaceEmpty`, `PlaceContext` (`src/ui/place.web.tsx`).
- Lists: `Section`, `Row`, `Card`, `SectionHeader`, `SectionFooter` (`src/ui/list.tsx`); virtualized rows pass `rowPosition(index, count)`. Desktop data grids use `.gh-data-grid`.
- Empty, loading, failed: `EmptyState` (native and phone), `PlaceEmpty` with `icon` + `title` (+ `action`) in wide places, `Skeleton` for a list's first load, `LoadingState` for small waits.
- Capsules: `Chip` for links, files and objects; `Badge` for status. Avatars: `Avatar` for people (initial), `AssistantAvatar` / `AgentAvatar` for agents (plants); never a plant for a person. File kinds: `FileIcon`.
- Dialog helpers: `confirmAction`, `promptText`, `alertError` (`src/ui/dialogs`); success goes through `toast`.
- Web controls are defined once, in the Controls section of `src/shell/client.css`; feature CSS (admin, automations, entry) holds layout only, never another button, field or switch.
- Buttons: `.gh-primary` (one per surface), `.gh-secondary-button`, `.gh-icon-button` (32 square, icon only, needs `aria-label`), `.gh-link-button` (quiet inline action); add `.gh-danger` when destructive.
- Forms: `.gh-form` stacks fields inside `DialogBody`; `.gh-form-grid` for two columns, `.gh-form-section` with a `legend` (or `.gh-form-heading`) for groups, `.gh-button-row` for a row of actions.
- Fields: `.gh-field` puts the label above the control, then `.gh-hint` or `.gh-error`; `.gh-field-label` when the caption is not a `<label>`.
- Inputs: `.gh-input` for input, select and textarea (controls in a `.gh-form` or directly in a `.gh-field` get it without the class); `.gh-mono` for code-like values.
- Choices: `.gh-check` (checkbox with an optional `small` line), `.gh-switch` (`button role="switch"` or a checkbox), `.gh-segmented` (buttons marked checked, pressed or selected), `.gh-tabs` under a bar or atop a dialog body.
- Notes: `.gh-callout` (warning; `data-tone` info, danger or neutral) with `.gh-callout-text`; status is a `.gh-badge` (`data-tone` success, warning, danger, info, accent), several in a `.gh-chip-row`.
- Blocks: `.gh-card` (header, `.gh-card-body` or `.gh-card-flush` around a grid), `.gh-toolbar` with compact fields and a `.gh-count`, `.gh-setting-row` (label column, control, hint under it) above a sticky `.gh-savebar`, `.gh-dialog-footer-lead` before a dialog's Cancel and primary action.
- Control sizes: 32 tall (28 in a toolbar or filter row, 44 below `WIDE_MIN` and on entry pages), radius 8, text 14; labels 13, hints 12.
- Native forms use `src/ui/native-form` / `form-controls`; their browser fields are `.gh-input`.

## Admin

- Administration is a place (super only, wide only), not a settings page: grouped sections in the secondary column (members, usage and spend, workspace, integrations, then plugin sections from the manifest), the chosen section in the main column with a 52 bar, optional tabs or a filter toolbar, and 32-row data grids.
- Lists are tables; a row opens its edit dialog; per-row actions sit at the row end. Settings read as label/control rows in cards with a sticky save bar.
- Destructive actions confirm first; a secret shows once in a callout with Copy.

## Tokens

- Spacing: 4-pt scale (`space.*`: 2 4 8 12 16 20 24 32), 8-pt rhythm between blocks; page margin 16, desktop place padding 20.
- Radius: controls 8, dialogs, menus and the rail flyout 12, cards 16, native inset cards `radius.group` (26) with squircle; menu rows 6.
- Type: a role from `typo.*` (largeTitle 28/36, title1 22, title2 18, title3 15, body 14/22, callout 16/26, footnote 13, caption1 12), weight only through `weight.*`; never a raw `fontSize` outside `src/ui` and `src/theme`. In-app text size (0.8–1.35) multiplies every role.
- Icons from `ICONS` (`src/ui/core.tsx`): 13 inline and in chips, 16 in menus, rows and toolbar buttons, 18 in dialog headers, 21 in the rail, 24–28 in empty states. New icons go into core.tsx, core.web.tsx and icon-map.ts, then `python3 apps/client/scripts/android-icons.py`.
- Colors: `useTheme()` in TS; `var(--gh-*)` in CSS, only variables the shell defines (generated web colors plus the few set in `wide-shell.web.tsx`). Stored project or tag colors draw through `categoricalFor()`; text on accent is `onAccent`.
- Desktop density: rows 32, toolbar targets 28–32, headers 52.
- Nunito everywhere it applies (Chinese falls back to PingFang). One-line titles cut at the tail; file names cut in the middle.
- Content sits on solid surfaces; Liquid Glass is only for the control layer on iOS (composer, floating buttons).

## Content

- Things start by asking Sprouty: on the phone, empty states and + on Schedule open a drafted request; the wide Schedule place opens its editor, with asking Sprouty beside it.
- Schedule's secondary column has two sections, my automations (active, then paused) and custom agents (mine, then the team's; `?view=agents&id=` links one). New, Edit and Duplicate open an `lg` dialog; the schedule builder offers hourly, daily, weekdays, weekly, monthly and custom cron, always shown in words with the next three runs on the automation's own clock.
- Home: greeting, composer, suggestion pills, then recent conversations as one-line titles with a short age; count from preferences (0/3/5/10).
- Sprouty's face sits once in the conversation header with a status caption; message rows carry no avatar.
- A reply's tool steps never change its height: one status line opens the steps sheet; each step starts collapsed.
- Lists are compact: a document is one line with its date at the trailing edge; my bubble grows to 80% of the content width.

## States and feedback

- Every list has empty, loading and failed states; a cached copy shown offline says so above the list.
- Success shows a toast; failure shows `alertError` with technical detail behind Details; never both.
- A refresh never moves a list: pull spinner for a pull, a small bar spinner otherwise.
- Optimistic writes roll back and say so when the station refuses.
- Haptics only for selection changes, long presses, the drawer reaching open and Sprouty on home.

## Accessibility and input

- Menus are reachable from the keyboard (Enter, Shift+F10, arrows); every long-press item is also a VoiceOver action.
- Passive chips share their row's click target and take no focus; checked state is exposed through ARIA.
- Shortcuts: Cmd/Ctrl+K search, Cmd/Ctrl+1–6 places, Cmd/Ctrl+\ secondary column, Cmd/Ctrl+, settings, Escape closes the top overlay.

## Guard

- `src/theme/design-guard.test.ts` fails on raw hex colors or raw font sizes in app/ and feature folders, and on any `var(--gh-*)` the shell does not define.
