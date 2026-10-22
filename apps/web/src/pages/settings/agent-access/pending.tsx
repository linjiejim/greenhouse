/**
 * Pending approvals — writes your agents (or, for an admin, machine clients)
 * are waiting on. One card per request; deciding runs the write at most once
 * on the server, so a double click or a second tab can only lose.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  AGENT_WRITE_GRANT_DAY_OPTIONS,
  type AgentWriteGrantDayOption,
  type AgentWritePendingView,
} from '@greenhouse/types/agent-access';
import { Button, Card, EmptyState, Select, Spinner, toast } from '../../../components/ui';
import { Bot, Inbox, ShieldAlert } from '../../../lib/icons';
import { useI18n, useT } from '../../../lib/i18n';
import { timeAgo } from '../../../lib/utils';
import { decideAgentWrite } from '../../../lib/api/agent-access';
import { Collapsible, JsonBlock, OperationLabel, RiskTag, useStatusLabel } from './shared';

function useRelativeFuture() {
  const { locale } = useI18n();
  return (iso: string | null) => {
    if (!iso) return '';
    const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
    const rtf = new Intl.RelativeTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', { numeric: 'auto' });
    if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
    return rtf.format(Math.round(minutes / 60), 'hour');
  };
}

function PendingCard({
  request,
  highlighted,
  onDecided,
}: {
  request: AgentWritePendingView;
  highlighted: boolean;
  onDecided: () => void;
}) {
  const t = useT();
  const relativeFuture = useRelativeFuture();
  const statusLabel = useStatusLabel();
  const [busy, setBusy] = useState<null | 'approve' | 'grant' | 'reject'>(null);
  const [days, setDays] = useState<AgentWriteGrantDayOption>(7);
  const ref = useRef<HTMLDivElement>(null);
  const irreversible = request.risk === 'r3';

  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlighted]);

  const decide = async (kind: 'approve' | 'grant' | 'reject') => {
    if (!request.interrupt_id) return;
    setBusy(kind);
    try {
      const result = await decideAgentWrite(
        request.interrupt_id,
        kind === 'reject' ? 'reject' : 'approve',
        kind === 'grant' ? days : undefined,
      );
      if (result.status === 'executed') {
        toast(
          kind === 'grant' ? t('agentAccess.decidedApprovedGrant', { days }) : t('agentAccess.decidedApproved'),
          'success',
        );
      } else if (result.status === 'rejected') {
        toast(t('agentAccess.decidedRejected'), 'success');
      } else if (result.status === 'failed') {
        toast(t('agentAccess.decidedFailed', { error: result.error ?? '' }), 'error');
      } else {
        toast(t('agentAccess.alreadyDecided', { status: statusLabel(result.status) }), 'info');
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(null);
      onDecided();
    }
  };

  return (
    <div ref={ref} data-testid={`agent-write-request-${request.request_id}`}>
      <Card
        className={`p-4 space-y-3 transition-shadow ${highlighted ? 'ring-2 ring-primary-300 ring-offset-1 ring-offset-surface-canvas' : ''}`}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5 text-sm text-fg">
              <Bot size={14} className="text-fg-muted flex-shrink-0" />
              <span className="font-medium">{t('agentAccess.wantsTo', { client: request.client_name })}</span>
              <OperationLabel view={request} />
            </div>
            <div className="text-[11px] text-fg-faint">
              {timeAgo(request.created_at)} · {t('agentAccess.expiresIn', { time: relativeFuture(request.expires_at) })}
              {request.owner_nickname ? ` · ${t('agentAccess.forMember', { name: request.owner_nickname })}` : ''}
            </div>
          </div>
          <RiskTag risk={request.risk} />
        </div>

        <Collapsible
          openLabel={t('agentAccess.hideInput')}
          closedLabel={t('agentAccess.showInput')}
          defaultOpen={highlighted || JSON.stringify(request.input ?? null).length < 400}
        >
          <JsonBlock value={request.input} />
        </Collapsible>

        {irreversible && (
          <p className="flex items-start gap-1.5 text-xs text-danger-fg bg-danger-subtle rounded-lg px-2.5 py-2">
            <ShieldAlert size={13} className="flex-shrink-0 mt-0.5" />
            {t('agentAccess.irreversibleNote')}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void decide('approve')} disabled={busy !== null}>
            {busy === 'approve' ? <Spinner className="h-3.5 w-3.5" /> : null}
            {t('agentAccess.approve')}
          </Button>
          {!irreversible && (
            <div className="inline-flex items-center gap-1.5">
              <Button size="sm" variant="secondary" onClick={() => void decide('grant')} disabled={busy !== null}>
                {busy === 'grant' ? <Spinner className="h-3.5 w-3.5" /> : null}
                {t('agentAccess.approveAndAllow')}
              </Button>
              <Select
                size="sm"
                value={String(days)}
                onChange={(event) => setDays(Number(event.target.value) as AgentWriteGrantDayOption)}
                aria-label={t('agentAccess.grantDays')}
                disabled={busy !== null}
              >
                {AGENT_WRITE_GRANT_DAY_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option === 1 ? t('agentAccess.allowDay') : t('agentAccess.allowDays', { days: option })}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <Button size="sm" variant="ghost" onClick={() => void decide('reject')} disabled={busy !== null}>
            {busy === 'reject' ? <Spinner className="h-3.5 w-3.5" /> : null}
            {t('agentAccess.reject')}
          </Button>
        </div>
      </Card>
    </div>
  );
}

export function PendingApprovals({
  requests,
  loading,
  highlightId,
  onChanged,
}: {
  requests: AgentWritePendingView[];
  loading: boolean;
  highlightId: string | null;
  onChanged: () => void;
}) {
  const t = useT();
  if (loading && requests.length === 0) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }
  if (requests.length === 0) {
    return (
      <EmptyState icon={Inbox} title={t('agentAccess.pendingEmpty')} description={t('agentAccess.pendingEmptyHint')} />
    );
  }
  return (
    <div className="space-y-3">
      {requests.map((request) => (
        <PendingCard
          key={request.request_id}
          request={request}
          highlighted={request.request_id === highlightId}
          onDecided={onChanged}
        />
      ))}
    </div>
  );
}
