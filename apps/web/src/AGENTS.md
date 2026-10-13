# apps/web: v1 frontend conventions

These rules cover v1 code until each module is rewritten for v2 (docs/product, docs/design-system, roadmap M1–M3, built on packages/ui).
Fix v1 bugs freely, but never extend a module that docs/product/features.md marks 删除 or 合并, and never mix v2 patterns (in-drawer editing, `--gh-*` tokens) into v1 code.

## Components
- Build UI from the shared components (components/ui.tsx, form/, detail/, media-preview-dialog.tsx) instead of raw elements with inline Tailwind: Input, Select, Textarea, Checkbox, Toggle, SearchInput, DateRangeInput, Avatar, StatusDot, Tag, TagList, Skeleton, Spinner, DetailHeader, DetailSection, FieldGrid, Field, MediaPreviewDialog.
- Icon-only actions use IconButton with a label (it supplies the accessible name and, at default size, a 44px mobile target); split panes use ResizeHandle.
- Notify with toast() and confirm with ConfirmDialog; never alert() or window.confirm().
- New dialogs and palettes go through OverlayFrame (add a variant for a new shape) and side panels through Drawer or OverlayPanel; never hand-roll fixed inset-0, backdrops, safe-area padding or height caps.
- CRUD create and edit forms open a centered Dialog (size="workspace" for dense content); browse and detail panels open a right Drawer; editing from a Drawer opens a Dialog; long or multi-step editing gets a full page.
- Icons come only from lib/icons.ts (Lucide), never emoji; the logo renders only through AppLogo, which honours workspace branding.
- Forms compose FormField, FormGrid, FormSection and FormActions; never hand-write label, help, error or footer markup.
- Empty states use EmptyState with an icon from lib/icons.ts; never add a second centered button after it, keep "—" in dense cells, and never show a failed load as empty.
- Show an Agent's avatar through BotAvatar, BotAvatarStack or AgentAvatar, never by resolving the plant yourself; change stored avatars only through the @greenhouse/types/plant-avatar writers (withPlant, withTint); avatars in lists, rows, stacks and pickers stay static, and only the speaking Agent and large heroes animate.
- Import @greenhouse/ui by subpath, never the root barrel, and add any newly used packages/ui directory to the @source list in app.css.
- components/workbench/widget-grid.tsx also renders Tables dashboards (pages/tables/dashboard-view.tsx); keep it when the workbench is deleted.

## Pages and navigation
- Overview, list and settings pages are rooted in ModulePage (components/app/module-page.tsx), whose identity comes from lib/nav-registry.ts; never add your own page header, padding, max-width or scroll container, and never a second header on immersive detail pages.
- ModulePage layout is form, list or canvas; canvas content owns its scroll (h-full min-h-0 overflow-y-auto).
- A Settings or Administration page registers in lib/nav-registry.ts (SETTINGS_TOP, SETTINGS_LABS or ADMINISTRATION_MODULES, with requireFeature when flag-gated), is imported in pages/settings/index.tsx or pages/administration/index.tsx, and builds sections from SettingsPanel and SettingsSection.
- List pages use @greenhouse/crud through pages/settings/crud.ts, never the package directly; its access flags default to false, so declare canEdit or canDelete whenever update or remove exist (tests/web/crud-write-access.test.ts).
- Navigation comes from usePlatformCatalog(); the client never widens permissions, and direct app URLs wait for the catalog and fail closed.
- Conversations have one nav entry (Chat) and one sidebar list (ConversationsSidebarPanel); never add a separate Bots entry.
- Scope switches (Mine, Shared, Team) open on Mine every time; never persist a widened scope.

## Styling and accessibility
- Use semantic tokens only (`surface-*`, `fg-*`, edge, status, destructive, `primary-*`); never bg-white, `gray-*`, `red-*`, named palette colors such as teal-500 or hex values. Colors follow the theme through `--t-*` variables, so never add dark: variants for color.
- The page canvas is bg-surface-canvas; never use surface-sunken as a page background.
- Rows (sidebar, menus, history) show selection with .sidebar-active-item and aria-current, without outlines or side bars; bounded controls (chips, segments) use bg-primary-subtle with border-primary-edge, and custom chip groups set aria-pressed.
- Text on bg-primary-subtle uses text-primary-fg-strong; brand fills inside prose use var(--t-primary-wash).
- Never use a translucent token as a ring or edge drawn over other content; lib/theme-contrast.test.ts checks adjacent pairs.
- Focus rings come from the global :root …:focus-visible rule in app.css; a component's `focus:ring-*` is decoration, never the focus indicator.
- Put `title={value}` next to every truncate.

