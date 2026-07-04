/**
 * Fork extension point for the CRUD framework — the ONLY file a downstream fork
 * edits to register private field/column widget *types* for @greenhouse/crud.
 *
 * Upstream (greenhouse) ships this EMPTY. app.tsx calls registerCrudExtensions()
 * once at startup, so a fork's widgets (e.g. an EditorJS field, an image
 * uploader) are available to any schema via `{ type: 'extension', name: '...' }`
 * WITHOUT editing the framework core. Mirrors the push-style seam pattern used by
 * branding.extensions / page-registry / artifact-renderers.
 *
 * Fork example (in the fork's copy of this file):
 *   import { registerCrudField, registerCrudColumn } from '@greenhouse/crud';
 *   import { EditorField } from './crud/editor-field';
 *   export function registerCrudExtensions(): void {
 *     registerCrudField('editor', EditorField);
 *   }
 */

/** Register private CRUD field/column widget types. Empty upstream. */
export function registerCrudExtensions(): void {
  // upstream: no-op
}
