/**
 * UI-kit injection seam — this repo keeps its design-system primitives inside
 * apps/web (`src/components/ui.tsx`), and a workspace package cannot import
 * from an app. So the CRUD client declares the minimal structural contract it
 * needs (CrudUiKit) and the app installs its own components once at startup
 * (see apps/web/src/pages/settings/crud.ts). This mirrors the repo's other
 * push-style registries and keeps the framework in lockstep with the app's
 * theme AND its toast singleton (toasts render in the app's ToastContainer).
 *
 * Upstream (OSS greenhouse) imports these from @greenhouse/ui directly; if a
 * shared ui package ever lands here, this seam collapses into plain imports.
 */

import type {
  ComponentType,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import type { LucideIcon } from 'lucide-react';

/** The primitives CrudPage/CrudForm/CrudDetail render. Prop contracts are the
 *  subset the framework actually passes — the app's richer components satisfy
 *  them structurally. */
export interface CrudUiKit {
  /** Runtime locale bridge supplied by the host app. Optional for standalone consumers. */
  useT?: () => (key: string, params?: Record<string, string | number>) => string;
  Button: ComponentType<{
    variant?: 'default' | 'ghost' | 'destructive';
    size?: 'sm';
    className?: string;
    disabled?: boolean;
    title?: string;
    onClick?: () => void;
    children?: ReactNode;
    'data-testid'?: string;
  }>;
  Badge: ComponentType<{
    variant?: 'default' | 'secondary' | 'success' | 'warning' | 'destructive';
    children: ReactNode;
  }>;
  Tag: ComponentType<{ children: ReactNode }>;
  TagList: ComponentType<{ items: Array<string | number>; max?: number }>;
  Pagination: ComponentType<{
    page: number;
    pageSize: number;
    total: number;
    onPageChange: (page: number) => void;
    onPageSizeChange?: (size: number) => void;
  }>;
  Input: ComponentType<Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & { size?: 'sm' | 'md' }>;
  Select: ComponentType<Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & { size?: 'sm' | 'md' }>;
  Textarea: ComponentType<TextareaHTMLAttributes<HTMLTextAreaElement>>;
  Checkbox: ComponentType<Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label?: ReactNode }>;
  Toggle: ComponentType<{ checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }>;
  FieldHelp: ComponentType<{ content: string }>;
  Dialog: ComponentType<{
    open: boolean;
    onClose: () => void;
    title: string;
    size?: 'sm' | 'md' | 'lg' | 'xl' | 'workspace' | 'wide' | 'full';
    children: ReactNode;
  }>;
  Drawer: ComponentType<{
    open: boolean;
    onClose: () => void;
    side?: 'left' | 'right';
    width?: number;
    children: ReactNode;
  }>;
  ConfirmDialog: ComponentType<{
    open: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    description?: string;
    confirmLabel?: string;
    confirmVariant?: 'default' | 'destructive';
  }>;
  EmptyState: ComponentType<{ icon: LucideIcon; title: string; description?: string }>;
  Spinner: ComponentType<{ className?: string }>;
  toast: (message: string, variant?: 'success' | 'error' | 'info' | 'warning') => void;
}

let installed: CrudUiKit | null = null;

/** Install the app's UI kit. Call once, before the first CRUD component renders
 *  (a module-scope call in the app-side binding module is the intended spot). */
export function installCrudUi(kit: CrudUiKit): void {
  installed = kit;
}

/** Resolve the installed kit. Components call this inside render, so any
 *  module-scope installCrudUi() has already run by then. */
export function getCrudUi(): CrudUiKit {
  if (!installed) {
    throw new Error(
      '@greenhouse/crud: no UI kit installed — import the app-side crud binding (which calls installCrudUi) instead of @greenhouse/crud directly',
    );
  }
  return installed;
}
