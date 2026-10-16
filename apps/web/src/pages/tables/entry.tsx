/** How the shell reaches 表格: the last base opened, and the rail's "new" menu. */

import { LayoutGrid, Plus } from 'lucide-react';
import type { MenuEntry } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { Translate } from '../../lib/i18n';
import { store } from '../../lib/media';
import type { Route } from '../../lib/router';
import type { OverlayRequest } from '../../shell/overlays';
import { NewBaseDialog } from './NewBaseDialog';

const LAST = 'tables.last';

/** Where the rail's 表格 goes: the base opened last, else the list of bases. */
export function lastBase(): Route {
  const id = readLast();
  return id ? { page: 'base', id } : { page: 'tables' };
}

function readLast(): string {
  try {
    return localStorage.getItem(`greenhouse.${LAST}`) ?? '';
  } catch {
    return '';
  }
}

export const rememberBase = (id: string) => store(LAST, id);
export const forgetBase = (id: string) => {
  if (readLast() === id) store(LAST, '');
};

/** Opens 新建表格 (blank, or with the 「项目」 template chosen). */
export const openNewBase = (open: (request: OverlayRequest) => void, template?: 'project') =>
  open({ type: 'custom', render: (close) => <NewBaseDialog template={template} onClose={close} /> });

export function tablesMenu(t: Translate, open: (request: OverlayRequest) => void): MenuEntry[] {
  const glyph = (Icon: typeof Plus) => <Icon size={icon.md} strokeWidth={icon.stroke} />;
  return [
    { label: t('tables.new'), icon: glyph(Plus), onClick: () => openNewBase(open) },
    { label: t('tables.fromTemplate'), icon: glyph(LayoutGrid), onClick: () => openNewBase(open, 'project') },
  ];
}
