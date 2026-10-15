/**
 * The 表格 directory (PRD §6.1): pinned bases, then my bases; each base opens into its data
 * tables (each into its views) and its dashboards. Rows have the same actions as the object's own "⋯".
 */

import { useEffect, useState } from 'react';
import {
  Columns3,
  GanttChart,
  CalendarDays,
  LayoutDashboard,
  LayoutGrid,
  Pin,
  PinOff,
  Table2,
  Trash2,
  Pencil,
  Images,
} from 'lucide-react';
import type { MenuEntry } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { roleAtLeast, type BaseSummary, type ViewType } from '@greenhouse/contract';
import { useNotify } from '../../app/notify';
import { refreshBase, useBases } from '../../data/tables';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { href, navigate, type Route } from '../../lib/router';
import { DirectoryRow, DirectorySection } from '../../shell/DirectoryRow';
import { useOpenOverlay } from '../../shell/overlays';
import { DeleteBaseDialog } from './DeleteBaseDialog';
import { tablesError } from './errors';

const VIEW_ICONS: Record<ViewType, typeof Table2> = {
  grid: Table2,
  kanban: Columns3,
  calendar: CalendarDays,
  gallery: Images,
  timeline: GanttChart,
  dashboard: LayoutDashboard,
};

export const viewIcon = (type: ViewType, size: number = icon.md) => {
  const Icon = VIEW_ICONS[type];
  return <Icon size={size} strokeWidth={icon.stroke} aria-hidden />;
};

const glyph = (Icon: typeof Table2) => <Icon size={icon.md} strokeWidth={icon.stroke} />;

function BaseTree({ base, route, query }: { base: BaseSummary; route: Route; query: string }) {
  const { t } = useI18n();
  const notify = useNotify();
  const openOverlay = useOpenOverlay();
  const here = route.page === 'base' && route.id === base.id ? route : null;
  const [opened, setOpen] = useState(!!here);
  const open = opened || !!query.trim();
  const [openTables, setOpenTables] = useState<Set<string>>(() => new Set(here?.table ? [here.table] : []));
  const [renaming, setRenaming] = useState<string | null>(null);
  useEffect(() => {
    if (!here) return;
    setOpen(true);
    if (here.table)
      setOpenTables((current) => (current.has(here.table!) ? current : new Set([...current, here.table!])));
  }, [here?.id, here?.table]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = (work: () => Promise<unknown>) =>
    void work()
      .then(() => refreshBase(base.id))
      .catch((error: unknown) => notify(tablesError(error, t)));
  const builder = roleAtLeast(base.access, 'builder');
  const baseMenu: MenuEntry[] = [
    base.pinned
      ? {
          label: t('tables.unpin'),
          icon: glyph(PinOff),
          onClick: () => run(() => api.tables.bases.update(base.id, { pinned: false })),
        }
      : {
          label: t('tables.pin'),
          icon: glyph(Pin),
          onClick: () => run(() => api.tables.bases.update(base.id, { pinned: true })),
        },
    ...(builder ? [{ label: t('tables.rename'), icon: glyph(Pencil), onClick: () => setRenaming(base.id) }] : []),
    ...(base.access === 'owner'
      ? [
          '-' as const,
          {
            label: t('tables.delete'),
            icon: glyph(Trash2),
            danger: true,
            onClick: () =>
              openOverlay({ type: 'custom', render: (close) => <DeleteBaseDialog base={base} onClose={close} /> }),
          },
        ]
      : []),
  ];
  return (
    <div>
      <DirectoryRow
        leading={glyph(LayoutGrid)}
        title={base.name}
        expanded={open}
        active={!!here && !here.table && !here.dashboard}
        menu={baseMenu}
        menuLabel={base.name}
        renaming={renaming === base.id}
        onRename={(name) => {
          setRenaming(null);
          if (name) run(() => api.tables.bases.update(base.id, { name }));
        }}
        onClick={() => {
          setOpen(!open);
          if (!here) navigate({ page: 'base', id: base.id });
        }}
      />
      {open &&
        base.tables.map((table) => {
          const tableOpen = !!query.trim() || openTables.has(table.id);
          const tableMenu: MenuEntry[] = builder
            ? [
                { label: t('tables.renameTable'), icon: glyph(Pencil), onClick: () => setRenaming(table.id) },
                '-',
                {
                  label: t('tables.deleteTable'),
                  icon: glyph(Trash2),
                  danger: true,
                  onClick: () =>
                    run(async () => {
                      await api.tables.tables.archive(table.id);
                      notify(t('tables.tableDeleted', { name: table.name }), {
                        label: t('tables.undo'),
                        onClick: () => run(() => api.tables.tables.restore(table.id)),
                      });
                    }),
                },
              ]
            : [];
          return (
            <div key={table.id}>
              <DirectoryRow
                leading={glyph(Table2)}
                title={table.name}
                indent={1}
                expanded={tableOpen}
                active={here?.table === table.id && !here.view}
                menu={tableMenu.length ? tableMenu : undefined}
                menuLabel={table.name}
                renaming={renaming === table.id}
                onRename={(name) => {
                  setRenaming(null);
                  if (name) run(() => api.tables.tables.update(table.id, { name }));
                }}
                onClick={() => {
                  setOpenTables((current) => {
                    const next = new Set(current);
                    if (next.has(table.id)) next.delete(table.id);
                    else next.add(table.id);
                    return next;
                  });
                  navigate({ page: 'base', id: base.id, table: table.id });
                }}
              />
              {tableOpen &&
                table.views.map((view) => (
                  <DirectoryRow
                    key={view.id}
                    leading={viewIcon(view.type)}
                    title={view.name}
                    indent={2}
                    href={href({ page: 'base', id: base.id, table: table.id, view: view.id })}
                    active={here?.view === view.id}
                  />
                ))}
            </div>
          );
        })}
      {open &&
        base.dashboards.map((dashboard) => (
          <DirectoryRow
            key={dashboard.id}
            leading={viewIcon('dashboard')}
            title={dashboard.name}
            indent={1}
            href={href({ page: 'base', id: base.id, dashboard: dashboard.id })}
            active={here?.dashboard === dashboard.id}
          />
        ))}
    </div>
  );
}

export function TablesDirectory({ route, query }: { route: Route; query: string }) {
  const { t } = useI18n();
  const bases = useBases();
  const q = query.trim().toLowerCase();
  const match = (base: BaseSummary) =>
    !q ||
    base.name.toLowerCase().includes(q) ||
    base.tables.some(
      (table) =>
        table.name.toLowerCase().includes(q) || table.views.some((view) => view.name.toLowerCase().includes(q)),
    ) ||
    base.dashboards.some((dashboard) => dashboard.name.toLowerCase().includes(q));
  const shown = bases.items.filter(match);
  const pinned = shown.filter((base) => base.pinned);
  const rest = shown.filter((base) => !base.pinned);
  if (bases.isPending) return null;
  if (q && !shown.length) return <p className="app-muted app-directory-note">{t('directory.noMatch')}</p>;
  return (
    <>
      {pinned.length > 0 && (
        <DirectorySection title={t('tables.pinned')}>
          {pinned.map((base) => (
            <BaseTree key={base.id} base={base} route={route} query={query} />
          ))}
        </DirectorySection>
      )}
      <DirectorySection title={t('tables.mine')}>
        {rest.map((base) => (
          <BaseTree key={base.id} base={base} route={route} query={query} />
        ))}
      </DirectorySection>
    </>
  );
}
