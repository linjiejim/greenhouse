/**
 * "Apply this Tables change?" — a Bot proposed a schema plan (`tables_schema_plan`
 * in a Bots turn raises a `tables_plan` request). The card shows what the server
 * wrote when the plan was drafted, in the member's language: who gains or loses
 * access and what gets published (first, highlighted), then every operation.
 * Apply runs the plan as the member on the server (`bots/engine/requests.ts`);
 * afterwards each line shows how it came out and the card links to what was
 * built. The card itself changes nothing.
 */

import { useState } from 'react';
import type { BotRequestView, BotTablesPlanPayload, BotTablesPlanResult } from '@greenhouse/types/bots';
import { ArtifactCard, ArtifactCardActions } from '../chat/artifact-card';
import { Button } from '../ui';
import { Columns3 } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { appBuilderHref } from '../../lib/app-routes';
import { AccessChangeList, StatusIcon } from '../tables/schema-plan-card';
import { useRequestDecision, type RequestCardCallbacks } from './request-decision';
import { ExpiredFooter, useSettledStatus } from './request-card-parts';
import type { BotLookup } from './transcript-rows';

export function TablesPlanCard({
  request,
  lookup,
  onSettled,
  onStale,
  onAskAgain,
}: RequestCardCallbacks & { request: BotRequestView; lookup: BotLookup; onAskAgain: (botId: string) => void }) {
  const t = useT();
  const payload = request.payload as Partial<BotTablesPlanPayload>;
  const result = request.status === 'resolved' ? (request.result as BotTablesPlanResult | null) : null;
  const name = lookup(request.bot_id)?.name ?? t('bots.deletedBot');
  const { busy, decide } = useRequestDecision(request, { onSettled, onStale });
  const { pending, expired, status: settledStatus } = useSettledStatus(request);
  const [open, setOpen] = useState(false);
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  const access = Array.isArray(payload.access) ? payload.access : [];

  const state = result?.state;
  const status =
    busy || state === 'applying'
      ? { label: t('apps.agent.planRequest.applying'), tone: 'info' as const, busy: true }
      : state === 'applied'
        ? { label: t('apps.agent.planRequest.applied'), tone: 'success' as const }
        : state === 'partial'
          ? { label: t('apps.agent.planRequest.partial'), tone: 'warning' as const }
          : state === 'failed'
            ? { label: t('apps.agent.planRequest.failed'), tone: 'danger' as const }
            : settledStatus;
  const counted = result && typeof result.applied === 'number';
  const meta = [
    payload.summary,
    counted
      ? t('apps.agent.planRequest.tally', {
          applied: result.applied ?? 0,
          failed: result.failed ?? 0,
          skipped: result.skipped ?? 0,
        })
      : t('apps.agent.planRequest.linesCount', { count: lines.length }),
  ]
    .filter(Boolean)
    .join(' · ');
  const appId = result?.app_ids?.[0];
  const baseId = result?.base_id ?? payload.base_id;

  return (
    <ArtifactCard
      icon={<Columns3 size={14} />}
      title={t('apps.agent.planRequest.title', { name })}
      meta={meta}
      status={status}
      tone={pending ? 'accent' : state === 'failed' ? 'danger' : 'neutral'}
      collapsed={!pending && !expired && !open}
      onToggle={pending || expired ? undefined : () => setOpen((value) => !value)}
      footer={
        pending ? (
          <ArtifactCardActions hint={t('apps.agent.planRequest.hint')}>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide({ decision: 'deny' })}>
              {t('apps.agent.planRequest.decline')}
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void decide({ decision: 'approve' })}
              data-testid="bots-tables-plan-apply"
            >
              {busy ? t('apps.agent.planRequest.applying') : t('apps.agent.planRequest.apply')}
            </Button>
          </ArtifactCardActions>
        ) : result && (appId !== undefined || baseId !== undefined) && state !== 'applying' ? (
          <ArtifactCardActions>
            {baseId !== undefined && (
              <Button size="sm" variant="outline" onClick={() => (window.location.hash = `#/tables/${baseId}`)}>
                {t('apps.agent.planRequest.openBase')} →
              </Button>
            )}
            {appId !== undefined && (
              <Button size="sm" variant="outline" onClick={() => (window.location.hash = appBuilderHref(appId))}>
                {t('apps.agent.planRequest.openApp')} →
              </Button>
            )}
          </ArtifactCardActions>
        ) : (
          <ExpiredFooter request={request} onAskAgain={onAskAgain} />
        )
      }
    >
      <div className="space-y-2.5" data-testid="bots-tables-plan-card">
        {access.length > 0 && <AccessChangeList lines={access} />}
        <ul className="space-y-1">
          {lines.map((line, index) => {
            const outcome = result?.lines?.[index];
            return (
              <li key={`${index}:${line.op}`} className="flex items-start gap-2 text-xs">
                {outcome ? (
                  <span className="mt-0.5">
                    <StatusIcon status={outcome.status} />
                  </span>
                ) : (
                  <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-fg-faint" />
                )}
                <div className="min-w-0 flex-1">
                  <span className="text-fg-muted">{line.label}</span>{' '}
                  <span className="break-words font-medium text-fg">{line.target}</span>
                  {outcome?.message && (
                    <p className={`text-[10px] ${outcome.status === 'applied' ? 'text-fg-muted' : 'text-danger'}`}>
                      {outcome.message}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {result?.error && <p className="text-[11px] text-danger">{result.error}</p>}
      </div>
    </ArtifactCard>
  );
}
