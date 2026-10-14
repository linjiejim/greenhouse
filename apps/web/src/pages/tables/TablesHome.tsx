/**
 * 表格 (TBL-01): my bases and those shared with me, pinned first; archived ones on their own
 * page. A base opens on its first data table and view.
 */

import { useState } from 'react';
import { Archive, Pin, Table2 } from 'lucide-react';
import { Badge, Button, Empty, ErrorBox, Segmented, Skeleton } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { BaseSummary } from '@greenhouse/contract';
import { useSession } from '../../app/session';
import { useBases } from '../../data/tables';
import { useI18n } from '../../lib/i18n';
import { href } from '../../lib/router';
import { relativeTime } from '../../lib/time';
import { Page, PageHeader } from '../../shell/Page';
import { useOpenOverlay } from '../../shell/overlays';
import { tablesError } from './errors';
import { NewBaseDialog } from './NewBaseDialog';
import '../../styles/tables.css';

function BaseRow({ base }: { base: BaseSummary }) {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const tables = base.tables.map((table) => table.name).join(' · ');
  return (
    <li>
      <a className="app-list-row" href={href({ page: 'base', id: base.id })}>
        <Table2 size={icon.md} className="app-file-icon" aria-hidden />
        <span className="app-list-main">
          <span className="app-list-title">{base.name}</span>
          <span className="app-list-meta">{tables}</span>
        </span>
        {base.pinned && <Pin size={icon.sm} className="app-muted" aria-label={t('tables.pinned')} />}
        {base.owner_id !== me?.id && <Badge>{t('tables.sharedWithMe')}</Badge>}
        {base.access === 'viewer' && <Badge>{t('tables.readOnly')}</Badge>}
        <span className="app-list-time">
          {t('tables.updatedAt', { time: relativeTime(base.updated_at, { locale, timeZone: me?.timezone ?? 'UTC' }) })}
        </span>
      </a>
    </li>
  );
}

export function TablesHome() {
  const { t } = useI18n();
  const openOverlay = useOpenOverlay();
  const [scope, setScope] = useState<'mine' | 'archived'>('mine');
  const bases = useBases(scope === 'archived');
  const items = [...bases.items].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  const create = () => openOverlay({ type: 'custom', render: (close) => <NewBaseDialog onClose={close} /> });
  return (
    <Page
      header={
        <PageHeader
          title={t('nav.tables')}
          primary={
            <Button kind="primary" onClick={create}>
              {t('tables.new')}
            </Button>
          }
        />
      }
    >
      <div className="app-toolbar">
        <Segmented
          label={t('nav.tables')}
          items={[
            { value: 'mine', label: t('tables.mine') },
            { value: 'archived', label: t('tables.archived') },
          ]}
          value={scope}
          onChange={(next) => setScope(next as 'mine' | 'archived')}
        />
      </div>
      {bases.isPending ? (
        <Skeleton lines={4} />
      ) : bases.isError ? (
        <ErrorBox onRetry={() => void bases.refetch()}>{tablesError(bases.error, t)}</ErrorBox>
      ) : !items.length ? (
        scope === 'archived' ? (
          <Empty icon={<Archive strokeWidth={icon.stroke} />} title={t('tables.noneArchived')} />
        ) : (
          <Empty
            icon={<Table2 strokeWidth={icon.stroke} />}
            title={t('tables.none')}
            action={
              <Button kind="primary" onClick={create}>
                {t('tables.new')}
              </Button>
            }
          />
        )
      ) : (
        <ul className="app-list" aria-label={t('nav.tables')}>
          {items.map((base) => (
            <BaseRow key={base.id} base={base} />
          ))}
        </ul>
      )}
    </Page>
  );
}
