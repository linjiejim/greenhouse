/**
 * @greenhouse/ui — shared presentational UI kit for Greenhouse frontends
 * (web SPA today; browser-extension / other shells tomorrow).
 *
 * Barrel of the component layer. Lib helpers (icons, utils, api-base, theme,
 * i18n, stream utils, diff helpers) are exposed as subpaths — e.g.
 * `@greenhouse/ui/lib/icons` — and are NOT re-exported here, because the icon
 * names (Tag, X, Image, …) would collide with component names.
 *
 * Everything in this package must stay presentational: props/callbacks only,
 * no zustand stores, no router, no app-specific API clients.
 */

export * from './components/ui';
export * from './components/markdown';
export * from './components/rich-markdown';
export * from './components/blocks/index';
export * from './components/blocks/chart-block';
export * from './components/blocks/confirm-block';
export * from './components/blocks/datatable-block';
export * from './components/blocks/local-files-block';
export * from './components/tool-call/index';
export * from './components/tool-call/tool-call-card';
export * from './components/tool-call/body-artifacts';
export * from './components/tool-call/update-page-card';
export * from './components/tool-call/artifact-renderers';
export * from './components/chat/ask-user-card';
export * from './components/chat/streaming-message-bubble';
export * from './components/chat/reasoning-panel';
export * from './components/sprouty/index';
