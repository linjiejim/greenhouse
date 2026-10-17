import { useExtensions } from '../extensions/host';
import { isDesktop } from '../lib/desktop/shell';
import { useI18n } from '../lib/i18n';
import { FilteredAgents, FilteredSkills, FilteredRuns } from './FilteredDirectory';
/**
 * The module directory (layout.md): a 56 title row (module name, search, collapse), one full-width
 * primary action, the list, and low-traffic entries at the bottom. Search opens in place.
 */

import { AppsDirectory } from '../pages/apps/AppsDirectory';
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import {
  Bell,
  Activity,
  CalendarClock,
  CheckCircle2,
  Inbox,
  KeyRound,
  LayoutGrid,
  Link2,
  Monitor,
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
  // SET-09: only inside the desktop app.
  ...(isDesktop() ? [{ id: 'desktop' as const, label: 'settings.desktop' as const, icon: Monitor }] : []),
];

export const ADMIN: { id: AdminSection; label: MessageKey; icon: LucideIcon }[] = [
  { id: 'members', label: 'admin.members', icon: Users },
  { id: 'services', label: 'admin.services', icon: Server },
  { id: 'usage', label: 'admin.usage', icon: Activity },
  { id: 'connectors', label: 'admin.connectors', icon: Plug },
  { id: 'access', label: 'admin.access', icon: Shield },
  { id: 'public-agents', label: 'admin.public-agents', icon: Sparkles },
  { id: 'operations', label: 'admin.operations', icon: Shield },
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

function NotificationsList() {
  const t = useT();
  const summary = useNotificationSummary();
  return (
    <DirectoryRow
      leading={glyph(Inbox)}
      title={t('notifications.title')}
      href={href({ page: 'notifications' })}
      active
      signal={{ unread: (summary.data?.unread ?? 0) > 0 }}
    />
  );
}

const ROWS = '.app-directory-list a.app-row, .app-directory-list button.app-row';

/**
 * A refresh may move or replace the focused row (new activity reorders 今天, a pinned base
 * changes section). Moving a node drops its focus to the page, so the row with the same key takes
 * it back and arrows and Escape keep working. Focus the member moved elsewhere stays there.
 */
function useKeptRowFocus(root: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let kept: string | null = null;
    const focusin = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      kept = target.matches(ROWS) ? (target.dataset.rowKey ?? null) : null;
    };
    // A row taken out of the page loses focus without the member choosing; keep its key for that.
    const focusout = (event: FocusEvent) => {
      if (event.relatedTarget || (event.target as Node).isConnected) kept = null;
    };
    const observer = new MutationObserver(() => {
      if (kept === null || (document.activeElement && document.activeElement !== document.body)) return;
      const row = [...element.querySelectorAll<HTMLElement>(ROWS)].find((item) => item.dataset.rowKey === kept);
      if (row) row.focus();
      else kept = null;
    });
    element.addEventListener('focusin', focusin);
    element.addEventListener('focusout', focusout);
    observer.observe(element, { childList: true, subtree: true });
    return () => {
      element.removeEventListener('focusin', focusin);
      element.removeEventListener('focusout', focusout);
      observer.disconnect();
    };
  }, [root]);
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
  const { locale } = useI18n();
  const extensions = useExtensions();
  const openOverlay = useOpenOverlay();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  useKeptRowFocus(root);
  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing)
      return;
    const target = event.target as HTMLElement;
    const searchingInput = target.matches('.gh-search-input');
    if (!searchingInput && !target.matches('.app-row')) return;
    const rows = [...(root.current?.querySelectorAll<HTMLElement>(ROWS) ?? [])];
    const index = rows.indexOf(target);
    let next: HTMLElement | undefined;
    if (event.key === 'ArrowDown') next = rows[Math.min(index + 1, rows.length - 1)];
    else if (event.key === 'ArrowUp')
      next = searchingInput
        ? rows[rows.length - 1]
        : index > 0
          ? rows[index - 1]
          : (root.current?.querySelector<HTMLInputElement>('.gh-search-input') ?? undefined);
    else if (!searchingInput && event.key === 'Home') next = rows[0];
    else if (!searchingInput && event.key === 'End') next = rows[rows.length - 1];
    else if (searchingInput && event.key === 'Enter') {
      event.preventDefault();
      rows[0]?.click();
      return;
    } else if (!searchingInput && event.key === 'Escape')
      next = root.current?.querySelector<HTMLInputElement>('.gh-search-input') ?? undefined;
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };
  const newTarget = useNewTarget(route);
  const name = t(MODULES[module].label);
  const primary =
    module === 'chat'
      ? { label: t('chat.newChat'), onClick: () => navigate('#/c/new') }
      : module === 'knowledge'
        ? { label: t('knowledge.new'), onClick: () => openOverlay({ type: 'new-knowledge', target: newTarget() }) }
        : module === 'agents' && route.page !== 'agents'
          ? { label: t('agents.new'), onClick: () => openOverlay({ type: 'new-agent' }) }
          : module === 'skills' && route.page !== 'skills'
            ? { label: t('skills.new'), onClick: () => openOverlay({ type: 'new-skill' }) }
            : module === 'tables' && route.page !== 'tables'
              ? { label: t('tables.new'), onClick: () => openNewBase(openOverlay) }
              : module === 'apps' && route.page !== 'apps'
                ? { label: t('apps.new'), onClick: () => navigate({ page: 'apps', newApp: true }) }
                : null;

  return (
    <div ref={root} className="app-directory-content" onKeyDown={step}>
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
        {(module === 'chat' ||
          module === 'agents' ||
          module === 'knowledge' ||
          module === 'tables' ||
          module === 'apps' ||
          module === 'skills' ||
          module === 'runs') && (
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
        <Button
          className="app-directory-create"
          kind={module === 'knowledge' ? 'secondary' : 'primary'}
          onClick={primary.onClick}
        >
          <Plus size={icon.md} strokeWidth={icon.stroke} />
          {primary.label}
        </Button>
      )}
      <div className="app-directory-list">
        {extensions.items.flatMap((extension) =>
          (module === 'settings'
            ? (extension.settingsSections ?? [])
            : module === 'admin' && me?.role === 'admin'
              ? (extension.adminSections ?? [])
              : module === 'extensions'
                ? (extension.pages ?? [])
                : []
          )
            .filter((surface) =>
              (module === 'settings'
                ? extension.info.settings_sections
                : module === 'admin'
                  ? extension.info.admin_sections
                  : extension.info.pages
              ).includes(surface.id),
            )
            .map((surface) => (
              <DirectoryRow
                key={`${extension.id}:${surface.id}`}
                title={surface.label[locale]}
                href={
                  module === 'extensions'
                    ? href({ page: 'extension', extension: extension.id, view: surface.id, path: '', query: '' })
                    : href({
                        page: 'extension-section',
                        parent: module as 'settings' | 'admin',
                        extension: extension.id,
                        section: surface.id,
                      })
                }
              />
            )),
        )}
        {module === 'chat' && <ChatDirectory route={route} query={query} />}
        {module === 'knowledge' && <KnowledgeDirectory route={route} query={query} />}
        {module === 'apps' && <AppsDirectory route={route} query={query} />}
        {module === 'tables' && <TablesDirectory route={route} query={query} />}
        {module === 'agents' && query.trim() && <FilteredAgents route={route} query={query} />}
        {module === 'agents' && !query.trim() && (
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
        {module === 'skills' && query.trim() && <FilteredSkills route={route} query={query} />}
        {module === 'skills' &&
          !query.trim() &&
          SKILL_SCOPES.filter((scope) => scope !== 'review' || me?.role === 'admin').map((scope) => (
            <DirectoryRow
              key={scope}
              title={t(`skills.scope.${scope}`)}
              href={href({ page: 'skills', scope })}
              active={route.page === 'skills' && route.scope === scope}
            />
          ))}
        {module === 'runs' &&
          (query.trim() ? <FilteredRuns route={route} query={query} /> : <RunsList route={route} />)}
        {module === 'notifications' && <NotificationsList />}
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
    </div>
  );
}
