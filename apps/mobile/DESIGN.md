# apps/mobile design rules

## Structure

- The root is the system tab bar: 首页 · 知识库 · 云盘 · 项目; each tab has its own native stack. Search is a bar button on home that pushes the search page.
- A conversation is the only full pushed page; every other object opens through openObject (src/shell/open-object.ts) as a form sheet.
- Sheets stack on sheets up to three; the fourth replaces the top one. ✕ closes only the sheet it sits on.
- Documents, files, folders and projects open full height; tasks, records, notifications, runs and writes open at 0.6 and grow.
- Tab lists (知识库, 云盘, 项目, and pages pushed in them) have a compact bar: inline title, then search as a bar button and + on the same row; no large titles, no second row.
- A refresh the app starts never moves a list: a pull shows the pull spinner, any other refresh with rows on screen a small spinner in the bar (src/ui/refresh.tsx), a first load Skeleton or LoadingState.
- Edits happen in sheets (SwiftUI Form on iOS, Material on Android); the page underneath never changes behind them.
- Long-press menus are system context menus (NativeMenu) and every item is also a VoiceOver action.

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
- Native bars, the tab bar, menus, alerts and the keyboard follow the system size and font only.
- Nunito is the face everywhere it can apply; Chinese falls back to PingFang.
- One-line titles cut at the tail; file names cut in the middle so the extension stays.

## Icons and color

- Icons come from ICONS in src/ui/core.tsx at three sizes: 13 in chips and text, 17–20 in rows and controls, 28+ only for empty states.
- Colors come from useTheme(); hex.* only where a string is required; no raw hex in app/ or feature folders except data colors marked as such.
- Content sits on solid system surfaces; Liquid Glass is only for the control layer (composer, floating buttons).

## States and feedback

- Every list has an empty, a loading and a failed state; a cached copy shown offline says 离线中 above the list.
- Success says itself with toast and notifySuccess; failure with alertError (technical detail behind 详情); never both.
- Selection changes tick (selectionTick); long presses and holds tap (tapMedium); nothing else vibrates.
- Optimistic writes (pin, read marks, task status) roll back and say so when the station refuses.

## Guard

- src/theme/design-guard.test.ts fails on raw hex colors or raw font sizes in app/ and feature folders.
