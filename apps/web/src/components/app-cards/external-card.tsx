import { TableCardView, useCardLabels } from '../table-cards';
import { McpConnectCard } from '../connectors/mcp-connect-card';
import { Button, Skeleton } from '../ui';
import { useT } from '../../lib/i18n';
import type { AppCardRendererProps } from './types';

export function AppExternalCard({ card, host, state }: AppCardRendererProps<'external'>) {
  const t = useT();
  const labels = useCardLabels([], new Map());
  const result = state?.result;
  if (result?.kind === 'needs_connection')
    return <McpConnectCard data={result.connection} onContinue={() => host.retry(card)} />;
  if (state?.error || result?.kind === 'source_error')
    return (
      <div className="space-y-3 p-3 text-sm text-fg-muted">
        <p>{t('apps.runtime.external.failed')}</p>
        {result?.kind === 'source_error' && <p>{t(`apps.runtime.external.${result.reason}`)}</p>}
        <Button variant="outline" size="sm" onClick={() => host.retry(card)}>
          {t('common.retry')}
        </Button>
      </div>
    );
  if (!result) return <Skeleton className="h-full min-h-16" />;
  if (result.kind === 'table')
    return (
      <div className="h-full overflow-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              {result.columns.map((col) => (
                <th className="border-b border-edge p-2" key={col.key}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr key={i}>
                {result.columns.map((col) => (
                  <td className="max-w-80 break-words border-b border-edge p-2" key={col.key}>
                    {String(row[col.key] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {result.truncated && <p className="p-2 text-xs text-fg-muted">{t('apps.runtime.external.truncated')}</p>}
      </div>
    );
  if (result.kind !== 'kpi' && result.kind !== 'chart') return null;
  return (
    <TableCardView
      title={card.title ?? ''}
      card={{ kind: result.kind, ...(result.kind === 'chart' ? { chart: card.chart ?? { type: 'bar' } } : {}) }}
      result={result}
      fields={[]}
      labels={labels}
      onRetry={() => host.retry(card)}
    />
  );
}
