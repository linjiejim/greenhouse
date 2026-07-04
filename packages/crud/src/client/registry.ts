/**
 * Field/column extension registry — the push-style seam that lets a fork add a
 * new field or column *type* without editing the framework core (mirrors the
 * ARTIFACT_RENDERERS / EXTENSION_TOOL_MODULES pattern elsewhere in the repo).
 *
 * A schema references a registered widget with `{ type: 'extension', name: '...' }`.
 * Register at app startup (see the fork's crud.extensions seam).
 */

import type { ReactNode } from 'react';

export interface CrudFieldRenderProps {
  value: unknown;
  onChange: (value: unknown) => void;
  form: Record<string, unknown>;
  mode: 'add' | 'edit';
  disabled?: boolean;
  placeholder?: string;
  config?: Record<string, unknown>;
}

export type CrudFieldComponent = (props: CrudFieldRenderProps) => ReactNode;

export interface CrudColumnRenderProps {
  value: unknown;
  row: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export type CrudColumnRenderer = (props: CrudColumnRenderProps) => ReactNode;

const fieldRegistry = new Map<string, CrudFieldComponent>();
const columnRegistry = new Map<string, CrudColumnRenderer>();

export function registerCrudField(name: string, component: CrudFieldComponent): void {
  fieldRegistry.set(name, component);
}

export function getCrudField(name: string): CrudFieldComponent | undefined {
  return fieldRegistry.get(name);
}

export function registerCrudColumn(name: string, renderer: CrudColumnRenderer): void {
  columnRegistry.set(name, renderer);
}

export function getCrudColumn(name: string): CrudColumnRenderer | undefined {
  return columnRegistry.get(name);
}
