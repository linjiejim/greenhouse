/**
 * App-side binding of @greenhouse/crud — installs this app's UI kit into the
 * framework once (module scope) and re-exports the library.
 *
 * ALWAYS import crud from HERE (`./crud`), never from '@greenhouse/crud' directly:
 * the import guarantees installCrudUi() has run before the first CrudPage
 * render, and keeps the framework on the app's design system + toast singleton.
 */

import { installCrudUi } from '@greenhouse/crud';
import { createElement } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  Drawer,
  EmptyState,
  IconButton,
  Input,
  Pagination,
  Select,
  Spinner,
  Tag,
  TagList,
  Textarea,
  Toggle,
  toast,
} from '../../components/ui';
import { CircleAlert } from '../../lib/icons';
import { useT as useAppT, type TranslationKey } from '../../lib/i18n';

function useCrudTranslations() {
  const t = useAppT();
  return (key: string, params?: Record<string, string | number>) => t(key as TranslationKey, params);
}

function CrudFieldHelp({ content }: { content: string }) {
  return createElement(IconButton, {
    label: content,
    size: 'compact',
    tooltip: 'top',
    tooltipMode: 'portal',
    wrapperClassName: '-my-1',
    className: '!h-5 !w-5',
    children: createElement(CircleAlert, { size: 12, 'aria-hidden': true }),
  });
}

installCrudUi({
  useT: useCrudTranslations,
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  Drawer,
  EmptyState,
  FieldHelp: CrudFieldHelp,
  Input,
  Pagination,
  Select,
  Spinner,
  Tag,
  TagList,
  Textarea,
  Toggle,
  toast,
});

export * from '@greenhouse/crud';
