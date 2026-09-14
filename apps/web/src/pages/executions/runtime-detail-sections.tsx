import type { RuntimeArtifact, RuntimeEvent, RuntimeStep, RuntimeToolCall } from '@greenhouse/types/runtime';
import { DetailSection } from '../../components/detail';
import { Card, Tag, type TagTone } from '../../components/ui';
import { CheckCircle2, Clock, FileText, Wrench } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { formatFileSize } from '../../lib/file-download';
import { formatDate, formatTokens } from '../../lib/utils';
import { RuntimePayloadPanel } from './payload-panel';
import { RuntimeRiskTag } from './status-axes';

function statusTone(status: string): TagTone {
  if (status === 'succeeded' || status === 'available' || status === 'resolved') return 'success';
  if (status === 'failed' || status === 'interrupted' || status === 'uncertain') return 'danger';
  if (status === 'waiting' || status === 'paused' || status === 'awaiting_approval') return 'warning';
  if (status === 'running' || status === 'claimed') return 'primary';
  return 'neutral';
}

function technicalStatus(status: string) {
  return <Tag tone={statusTone(status)}>{status.replaceAll('_', ' ')}</Tag>;
}

export function RuntimeStepsSection({ steps }: { steps: readonly RuntimeStep[] }) {
  const t = useT();
  if (steps.length === 0) return null;
  return (
    <DetailSection title={t('taskCenter.steps')} className="mt-6">
      <div className="space-y-2">
        {steps.map((step) => (
          <Card key={step.id} className="p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Clock size={14} className="text-fg-faint" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg" title={step.step_key}>
                {step.step_key}
              </span>
              {technicalStatus(step.status)}
              <Tag tone="neutral">{step.kind}</Tag>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-fg-faint">
              <span>{t('taskCenter.attempt', { count: step.attempt })}</span>
              <span>{t('taskCenter.tokensUsed', { count: formatTokens(step.tokens_used) })}</span>
              <span>{t('taskCenter.requestsUsed', { count: step.requests_used })}</span>
              {step.duration_ms !== null && <span>{t('taskCenter.durationMs', { count: step.duration_ms })}</span>}
            </div>
            {(step.error_code || step.error_message) && (
              <p className="selectable mt-2 text-xs text-danger">
                {[step.error_code, step.error_message].filter(Boolean).join(' — ')}
              </p>
            )}
            <div className="mt-2 space-y-2">
              <RuntimePayloadPanel title={t('taskCenter.input')} value={step.input} />
              <RuntimePayloadPanel title={t('taskCenter.output')} value={step.output} />
            </div>
          </Card>
        ))}
      </div>
    </DetailSection>
  );
}

export function RuntimeToolCallsSection({ calls }: { calls: readonly RuntimeToolCall[] }) {
  const t = useT();
  if (calls.length === 0) return null;
  return (
    <DetailSection title={t('taskCenter.toolCalls')} className="mt-6">
      <div className="space-y-2">
        {calls.map((call) => (
          <Card key={call.id} className="p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Wrench size={14} className="text-fg-faint" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-fg" title={call.tool_name}>
                {call.tool_name}
              </span>
              <RuntimeRiskTag risk={call.risk_level} />
              {technicalStatus(call.status)}
            </div>
            {call.canonical_input_hash && (
              <p className="selectable mt-2 break-all font-mono text-[10px] text-fg-faint">
                {t('taskCenter.inputHash')}: {call.canonical_input_hash}
              </p>
            )}
            {(call.error_code || call.error_message) && (
              <p className="selectable mt-2 text-xs text-danger">
                {[call.error_code, call.error_message].filter(Boolean).join(' — ')}
              </p>
            )}
            <div className="mt-2 space-y-2">
              <RuntimePayloadPanel title={t('taskCenter.fullToolInput')} value={call.input} />
              <RuntimePayloadPanel title={t('taskCenter.fullToolOutput')} value={call.output} />
            </div>
          </Card>
        ))}
      </div>
    </DetailSection>
  );
}

export function RuntimeArtifactsSection({ artifacts }: { artifacts: readonly RuntimeArtifact[] }) {
  const t = useT();
  if (artifacts.length === 0) return null;
  return (
    <DetailSection title={t('taskCenter.artifacts')} className="mt-6">
      <div className="grid gap-2 sm:grid-cols-2">
        {artifacts.map((artifact) => (
          <Card key={artifact.id} className="p-3">
            <div className="flex items-start gap-2">
              <FileText size={15} className="mt-0.5 flex-shrink-0 text-fg-faint" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg" title={artifact.name}>
                    {artifact.name}
                  </span>
                  {technicalStatus(artifact.status)}
                </div>
                <div className="mt-1 space-y-0.5 text-[10px] text-fg-faint">
                  <p>{[artifact.kind, artifact.content_type, artifact.direction].filter(Boolean).join(' · ')}</p>
                  {artifact.size_bytes !== null && <p>{formatFileSize(artifact.size_bytes)}</p>}
                  {artifact.path && <p className="selectable break-all">{artifact.path}</p>}
                  {artifact.storage_key && <p className="selectable break-all">{artifact.storage_key}</p>}
                  {artifact.sha256 && <p className="selectable break-all font-mono">sha256:{artifact.sha256}</p>}
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </DetailSection>
  );
}

export function RuntimeEventsSection({ events }: { events: readonly RuntimeEvent[] }) {
  const t = useT();
  if (events.length === 0) return null;
  return (
    <DetailSection title={t('taskCenter.timeline')} className="mt-6">
      <ol className="relative ml-2 border-l border-edge pl-5">
        {events.map((event) => (
          <li key={event.id} className="relative pb-4 last:pb-0">
            <span className="absolute -left-[1.56rem] top-1.5 h-2 w-2 rounded-full border border-primary-edge bg-primary-500" />
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs font-semibold text-fg">{event.type}</span>
              <span className="text-[10px] text-fg-faint">#{event.seq}</span>
              <span className="text-[10px] text-fg-faint">{formatDate(event.created_at)}</span>
              {event.type.endsWith('status_changed') && <CheckCircle2 size={12} className="text-success" />}
            </div>
            <div className="mt-1">
              <RuntimePayloadPanel title={t('taskCenter.eventPayload')} value={event.payload} />
            </div>
          </li>
        ))}
      </ol>
    </DetailSection>
  );
}
