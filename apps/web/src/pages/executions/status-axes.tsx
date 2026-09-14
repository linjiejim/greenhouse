import type {
  RuntimeActionRisk,
  RuntimeAttention,
  RuntimeLifecycle,
  RuntimeRunKind,
  RuntimeTransport,
  RuntimeUserProjection,
} from '@greenhouse/types/runtime';
import { Tag, type TagTone } from '../../components/ui';
import { CircleDot, MessageSquareWarning, Wifi } from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';

const LIFECYCLE_KEYS: Record<RuntimeLifecycle, TranslationKey> = {
  queued: 'taskCenter.lifecycle.queued',
  preparing: 'taskCenter.lifecycle.preparing',
  running: 'taskCenter.lifecycle.running',
  paused: 'taskCenter.lifecycle.paused',
  completed: 'taskCenter.lifecycle.completed',
  failed: 'taskCenter.lifecycle.failed',
  canceled: 'taskCenter.lifecycle.canceled',
};

const LIFECYCLE_TONES: Record<RuntimeLifecycle, TagTone> = {
  queued: 'neutral',
  preparing: 'info',
  running: 'primary',
  paused: 'warning',
  completed: 'success',
  failed: 'danger',
  canceled: 'neutral',
};

const ATTENTION_KEYS: Record<RuntimeAttention, TranslationKey> = {
  none: 'taskCenter.attention.none',
  approval: 'taskCenter.attention.approval',
  input: 'taskCenter.attention.input',
  review: 'taskCenter.attention.review',
};

const ATTENTION_TONES: Record<RuntimeAttention, TagTone> = {
  none: 'neutral',
  approval: 'warning',
  input: 'info',
  review: 'primary',
};

const TRANSPORT_KEYS: Record<RuntimeTransport, TranslationKey> = {
  live: 'taskCenter.transport.live',
  reconnecting: 'taskCenter.transport.reconnecting',
  stale: 'taskCenter.transport.stale',
  offline: 'taskCenter.transport.offline',
};

const TRANSPORT_TONES: Record<RuntimeTransport, TagTone> = {
  live: 'success',
  reconnecting: 'warning',
  stale: 'danger',
  offline: 'neutral',
};

const KIND_KEYS: Partial<Record<RuntimeRunKind, TranslationKey>> = {
  mission: 'taskCenter.kind.mission',
  workflow: 'taskCenter.kind.workflow',
  automation: 'taskCenter.kind.automation',
  subagent: 'taskCenter.kind.subagent',
  eval: 'taskCenter.kind.eval',
  chat: 'taskCenter.kind.chat',
};

export function RuntimeKindTag({ kind }: { kind: RuntimeRunKind }) {
  const t = useT();
  const key = KIND_KEYS[kind];
  return (
    <Tag tone={kind === 'mission' ? 'primary' : kind === 'workflow' ? 'info' : 'neutral'}>{key ? t(key) : kind}</Tag>
  );
}

export function RuntimeRiskTag({ risk }: { risk: RuntimeActionRisk | null }) {
  if (!risk) return null;
  const tone: TagTone = risk === 'r0' ? 'neutral' : risk === 'r1' ? 'warning' : 'danger';
  return <Tag tone={tone}>{risk.toUpperCase()}</Tag>;
}

export function RuntimeStatusAxes({
  projection,
  compact = false,
}: {
  projection: RuntimeUserProjection;
  compact?: boolean;
}) {
  const t = useT();
  const size = compact ? 'xs' : 'sm';
  return (
    // Decision pressure comes first, then connection health, then execution.
    // This keeps a pending approval visible even while the run is still live.
    <div className="flex min-w-0 flex-wrap items-center gap-1.5" aria-label={t('taskCenter.axesLabel')}>
      <Tag
        size={size}
        tone={ATTENTION_TONES[projection.attention]}
        icon={<MessageSquareWarning size={11} aria-hidden="true" />}
        title={`${t('taskCenter.axis.attention')}: ${t(ATTENTION_KEYS[projection.attention])}`}
      >
        {t(ATTENTION_KEYS[projection.attention])}
      </Tag>
      <Tag
        size={size}
        tone={TRANSPORT_TONES[projection.transport]}
        icon={<Wifi size={11} aria-hidden="true" />}
        title={`${t('taskCenter.axis.transport')}: ${t(TRANSPORT_KEYS[projection.transport])}`}
      >
        {t(TRANSPORT_KEYS[projection.transport])}
      </Tag>
      <Tag
        size={size}
        tone={LIFECYCLE_TONES[projection.lifecycle]}
        icon={<CircleDot size={11} aria-hidden="true" />}
        title={`${t('taskCenter.axis.lifecycle')}: ${t(LIFECYCLE_KEYS[projection.lifecycle])}`}
      >
        {t(LIFECYCLE_KEYS[projection.lifecycle])}
      </Tag>
    </div>
  );
}
