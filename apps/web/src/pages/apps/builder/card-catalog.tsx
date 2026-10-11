/**
 * The card catalog: every `AppCardKind`, what it is for, and — when the Base
 * cannot host it yet — why (no table; no choice / person field for a board; no
 * date field for a calendar; nothing to fill in for a form).
 */

import type { AppCardKind } from '@greenhouse/types/apps';
import { Dialog } from '../../../components/ui';
import { useT, type TranslationKey } from '../../../lib/i18n';
import {
  BarChart3,
  CalendarDays,
  ClipboardList,
  Code2,
  Columns3,
  GalleryHorizontal,
  Gauge,
  Kanban,
  MousePointerClick,
  Plug,
  Table2,
  Type,
  type LucideIcon,
} from '../../../lib/icons';
import { CATALOG_CARD_KINDS, catalogBlocker, type BuilderSchema, type CatalogBlocker } from './spec-model';

export const CARD_KIND_ICONS: Readonly<Record<AppCardKind, LucideIcon>> = {
  records: Table2,
  kanban: Kanban,
  calendar: CalendarDays,
  gallery: GalleryHorizontal,
  form: ClipboardList,
  kpi: Gauge,
  chart: BarChart3,
  pivot: Columns3,
  text: Type,
  buttons: MousePointerClick,
  custom: Code2,
  external: Plug,
};

const BLOCKER_KEYS: Record<CatalogBlocker, TranslationKey> = {
  noTables: 'apps.builder.catalog.blocked.noTables',
  noLaneField: 'apps.builder.catalog.blocked.noLaneField',
  noDateField: 'apps.builder.catalog.blocked.noDateField',
  noWritableField: 'apps.builder.catalog.blocked.noWritableField',
};

export function CardCatalog({
  open,
  onClose,
  onPick,
  schema,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (kind: AppCardKind) => void;
  schema: BuilderSchema;
}) {
  const t = useT();
  return (
    <Dialog open={open} onClose={onClose} title={t('apps.builder.catalog.title')} size="lg">
      <p className="mb-3 text-xs text-fg-muted">{t('apps.builder.catalog.intro')}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="app-card-catalog">
        {CATALOG_CARD_KINDS.map((kind) => {
          const Icon = CARD_KIND_ICONS[kind];
          const blocker = catalogBlocker(kind, schema);
          return (
            <button
              key={kind}
              type="button"
              disabled={blocker !== null}
              onClick={() => onPick(kind)}
              data-testid={`app-catalog-${kind}`}
              className="flex min-h-11 items-start gap-3 rounded-lg border border-edge bg-surface-card p-3 text-left transition-colors hover:border-primary-edge hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-edge disabled:hover:bg-surface-card"
            >
              <span className="mt-0.5 inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-primary-fg">
                <Icon size={16} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-fg">
                  {t(`apps.builder.catalog.kinds.${kind}.name`)}
                </span>
                <span className="block text-xs leading-4 text-fg-muted">
                  {t(`apps.builder.catalog.kinds.${kind}.description`)}
                </span>
                {blocker && <span className="mt-1 block text-[11px] text-warning">{t(BLOCKER_KEYS[blocker])}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}
