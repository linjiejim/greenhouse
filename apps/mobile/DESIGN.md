# apps/mobile design rules

## Structure

- There is no tab bar: a sidebar (the mark, the product name and a round search button on top; 首页 · 知识库 · 云盘 · 项目 · 定时任务; 「我」 at its foot) swaps the places, each with its own native stack; search is a tool, not a place. On a phone the sidebar lies a layer under the place, on its own deeper surface (sidebarBackground), and an edge swipe on a place's first page or the bar button at the top left slides the place aside (iOS drawerType 'back'); deeper pages keep that swipe for back. An iPad at regular width keeps it on screen as a split view. Search and the bell stay at the top right of home.
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

- The assistant is Sprouty in every language; its living face is in the header (src/chat/header-avatar.tsx) and glides below the title while a reply is written; the header grows and the list makes the same room, so it never covers a message; it is Sprouty's one presence: message rows carry no avatar, only a compact "Sprouty" line with the tappable status, and home's greeting sprout is the only other one.
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
- EmptyState covers empty, failed (with retry) and not-allowed (without retry); Skeleton covers a list's first load; LoadingState is for small inline waits.

## Spacing and shape

- Page margin is space.margin (16); text inside cards starts at space.margin + space.xs.
- Spacing follows the 4-pt scale in src/theme.ts and lands on the 8-pt rhythm between blocks (space.sm, space.lg, space.xxl).
- Radii come from radius.* with squircle; cards use radius.group, chips radius.md (inline radius.sm), bubbles radius.bubble.
- Touch targets are at least HIT (44); chips under messages are HIT - space.sm tall with HIT hit slop around them.

## Type

- Text takes a role from typo.* (largeTitle … caption2) and adjusts weight only with weight.*; never a raw fontSize.
- typo follows the in-app text size (seven steps, 0.8–1.35) times Dynamic Type; read it inside makeStyles or render, never into module constants.
- Native bars, menus, alerts and the keyboard follow the system size and font only.
- Nunito is the face everywhere it can apply; Chinese falls back to PingFang.
- One-line titles cut at the tail; file names cut in the middle so the extension stays.

## Icons and color

- Icons come from ICONS in src/ui/core.tsx at three sizes: 13 in chips and text, 17–20 in rows and controls, 28+ only for empty states.
- Colors come from useTheme(); hex.* only where a string is required; no raw hex in app/ or feature folders except data colors marked as such.
- Content sits on solid system surfaces; Liquid Glass is only for the control layer (composer, floating buttons).

## States and feedback

- Every list has an empty, a loading and a failed state; a cached copy shown offline says 离线中 above the list.
- Success says itself with toast and notifySuccess; failure with alertError (technical detail behind 详情); never both.
- Selection changes tick (selectionTick); long presses and holds tap (tapMedium); the drawer reaching fully open taps once (tapLight); Sprouty on home answers each tap (tapLight) and its easter egg with notifySuccess; nothing else vibrates.
- Optimistic writes (pin, read marks, task status) roll back and say so when the station refuses.

## Guard

- src/theme/design-guard.test.ts fails on raw hex colors or raw font sizes in app/ and feature folders.
