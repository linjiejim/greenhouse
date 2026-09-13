/**
 * Mission — shared presentation helpers (status chip, status dot color,
 * duration/usage text). Used by the mission dispatch card and the new-run
 * dialog; the standalone `pages/cloud-agent/*` and the sidebar run rail that
 * once consumed it are gone (execution-center convergence, 2026-08-13).
 *
 * Status values are DB enum values and render untranslated (repo i18n rule);
 * only the chrome around them is localized.
 */

import React, { useEffect } from 'react';
import { Spinner, Tag } from '../ui';
import { formatTokens } from '../../lib/utils';
import type { CloudAgentRun, CloudAgentRunStatus } from '../../lib/api/cloud-agent';
import { isCloudAgentRunActive } from '../../lib/api/cloud-agent';
import type { ChatModel } from '../../lib/api/profiles';
import { useProfileStore } from '../../stores';

const STATUS_TONE: Record<CloudAgentRunStatus, 'neutral' | 'primary' | 'success' | 'danger' | 'info'> = {
  queued: 'neutral',
  starting: 'info',
  running: 'info',
  completed: 'success',
  failed: 'danger',
  canceled: 'neutral',
};

/** StatusDot color per run status — the rail's compact sibling of RunStatusTag. */
export const RUN_STATUS_DOT: Record<
  CloudAgentRunStatus,
  'success' | 'warning' | 'danger' | 'info' | 'primary' | 'muted'
> = {
  queued: 'muted',
  starting: 'info',
  running: 'primary',
  completed: 'success',
  failed: 'danger',
  canceled: 'muted',
};

/** Status chip: queued neutral · starting/running animated accent · completed success · failed danger · canceled muted. */
export function RunStatusTag({ status, size = 'xs' }: { status: CloudAgentRunStatus; size?: 'xs' | 'sm' }) {
  const live = status === 'starting' || status === 'running';
  return (
    <Tag
      tone={STATUS_TONE[status]}
      size={size}
      icon={live ? <Spinner className="h-2.5 w-2.5 flex-shrink-0" /> : undefined}
      className={status === 'canceled' ? 'opacity-60' : ''}
    >
      {status}
    </Tag>
  );
}

/** "1h 04m" / "4m 12s" / "38s"; em dash before the run has started. */
export function formatRunDuration(run: Pick<CloudAgentRun, 'status' | 'started_at' | 'ended_at'>): string {
  if (!run.started_at) return '—';
  const end = run.ended_at ? new Date(run.ended_at).getTime() : Date.now();
  const ms = end - new Date(run.started_at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/** Compact usage cell: "12.3k tok · 45 req". */
export function formatRunUsage(run: Pick<CloudAgentRun, 'input_tokens' | 'output_tokens' | 'used_requests'>): string {
  return `${formatTokens(run.input_tokens + run.output_tokens)} tok · ${run.used_requests} req`;
}

/** Prefer the catalog's human label; retain the registry id as a safe fallback. */
export function missionModelName(modelId: string, models: ChatModel[]): string {
  return models.find((model) => model.id === modelId)?.name || modelId;
}

/**
 * Models a mission can run on — the chat model catalog (missions go through
 * the same relay; the server route accepts any registry id and the deployment
 * default only applies when none is sent). Hydrates the shared profile store
 * on first use; returns [] until it arrives, and consumers degrade to the
 * deployment default then.
 */
export function useMissionModels(): ChatModel[] {
  const models = useProfileStore((s) => s.models);
  const fetchProfiles = useProfileStore((s) => s.fetchProfiles);
  useEffect(() => {
    void fetchProfiles();
  }, [fetchProfiles]);
  return models;
}

export { isCloudAgentRunActive };
