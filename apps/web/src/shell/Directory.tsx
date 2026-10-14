/**
 * The module directory (layout.md): a 56 title row (module name, search, collapse), one full-width
 * primary action, the list, and low-traffic entries at the bottom. Search opens in place.
 */

import { useState } from 'react';
import {
  Activity,
  Bell,
  CalendarClock,
  CheckCircle2,
  Inbox,
  KeyRound,
  LayoutGrid,
  Link2,
  PanelLeftClose,
  Plug,
  Plus,
  Search,
  Server,
  Shield,
  Sparkles,
  User,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Button, IconButton, SearchInput } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { useSession } from '../app/session';
import { useNotificationSummary } from '../data/notifications';
import { useRuns } from '../data/runs';
import { useT } from '../lib/i18n';
import { href, navigate, SKILL_SCOPES, type AdminSection, type Route, type SettingsSection } from '../lib/router';
import type { MessageKey } from '../i18n/zh';
import { KnowledgeDirectory, useNewTarget } from '../pages/knowledge/KnowledgeDirectory';
import { openNewBase } from '../pages/tables/entry';
import { TablesDirectory } from '../pages/tables/TablesDirectory';
import { ChatDirectory } from './ChatDirectory';
import { DirectoryRow } from './DirectoryRow';
import { MODULES, type ModuleId } from './modules';
import { useOpenOverlay } from './overlays';

const glyph = (Icon: LucideIcon) => <Icon size={icon.md} strokeWidth={icon.stroke} />;

/** The sections this build has; the rest join when their features land (features.md). */
export const SETTINGS: { id: SettingsSection; label: MessageKey; icon: LucideIcon }[] = [
  { id: 'account', label: 'settings.account', icon: User },
  { id: 'notifications', label: 'settings.notifications', icon: Bell },
  { id: 'connections', label: 'settings.connections', icon: Link2 },
  { id: 'vault', label: 'settings.vault', icon: KeyRound },
  { id: 'services', label: 'settings.services', icon: Server },
  { id: 'access', label: 'settings.access', icon: Shield },
];

export const ADMIN: { id: AdminSection; label: MessageKey; icon: LucideIcon }[] = [
  { id: 'members', label: 'admin.members', icon: Users },
  { id: 'services', label: 'admin.services', icon: Server },
  { id: 'usage', label: 'admin.usage', icon: Activity },
  { id: 'connectors', label: 'admin.connectors', icon: Plug },
  { id: 'access', label: 'admin.access', icon: Shield },
  { id: 'public-agents', label: 'admin.public-agents', icon: Sparkles },
  { id: 'branding', label: 'admin.branding', icon: LayoutGrid },
];

function RunsList({ route }: { route: Route }) {
  const t = useT();
  const active = useRuns('active');
  const view = route.page === 'runs' ? route.view : null;
  return (
    <>
      <DirectoryRow
        leading={glyph(Activity)}
        title={t('runs.active')}
        href={href({ page: 'runs', view: 'active' })}
        active={view === 'active'}
        count={active.items.length}
      />
      <DirectoryRow
        leading={glyph(CalendarClock)}
        title={t('runs.scheduled')}
        href={href({ page: 'runs', view: 'scheduled' })}
        active={view === 'scheduled'}
      />
      <DirectoryRow
        leading={glyph(CheckCircle2)}
        title={t('runs.done')}
        href={href({ page: 'runs', view: 'done' })}
        active={view === 'done'}
      />
    </>
  );
}

function NotificationsList({ route }: { route: Route }) {
  const t = useT();
  const summary = useNotificationSummary();
  const view = route.page === 'notifications' ? route.view : null;
  return (
    <>
      <DirectoryRow
        leading={glyph(Bell)}
        title={t('notifications.needsYou')}
        href={href({ page: 'notifications', view: 'needs' })}
        active={view === 'needs'}
        signal={{ needs: summary.data?.needs_you }}
      />
      <DirectoryRow
        leading={glyph(Inbox)}
        title={t('notifications.all')}
        href={href({ page: 'notifications', view: 'all' })}
        active={view === 'all'}
        signal={{ unread: (summary.data?.unread ?? 0) > 0 }}
      />
    </>
  );
}

