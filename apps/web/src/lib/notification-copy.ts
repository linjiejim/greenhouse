/**
 * Inbox copy for Runtime notifications, in the reader's language.
 *
 * The server stores one English title/body per notification (the in-app fact
 * is written once, before anyone reads it), and rows written before v1.5 still
 * say "Open Execution Center…". For the generic Runtime kinds the title and the
 * "review it in the Activity log" line are rebuilt here from the payload; an
 * error message the run reported is the body as stored. Any other notification
 * (automation results, budgets, system) shows as stored.
 */

import type { PlatformNotification } from '@greenhouse/types/notification';
import type { AnyTranslationKey, TranslationKey } from './i18n';

type Translate = (key: AnyTranslationKey, params?: Record<string, string | number>) => string;

const RUNTIME_KINDS = new Set<PlatformNotification['kind']>([
  'runtime_attention',
  'runtime_completed',
  'runtime_failed',
  'budget_attention',
]);

/** The server's generic lines, current and pre-1.5. */
const GENERIC_BODY = /^Open (Execution Center|it in the Activity log) to (review|see)\b/;

const INTERRUPT_TITLES: Record<string, TranslationKey> = {
  mutation_approval: 'inbox.runtime.needsApproval',
  workflow_gate: 'inbox.runtime.needsApproval',
  ask_user: 'inbox.runtime.needsInput',
  credential_required: 'inbox.runtime.needsCredentials',
  budget_exceeded: 'inbox.runtime.budgetLimit',
  outcome_unknown: 'inbox.runtime.needsOutcomeReview',
};

function field(payload: PlatformNotification['payload'], key: string): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

export function notificationCopy(
  t: Translate,
  item: Pick<PlatformNotification, 'kind' | 'title' | 'body' | 'payload'>,
): { title: string; body: string } {
  const runtimeKind = field(item.payload, 'runtime_kind');
  if (!RUNTIME_KINDS.has(item.kind) || !runtimeKind) return { title: item.title, body: item.body };

  const label =
    runtimeKind === 'automation'
      ? t('inbox.runtime.automation')
      : runtimeKind === 'agent_write'
        ? t('inbox.runtime.agentWrite')
        : t('inbox.runtime.run');
  const interrupt = field(item.payload, 'interrupt_kind');
  const titleKey: TranslationKey =
    item.kind === 'runtime_completed'
      ? 'inbox.runtime.completed'
      : item.kind === 'runtime_failed'
        ? 'inbox.runtime.needsReview'
        : ((interrupt ? INTERRUPT_TITLES[interrupt] : undefined) ?? 'inbox.runtime.needsAttention');
  const generic = GENERIC_BODY.test(item.body);
  return {
    title: t(titleKey, { label }),
    body: generic
      ? t(item.kind === 'runtime_completed' ? 'inbox.runtime.seeResult' : 'inbox.runtime.review')
      : item.body,
  };
}
