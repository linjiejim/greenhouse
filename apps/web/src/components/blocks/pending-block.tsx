/**
 * A registered Rich Output block the model is still writing.
 *
 * Reserves stable space under a one-line label instead of exposing half a JSON
 * payload or half an HTML document; the finished block replaces it in place.
 * Datatables keep their table-shaped skeleton (the most common long block).
 */

import type { RichFence } from './index';
import { DataTablePendingBlock } from './datatable-block';
import { RichBlockShell, richBlockBodyClass } from './rich-block-shell';
import { Skeleton, Spinner } from '../ui';
import { useT } from '../../lib/i18n';

const LABEL_KEYS = {
  chart: 'richBlocks.pendingChart',
  datatable: 'richBlocks.pendingTable',
  confirm: 'richBlocks.pendingConfirm',
  mermaid: 'richBlocks.pendingDiagram',
  'html-preview': 'richBlocks.pendingPage',
  'mission-artifacts': 'richBlocks.pendingFiles',
  attachments: 'richBlocks.pendingFiles',
} as const satisfies Record<RichFence, string>;

export function RichBlockPending({ fence, compact = false }: { fence: RichFence; compact?: boolean }) {
  const t = useT();
  if (fence === 'datatable') return <DataTablePendingBlock compact={compact} />;

  return (
    <RichBlockShell
      compact={compact}
      header={
        <div className="flex items-center gap-2 text-xs text-fg-muted" role="status">
          <Spinner />
          <span>{t(LABEL_KEYS[fence])}</span>
        </div>
      }
    >
      <div className={richBlockBodyClass(compact)} aria-hidden="true">
        <Skeleton className={compact ? 'h-16 w-full' : 'h-24 w-full'} />
      </div>
    </RichBlockShell>
  );
}