export function Directory({
  module,
  route,
  floating,
  onHide,
}: {
  module: ModuleId;
  route: Route;
  /** A drawer over the page (narrow and medium widths) rather than a column. */
  floating: boolean;
  onHide: () => void;
}) {
  const t = useT();
  const { me } = useSession();
  const openOverlay = useOpenOverlay();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const newTarget = useNewTarget(route);
  const name = t(MODULES[module].label);
  const primary =
    module === 'chat'
      ? { label: t('chat.newChat'), onClick: () => navigate('#/c/new') }
      : module === 'knowledge'
        ? { label: t('knowledge.new'), onClick: () => openOverlay({ type: 'new-knowledge', target: newTarget() }) }
        : module === 'agents'
          ? { label: t('agents.new'), onClick: () => openOverlay({ type: 'new-agent' }) }
          : module === 'skills'
            ? { label: t('skills.new'), onClick: () => openOverlay({ type: 'new-skill' }) }
            : module === 'tables'
              ? { label: t('tables.new'), onClick: () => openNewBase(openOverlay) }
              : null;

  return (
    <>
      <div className="app-directory-heading">
        {searching ? (
          <SearchInput
            label={t('directory.searchIn', { name })}
            value={query}
            onChange={setQuery}
            autoFocus
            onEscape={() => setSearching(false)}
          />
        ) : (
          <h2>{name}</h2>
        )}
        {(module === 'chat' || module === 'agents' || module === 'knowledge' || module === 'tables') && (
          <IconButton
            label={searching ? t('directory.closeSearch') : t('directory.searchIn', { name })}
            onClick={() => {
              setSearching(!searching);
              setQuery('');
            }}
          >
            {searching ? glyph(X) : glyph(Search)}
          </IconButton>
        )}
        <IconButton label={floating ? t('common.close') : t('nav.collapseDirectory')} onClick={onHide}>
          {floating ? glyph(X) : glyph(PanelLeftClose)}
        </IconButton>
      </div>
      {primary && (
        <Button className="app-directory-create" kind="primary" onClick={primary.onClick}>
          <Plus size={icon.md} strokeWidth={icon.stroke} />
          {primary.label}
        </Button>
      )}
      <div className="app-directory-list">
        {module === 'chat' && <ChatDirectory route={route} query={query} />}
        {module === 'knowledge' && <KnowledgeDirectory route={route} query={query} />}
        {module === 'tables' && <TablesDirectory route={route} query={query} />}
        {module === 'agents' && (
          <>
            {(['mine', 'public', 'archived'] as const).map((scope) => (
              <DirectoryRow
                key={scope}
                title={t(`agents.${scope}`)}
                href={href({ page: 'agents', scope })}
                active={route.page === 'agents' && route.scope === scope}
              />
            ))}
          </>
        )}
        {module === 'skills' &&
          SKILL_SCOPES.filter((scope) => scope !== 'review' || me?.role === 'admin').map((scope) => (
            <DirectoryRow
              key={scope}
              title={t(`skills.scope.${scope}`)}
              href={href({ page: 'skills', scope })}
              active={route.page === 'skills' && route.scope === scope}
            />
          ))}
        {module === 'runs' && <RunsList route={route} />}
        {module === 'notifications' && <NotificationsList route={route} />}
        {module === 'settings' &&
          SETTINGS.map((section) => (
            <DirectoryRow
              key={section.id}
              leading={glyph(section.icon)}
              title={t(section.label)}
              href={href({ page: 'settings', section: section.id })}
              active={route.page === 'settings' && route.section === section.id}
            />
          ))}
        {module === 'admin' &&
          me?.role === 'admin' &&
          ADMIN.map((section) => (
            <DirectoryRow
              key={section.id}
              leading={glyph(section.icon)}
              title={t(section.label)}
              href={href({ page: 'admin', section: section.id })}
              active={route.page === 'admin' && route.section === section.id}
            />
          ))}
      </div>
    </>
  );
}