## Mobile web
- Every new UI works at 375px; md is the mobile/desktop boundary.
- Touch targets are at least 44px, and key actions never depend on hover: use `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 touch-visible`.
- Overlay height caps follow the safe area; never calc(100dvh - constant).
- Keyboard geometry comes from useMobileKeyboardViewport with .mobile-keyboard-lift and .mobile-visual-viewport; never add another keyboard padding.
- Fixed-width popovers get `max-w-[calc(100vw-2rem)]`; a popover that would open past the viewport edge becomes a Dialog.
- Hover flyouts use useHoverFlyout with a padding hover bridge, never margins or local close timers.

## Lists and tables
- Sticky headers work only when the table is the direct child of the single overflow-auto container, so never wrap it in another overflow-x-auto; pinned columns use lib/sticky-columns.ts with opaque cell backgrounds.
- Table cells stay single-line: nowrap on th and td, long text in an inner truncate span with title, tags through Tag or TagList with tones from lib/utils.ts.
- Inline cell edits open from a pencil button, never on double-click; row action cells stopPropagation.
- Paginate with Pagination (0-based) and usePersistedPageSize, resetting the page when the size changes; never hand-write Prev/Next.
- Drag with pointer events through hooks/use-drag-gesture.ts (use-list-reorder, use-tree-drag), never HTML5 draggable, which cannot start from a button; injected CDP drag events prove nothing.

## Chat and rich output
- ConversationPane (components/conversation/conversation-pane.tsx) is the one controller for full Chat and the Assistant overlay; surface-policy.ts may hide peripheral affordances only, never attachments, tool cards, ask_user, confirm, edit, retry or error recovery.
- Consume chat streams only through SessionManager.runStream; only an explicit finish counts as success (requireChatStreamFinish), and stop goes through the server.
- Build /api/chat bodies as the shared ChatRequestBody and send rich_blocks from webRichBlocks(), which declares html-preview only while the side pane host is mounted.
- Register, snapshot and run client actions per scope_id; the scope key is the path without the query; page actions fail closed when the page changes; global actions never expire and rely on safety 'confirm' answered by ActionConfirmDialog.
- RICH_BLOCKS in @greenhouse/types/rich-output is the only block list; never write another fence list or regex.
- Validate block data only in the registry's parse(), never in components, where a render-time throw unmounts the whole message; keep each block in its own ErrorBoundary.
- stats, cards, steps and block buttons exist once in @greenhouse/ui/components/blocks; a block button only sends its value as the next message.
- While streaming, an unclosed registered block shows a placeholder at once instead of raw JSON or HTML; settled messages render any unclosed remainder as code, never a spinner.
- The html-preview fence (never plain html, which stays copyable source) renders in iframes with srcdoc and sandbox="allow-scripts" only; never add allow-same-origin, blob: URLs or an open-in-new-window path (side-pane/html-preview.render.test.tsx). Its bridge only appends to the composer after a user gesture and never sends.
- The PDF print frame keeps PRINT_FRAME_SANDBOX without allow-scripts, and exported HTML passes sanitizeExportHtml.
- Mermaid stays lazy-loaded with securityLevel 'strict' and falls back to a code block.
- Images from /api/chat-files need the token, so render them through components/files/auth-image.tsx; attachment previews require both an allowlisted extension and an allowlisted response MIME.
- Chat surfaces pass linkTarget="new-window"; an entity link's href is its only identity; new peek kinds go into @greenhouse/types/entity-links and entity-peek/registry.tsx, new side-pane previews into SidePaneEntry and side-pane/registry.tsx, never onto a Drawer.
- Request cards in Bots keep the key `request:<id>` in live and persisted rows, or a finished run remounts them and drops typed input.
- Every exit from the Bots computer pane goes through ComputerPaneHandle.requestClose so a takeover is handed back.
- Every Bots state renders BotsBareHeader or BotsMobileNavButton, because the route hides the TopBar.
- Other members' public Agents live in sharedBots, never in bots (pickers, @ lists, invites).

## Data, state and i18n
- Typed calls live in `lib/api/<domain>.ts` on rpc (lib/api/client.ts); never cast responses with as; hc does not encode path params, so encodeURIComponent any value that may contain / or %; streaming and FormData stay on authFetch; no new fetchJson.
- Global state lives in Zustand stores (stores/); never add a React Context for global state.
- Reuse lib/utils.ts (formatDate for timestamps, formatDay for calendar dates, palettes, tone maps) and lib/csv-export.ts; never redefine them in components.
- All visible copy goes through useT() (translate() outside React); never widen the visible-copy.test.ts exemptions to get past it.
- Render server display text with useLocalized() or pickLocalized(), never profile.name directly, and never translate user-written content.
- Renaming a knowledge doc never changes its slug; slug rules live in components/knowledge/doc-slug.ts.
- Runtime static assets use publicAssetUrl(); a new root-level static file needs both ROOT_STATIC_FILES (apps/api/src/index.ts) and isPublicPath (apps/api/src/auth/middleware.ts).
- Source maps stay off except in a controlled WEB_BUILD_SOURCEMAP=true build, because /assets is public.
- Activation tokens are read from the URL fragment, cleared with history.replaceState at once, and never sent in a query, stored or logged.
