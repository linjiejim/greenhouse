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

export { type CrudFieldRenderProps } from './pages/settings/crud';

export { storeAuthenticatedSession, type AuthenticatedUser } from './lib/auth';

export { apiUrl } from './lib/api-base';

export { Avatar, Drawer, FilterPills, ResizeHandle } from './components/ui';
export { FormActions, FormError, FormField, FormGrid, FormGroup } from './components/form';
export { useAgentContext } from './components/agent-context-value';
export { usePlatformCatalog } from './stores/platform-store';
export { CATEGORICAL_CHOICES, categoricalColor, categoricalHex, categoricalName } from './lib/categorical';
export { downloadAuthenticatedFile } from './lib/file-download';
export { getStoredLocale } from './lib/i18n';
export type { TranslationKey } from './lib/i18n';

export { Tag as TagIcon } from './lib/icons';

export { bumpPatch, isValidSemver } from '@greenhouse/utils/semver';

export type { ContextMenuItem } from './components/app/context-menu';

export { useArtifactReceipt } from './hooks/use-artifact-receipt';

export { ArtifactCard } from './components/chat/artifact-card';

export { ArtifactCardActions } from './components/chat/artifact-card';

export { fetchDataCatalog } from './lib/api/hub-context';

export { driveBreadcrumb } from './lib/api/drive';

export { formatFileSize } from './lib/api/drive';

export { listDriveFiles } from './lib/api/drive';

export { listDriveFolders } from './lib/api/drive';

export { uploadDriveFile } from './lib/api/drive';

export type { DriveFile } from './lib/api/drive';

export type { DriveFolder } from './lib/api/drive';

export { isRowId } from '@greenhouse/utils/id';

export { tiptapJsonToMarkdown } from '@greenhouse/knowledge-editor/serialize';
export { registeredKnowledgeDocPanels } from './lib/extension-registries';
export { useActiveHeading } from './components/markdown';
export { useDocumentHeadings } from './components/markdown';
export type { DocHeading } from './components/markdown';
export { ChevronRight } from './lib/icons';
export { Eye } from './lib/icons';
export { Files } from './lib/icons';
export { HelpCircle } from './lib/icons';
export { Pin } from './lib/icons';
export { RotateCcw } from './lib/icons';
export { computeLineDiffWithWords } from './lib/wiki-diff';
export { renderDiffWords } from './lib/diff-words';
export { useHoverFlyout } from './hooks/use-hover-flyout';
export { knowledgeEditorExtensions } from '@greenhouse/knowledge-editor/extensions';
export { markdownToEditorHtml } from '@greenhouse/knowledge-editor/md-html';
export { uploadImage } from './lib/api/upload';
export { Bold } from './lib/icons';
export { Italic } from './lib/icons';
export { List } from './lib/icons';
export { ListOrdered } from './lib/icons';
export { MessageSquareQuote } from './lib/icons';
export { Code } from './lib/icons';
export { Link } from './lib/icons';
export { Image } from './lib/icons';
export { Undo } from './lib/icons';
export { Redo } from './lib/icons';
export { Share2 } from './lib/icons';
export { X } from './lib/icons';
export { Check } from './lib/icons';
export { Lock } from './lib/icons';
export { registerNavigationGuard } from './lib/navigation-guard';
export { Archive } from './lib/icons';
export { ChevronDown } from './lib/icons';
export { Edit3 } from './lib/icons';
export { FileEdit } from './lib/icons';
export { FolderOpen } from './lib/icons';
export { History } from './lib/icons';
export { Plus } from './lib/icons';
export { Save } from './lib/icons';
export { Paperclip } from './lib/icons';
export { ArrowDown } from './lib/icons';
export { ArrowUp } from './lib/icons';
export { Download } from './lib/icons';
export { Folder } from './lib/icons';
export { FolderPlus } from './lib/icons';
export { MoreHorizontal } from './lib/icons';
export { Pencil } from './lib/icons';
export { FileText } from './lib/icons';
export { Trash2 } from './lib/icons';
export { SidebarToolbar } from './components/app/sidebar-toolbar';
export { toSearchSummary } from './lib/search-summary';
export { createDriveFolder } from './lib/api/drive';
export { updateDriveFolder } from './lib/api/drive';
export { deleteDriveFolder } from './lib/api/drive';
export { computeOrder } from './components/app/sidebar-panels/use-tree-drag';
export { isSameOrder } from './components/app/sidebar-panels/use-tree-drag';
export { useTreeDrag } from './components/app/sidebar-panels/use-tree-drag';
export { NO_DRAG_ATTR } from './components/app/sidebar-panels/use-tree-drag';
export type { DropEdge } from './components/app/sidebar-panels/use-tree-drag';
export { ExternalLink } from './lib/icons';
export { ScrollText } from './lib/icons';

export { BookOpen } from './lib/icons';
export { Clock } from './lib/icons';
export { Library } from './lib/icons';
export { fetchTeamContextSettings } from './lib/api/hub-context';
export { saveTeamContextSettings } from './lib/api/hub-context';

export { extensionSlots } from './extensions/index';
