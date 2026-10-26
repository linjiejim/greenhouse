/**
 * The import surface for web extensions (`apps/web/src/extensions/<id>/`): the
 * contract plus the host pieces a page needs.
 *
 * This barrel IS the stable API (with the define types, `@greenhouse/types` and
 * `@greenhouse/crud`); everything else in the web app is internal and may change
 * in any release. `scripts/check-extension-overlay.mjs` reports extension files
 * that import past it. The export list is locked by
 * `__tests__/extension-kit.snapshot.test.ts`: removing or renaming a symbol
 * means updating the snapshot and a CHANGELOG line starting `extension-kit:`.
 */
export { defineWebExtension } from './extensions/define';
export type {
  WebExtension,
  WebExtensionPage,
  WebExtensionNavItem,
  WebExtensionModule,
  WebExtensionToolCard,
  ExtensionPageProps,
  ExtensionToolCallView,
  ExtensionTranslationKey,
} from './extensions/define';

export { authFetch } from './lib/auth';
export { useT, useI18n, translate } from './lib/i18n';
export type { Locale } from './lib/i18n';
export { useAuthStore } from './stores';
export { useExtensionsStore, useHasExtension } from './stores/extensions-store';
export { canUseFeature } from './lib/features';
export { Button, Input, Spinner, Badge, toast, ConfirmDialog } from './components/ui';
export { ModulePage } from './components/app/module-page';
export { usePageActions } from './hooks/usePageActions';

// ─── Compatibility ──────────────────────────────────────
export { EXTENSION_SDK } from '@greenhouse/utils/extension-compat';

// ─── Icons (every icon the app uses, plus the lookup helpers) ─
export * from './lib/icons';

// ─── Navigation, pins, context menu, page shells ────────
export { extensionPageModules, localizeNavModule } from './lib/nav-registry';
export type { NavModule } from './lib/nav-registry';
export { usePinStore } from './stores/pin-store';
export { ContextMenu, useContextMenu } from './components/app/context-menu';
export { ModulePageShell, CachedModule } from './components/app/module-page-shell';
export type { AnyTranslationKey } from './lib/i18n';

// ─── HTTP and formatting ────────────────────────────────
export { qs, fetchJson } from './lib/http';
export { timeAgo, formatDate, formatDay, safeParse } from './lib/utils';
export type { TagTone } from './lib/utils';
export {
  STICKY_LEFT_HEADER,
  STICKY_RIGHT_HEADER,
  STICKY_LEFT_CELL,
  STICKY_RIGHT_CELL,
  STICKY_CELL_SURFACE,
  STICKY_HEADER_SURFACE,
} from './lib/sticky-columns';
export { usePersistedPageSize } from './hooks/use-persisted-page-size';

// ─── Components ─────────────────────────────────────────
export {
  EmptyState,
  SearchInput,
  Select,
  Tag,
  TagList,
  Card,
  Tabs,
  Skeleton,
  SkeletonRow,
  SkeletonCard,
  Pagination,
  Dialog,
  Textarea,
  Checkbox,
  ErrorBoundary,
} from './components/ui';
export { InlineEditCell } from './components/tables/inline-edit-cell';
export type { InlineEditOption } from './components/tables/inline-edit-cell';
export { DetailHeader, DetailSection, FieldGrid, Field } from './components/detail/detail-kit';
export { Markdown } from './components/markdown';
export { DriveBrowser } from './components/drive/drive-browser';
export { useEntityNavigate, useInEntityPeek } from './components/entity-peek/context';

// ─── Members and agent context ──────────────────────────
export { fetchShareableUsers } from './lib/api/sessions';
export type { ShareableUser } from '@greenhouse/types/api';
export type { ContextProviderDescriptor, ExtensionPageContext, QuickAction } from '@greenhouse/types/agent-context';

// Host capabilities used by official plugin packages.
export { IconButton, Toggle } from './components/ui';
export { SettingsSection, SettingsPanel } from './components/settings/index';
export { clientLabelKey, formatUsdPrice } from './lib/metering/format';
export { relativeTime } from './lib/utils';
export { flagSourceKey } from './lib/workspace-flags';
export { defineCrud, CrudPage, type CrudDataSource } from './pages/settings/crud';
export { KpiCard } from './components/usage/usage-widgets';
export { MediaPreviewDialog } from './components/media-preview-dialog';

export { saveWorkspaceSettings } from './lib/api/workspace-settings';
export { RetroButton } from './pages/administration/retro-button';
