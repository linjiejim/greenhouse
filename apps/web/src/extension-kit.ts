/**
 * The import surface for web extensions (`apps/web/src/extensions/<id>/`): the
 * contract plus the host pieces a page normally needs. Deeper imports stay
 * possible; this barrel is the documented stable subset.
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
export type { LucideIcon } from './lib/icons';
