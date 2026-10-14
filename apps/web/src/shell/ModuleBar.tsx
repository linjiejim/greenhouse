/** Narrow screens: the drawer ends with the module bar, as in the native app (PRD §6.2). */

import { MoreHorizontal } from 'lucide-react';
import { Menu } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { useSession } from '../app/session';
import { useT } from '../lib/i18n';
import { navigate } from '../lib/router';
import { MODULES, type ModuleId } from './modules';

export function ModuleBar({ module }: { module: ModuleId }) {
  const t = useT();
  const { me } = useSession();
  const Chat = MODULES.chat.icon;
  const Knowledge = MODULES.knowledge.icon;
  return (
    <nav className="app-module-bar" aria-label={t('nav.main')}>
      <button type="button" aria-current={module === 'chat' ? 'page' : undefined} onClick={() => navigate('#/c/main')}>
        <Chat size={icon.lg} strokeWidth={icon.stroke} />
        <span>{t('nav.chat')}</span>
      </button>
      {me?.modules.knowledge && (
        <button
          type="button"
          aria-current={module === 'knowledge' ? 'page' : undefined}
          onClick={() => navigate({ page: 'knowledge' })}
        >
          <Knowledge size={icon.lg} strokeWidth={icon.stroke} />
          <span>{t('nav.knowledge')}</span>
        </button>
      )}
      <Menu
        className="app-module-bar-more"
        label={t('nav.more')}
        trigger={
          <>
            <MoreHorizontal size={icon.lg} strokeWidth={icon.stroke} />
            <span>{t('nav.more')}</span>
          </>
        }
        items={[
          { label: t('nav.agents'), onClick: () => navigate({ page: 'agents', scope: 'mine' }) },
          { label: t('nav.runs'), onClick: () => navigate({ page: 'runs', view: 'active' }) },
          '-',
          { label: t('nav.settings'), onClick: () => navigate({ page: 'settings', section: 'account' }) },
          ...(me?.role === 'admin'
            ? [{ label: t('nav.admin'), onClick: () => navigate({ page: 'admin', section: 'members' }) }]
            : []),
        ]}
      />
    </nav>
  );
}
