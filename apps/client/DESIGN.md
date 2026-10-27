# apps/client design rules

## Structure

- There is no tab bar: a sidebar (the mark, the product name and a round search button on top; 首页 · 知识库 · 云盘 · 项目 · 定时任务; 「我」 at its foot) swaps the places, each with its own native stack; search is a tool, not a place. On a phone the sidebar lies a layer under the place, on its own deeper surface (sidebarBackground), and an edge swipe on a place's first page (on home a rightward swipe anywhere, except while writing) or the bar button at the top left slides the place aside (iOS drawerType 'back'); deeper pages keep that swipe for back. An iPad at regular width keeps it on screen as a split view. Search and the bell stay at the top right of home.
- A conversation is the only full pushed page (in home's stack, so the iPad sidebar stays beside it); every other object opens through openObject (src/shell/open-object.ts) as a form sheet.
- Sheets stack on sheets up to three; the fourth replaces the top one. ✕ closes only the sheet it sits on.
- Documents, files, folders and projects open full height; tasks, records, notifications, runs, writes and automations open at 0.6 and grow.
- Lists are compact: a document is one line, title then date at the trailing edge; 知识库's first segment is 最近 (opened on this phone).
- Place lists (知识库, 云盘, 项目, and pages pushed in them) have a compact bar: inline title, then search as a bar button and + on the same row; no large titles, no second row.
- A refresh the app starts never moves a list: a pull shows the pull spinner, any other refresh with rows on screen a small spinner in the bar (src/ui/refresh.tsx), a first load Skeleton or LoadingState.
- Edits happen in sheets (SwiftUI Form on iOS, Material on Android); the page underneath never changes behind them.
- Long-press menus are system context menus (NativeMenu) and every item is also a VoiceOver action.

## Home

- Things are made by asking Sprouty first: 定时任务's + and its empty state open a new conversation with a drafted request (never a cron form); a form, where one exists, is the secondary path.
- Home is where a conversation starts: the greeting, then my recent conversations as quiet one-line titles with a short age (3m, 8h, 1d, 2w), no snippet; 3 by default, 0/3/5/10 in 「我」 (src/store/prefs.ts `homeRecent`), and All for the rest.

## Conversation

- The assistant is Sprouty in every language; its living face sits fixed at the left of the conversation's title (src/chat/header-avatar.tsx), its expression following the reply, with a quiet caption line under the title: the agent's name, or while a reply is written what it does now (Thinking…, the running tool in words, Writing…); it is Sprouty's one presence: message rows carry no avatar, only a compact "Sprouty" line with the tappable status, and home's greeting sprout is the only other one.
- A reply's tool steps never change the reply's height: one line beside "Sprouty" says what runs now, else how many steps it took, and opens the steps sheet: every step starts collapsed to one line (status, name, what it was about or the short error, chevron); a tap opens what was asked, what came back and raw on demand.
- My bubble grows to 80% of the content width; the cap sits on the long-press menu's wrapper, never as a percentage on the bubble inside it.
- The composer is one rounded glass field, 52 pt tall on one line, on an opaque band of the page's surface that reaches through the bottom safe area (nothing shows through under it): + at the leading edge, send (dimmed and disabled with nothing to send) or stop at the trailing edge. There is no voice input; the keyboard's dictation covers it.
- The page's ⋯ menu holds Pin, Rename and Delete; new conversation sits left of it. The first load is a small spinner, never a list skeleton.

## Skeleton components

- Screen and SheetScreen (src/ui/screen.tsx) declare the title, actions and ✕; the list or scroll view after them is the screen's root.
- Section, Row, Card, SectionHeader, SectionFooter (src/ui/list.tsx) build every list; virtualized rows pass rowPosition(index, count).
- Chip (src/ui/chip.tsx) is the only capsule for links, files and objects; Badge is the only status capsule.
- Avatar is a person's initial; AssistantAvatar and AgentAvatar are plants (src/ui/avatar.tsx); never draw a plant for a person.
- FileIcon (src/ui/file-icon.tsx) shows a file's kind; never pick a file icon by hand.
- EmptyState covers empty, failed (with retry) and not-allowed (without retry), with Sprouty asleep (its error face on a failure) like the web; Skeleton covers a list's first load and never moves; LoadingState is for small inline waits.

## Spacing and shape

- Page margin is space.margin (16); text inside cards starts at space.margin + space.xs.
- Spacing follows the 4-pt scale in src/theme.ts and lands on the 8-pt rhythm between blocks (space.sm, space.lg, space.xxl).
- Radii come from radius.\* (the shared scale, src/theme.ts) with squircle; cards use radius.group (26, matching UIKit's inset-grouped sections), chips radius.md (inline radius.sm), bubbles radius.bubble; a choice that may wrap is a row with radius.md, never a pill.
- Touch targets are at least HIT (44); chips under messages are HIT - space.sm tall with HIT hit slop around them.

## Type

- Text takes a role from typo._ (largeTitle … caption2) and adjusts weight only with weight._; never a raw fontSize.
- typo follows the in-app text size (seven steps, 0.8–1.35) times Dynamic Type; read it inside makeStyles or render, never into module constants.
- Native bars, menus, alerts and the keyboard follow the system size and font only.
- Nunito is the face everywhere it can apply; Chinese falls back to PingFang.
- One-line titles cut at the tail; file names cut in the middle so the extension stays.

## Icons and color

- Icons come from ICONS in src/ui/core.tsx at three sizes: 13 in chips and text, 17–20 in rows and controls, 28+ only for empty states.
- Colors come from useTheme(); hex.\* only where a string is required; no raw hex in app/ or feature folders except data colors marked as such; a stored project or tag colour draws through categoricalFor().
- Content sits on solid system surfaces; Liquid Glass is only for the control layer (composer, floating buttons).

## States and feedback

- Every list has an empty, a loading and a failed state; a cached copy shown offline says 离线中 above the list.
- Success says itself with toast and notifySuccess; failure with alertError (technical detail behind 详情); never both.
- Selection changes tick (selectionTick); long presses and holds tap (tapMedium); the drawer reaching fully open taps once (tapLight); Sprouty on home answers each tap (tapLight) and its easter egg with notifySuccess; nothing else vibrates.
- Optimistic writes (pin, read marks, task status) roll back and say so when the station refuses.

## Guard

- src/theme/design-guard.test.ts fails on raw hex colors or raw font sizes in app/ and feature folders.

## Browser and wide screens (C1)

- Browser and desktop builds reuse the native pages and domain hooks through react-native-web; never create a parallel DOM application.
- Web-only rendering lives in platform suffix files; native headers, forms and controls retain their system implementation.
- WideShell uses a 72 px rail, a 264 px secondary column and a 400 px inspector slot from 760 px upward.
- The secondary column collapses below 1100 px and toggles with Cmd/Ctrl+Backslash; inspectors float below 1440 px.
- Below 760 px the same drawer and single-column pages use targets of at least 44 px.
- Desktop list rows use 32 px density, toolbar buttons use 28 px targets, and focus rings use the shared accent.
- The rail order is Conversations, Knowledge, Drive, Tables, Projects, Automations; Administration, Notifications and the member avatar stay at its foot.
- Station manifests gate Knowledge, Tables and Projects; plugin overflow navigation lives in More.
- Browser colors come from shared semantic tokens copied into `web-colors.generated.ts`; keep native palette generation unchanged.
- Browser forms use grouped cards and accessible HTML inputs, while sharing validation, write guards and saves with the native forms.
- A browser edit form has one 52 px title bar, a guarded cancel action and a pinned save action; Cmd/Ctrl+Enter submits it.
- Home uses one shared flow and platform frames: composer under the greeting on wide screens, at the bottom on narrow screens.
- Browser context menus use the same items as tap menus, and the overlay restores focus when dismissed.
- Browser previews never receive same-origin privileges; unknown plugin pages explicitly offer the station's browser fallback.

## Wide chat main line (C2)

- The web header is an opaque 52 px layout row; wide conversations omit the back arrow and show title/agent, pin, share, inspector and overflow controls.
- Chat prose and its composer share a centered outer width of 948 px with 28 px gutters (892 px reading width); phone gutters and touch targets retain the single-column layout.
- Wide replies use bodyLg 16/26, an avatar/name/run-summary row and quiet copy/regenerate/branch/export buttons; native message rows retain their existing presentation.
- The composer has one growing text field, a soft circular plus and an accent send/stop circle; browser phone targets remain at least 44 px.
- Home aligns greeting, composer, pill actions and the recent card; the header reserves space above the greeting sprout on the phone.
- Browser list rows share one context and overflow menu; selected rows are tinted, arrow keys move focus and older dates use weekdays or month/day.
- Agent private conversations use the station's existing custom profiles; shared conversations expose reading, copying and export while their write controls stay absent or inert.
- Cmd/Ctrl+K opens only search and commands, at 640 px wide and 120 px from the top; Tab selects a category and Cmd/Ctrl+Enter opens a result in the inspector.
- The bell opens a 400 px popover with For me/Team activity and mark-all-read; the same notification center supplies the phone sheet.
- Account menus expose account, current station, text size, My Agents, settings and sign out; browser settings cover the viewport.
- Inspectors reuse object sheets and the root navigation stack, keep at most three levels, show Back on deeper levels and preserve the current object's scroll state when promoted.
- Inspector promotion clears the old inspector trail; closing a later inspector returns to the promoted main object.
- Inspector drag/keyboard resizing stays within 360–520 px; below 1440 the panel floats over the main column with a transparent outside dismissal target.
- Rich HTML, Mermaid and binary file previews use the opaque-origin WebFrame sandbox; preview credentials never enter the frame.
- The browser launch cover leaves on the same readiness signal or grace timeout as native; React development warnings remain developer diagnostics.

- Conversation context menus include an inspector preview; its transcript is read-only and its links may push further object levels.

## Desktop places and plugin pages (C3)

- Knowledge keeps shelves, recents and its expandable folder tree in the secondary column; the document and in-place Tiptap edit mode share the centered reading column.
- Drive keeps shelf/folder navigation in the secondary column, files in the main list/grid and authenticated previews in the inspector. Drops use the same identity-bound upload protocol as the phone.
- Tables has its own desktop place, with Base/table navigation and a DOM grid; record details reuse the inspector. Saved views apply their field order and query and reset pagination.
- Projects offer board, list and date-based Gantt views over one task tree; drag and accessible status controls use the same status mutation, with rollback on failure.
- Automation details show instructions, schedule, next run and history; history rows and Run now open the run's conversation. Creation and instruction changes remain conversation-first.
- Browser preferences use grouped rows in a full viewport settings layer, with existing account, Agent and connection pages in its sidebar; phone presentation is unchanged.
- Plugin lists use declared columns, filters and sort; records use the same inspector as built-in objects, and writes expose only actions/fields supplied by the station.
- Embedded plugin pages retain their state through theme changes and can only draft a prompt. Unsupported future page kinds keep the explicit browser fallback.
- While a browser reply is in progress, Stop remains visible even with a draft; Enter preserves the draft until the reply finishes instead of offering a premature send.

## Desktop polish (C4)

- Document readers and Tiptap editors use 28 px H1, 20 px semibold H2, and 16/28 body text; summary callouts use the accent wash and Edit is secondary.
- Document metadata shows the shelf Chip, knowledge context, tags, updated date and resolved author when supplied by the station.
- Declarative lists use 32 px headers and rows; tables keep 40 px data rows, narrow row numbers and field-type icons. Enum values use Chip, money has two fraction digits without assuming a currency, and numeric columns align right.
- Inspector fields are flat label/value rows with wrapped content and subtle section dividers, using the same actions as the phone.
- Board columns fill the main area, show status dots and counts, and cards show an assignee avatar, priority and a compact due date. Selection, hover and due urgency use semantic colors in both appearances.

## Browser interaction fixes (C5)

- Radio and checkbox choices expose their checked state through ARIA, including during live reply reconciliation.
- Passive field Chips share their containing row's click target and do not take keyboard focus.
- The visible main pane remains in the accessibility tree beside a wide inspector; phone sheets keep their modal presentation.
- Design captures show loaded content after appearance changes; embedded sample pages apply the supplied foreground and background tokens.

## Admin place

- Administration is a place, not a settings page: grouped sections in the secondary column (members, usage & spend, workspace, integrations, then plugins), the chosen section in the main column with a 52 px bar, optional tabs or a filter toolbar, and 32 px data-grid rows.
- Lists are tables; a row opens its edit dialog; per-row actions are words or icons at the row end. Settings read as label/control rows in cards with a sticky save bar.
- Every popup is a centered fixed-size dialog (sm for one value or a confirm, md for a form, lg for lists); destructive actions confirm first; secrets show once in a callout with Copy.

## macOS host (C6)

- Only the desktop bridge reserves 52 px above the rail for inset traffic lights; the browser rail uses its normal top spacing.
- The native host supplies sidebar vibrancy behind the rail and secondary column; main content stays opaque.
- Desktop settings keep the existing settings layout in a separate native window; station controls use the shared station form behavior.
- Quick ask is a 560 px borderless composer with a four-line reply preview and an explicit Open in main window action.
- Inspector dismissal preserves the underlying entity list's loaded pages and scroll position.
