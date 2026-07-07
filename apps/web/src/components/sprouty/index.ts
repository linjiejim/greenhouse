// Moved to @greenhouse/ui (shared UI kit) — this shim keeps the old import path working.
export * from '@greenhouse/ui/components/sprouty';
// App-level (uses web i18n): the shared "sculpt your Sprouty" editor.
export { SproutyDesigner, DEFAULT_SPROUTY_DESIGN, type SproutyDesignValue } from './sprouty-designer';
