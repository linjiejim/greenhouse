/**
 * The profile drawer's Publish and Ratings tabs (spec 20261011-agent-first-class P4) — owner-only,
 * never for the main Agent (Sprouty is never published, D33):
 * - Publish: `GET /api/bots/:id/publication` read-only — private or public, the published vs the
 *   current version ("Publish vN" makes the latest live, D39), audience, grants, budget, how many
 *   people talk to it, an administrator's pause. Editing opens `PublishSettingsDialog`.
 * - Ratings: `GET /api/bots/:id/feedback` — each 👍 / 👎 with the line its user wrote, who, when and
 *   on which version; never the conversation (D38).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  PUBLIC_AGENT_DEFAULT_MONTHLY_TOKENS,
  type BotFeedbackView,
  type BotPublicationView,
  type BotView,
} from '@greenhouse/types/bots';
import { Button, ConfirmDialog, Spinner, Tag, toast } from '../ui';
import { Globe, Lock, Pencil, ThumbsDown, ThumbsUp, Upload } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { formatDate, formatTokens } from '../../lib/utils';
import { fetchBotFeedback, fetchBotPublication, isBotsApiError, updateBotPublication } from '../../lib/api/bots';
import { useBotsStore } from './bots-store';
import { PanelSection } from './bots-side-panel';
import { PublishSettingsDialog } from './publish-settings-dialog';

type Load<T> = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; data: T };

export function BotPublishPanel({ bot }: { bot: BotView }) {
  const t = useT();
  const upsertBot = useBotsStore((state) => state.upsertBot);
  const [load, setLoad] = useState<Load<BotPublicationView>>({ state: 'loading' });
  const [dialog, setDialog] = useState<null | 'edit' | 'publish'>(null);
  const [confirmPrivate, setConfirmPrivate] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoad({ state: 'loading' });
    fetchBotPublication(bot.id).then(
      (data) => !cancelled && setLoad({ state: 'ready', data }),
      () => !cancelled && setLoad({ state: 'failed' }),
    );
    return () => {
      cancelled = true;
    };
  }, [bot.id]);

  /** A new publication: show it here and on every list that badges the Agent. */
  const applied = useCallback(
    (next: BotPublicationView) => {
      setLoad({ state: 'ready', data: next });
      upsertBot({ ...bot, visibility: next.visibility, published_version: next.published_version });
    },
    [bot, upsertBot],
  );

  const write = async (patch: { publish: true } | { visibility: 'private' }) => {
    setBusy(true);
    try {
      const next = await updateBotPublication(bot.id, patch);
      applied(next);
      toast(
        'publish' in patch
          ? t('bots.publish.published', { version: next.published_version ?? bot.current_version })
          : t('bots.publish.madePrivate', { name: bot.name }),
        'success',
      );
    } catch (err) {
      toast(
        isBotsApiError(err, 'bot_protected')
          ? t('bots.publish.protected')
          : t('bots.publish.saveFailed', { reason: err instanceof Error ? err.message : String(err) }),
        'error',
      );
    } finally {
      setBusy(false);
    }
  };

  if (load.state === 'loading') {
    return (
      <PanelSection title={t('bots.publish.title')}>
        <Spinner className="h-4 w-4 text-fg-faint" />
      </PanelSection>
    );
  }
  if (load.state === 'failed') {
    return (
      <PanelSection title={t('bots.publish.title')}>
        <p className="text-xs text-danger">{t('bots.publish.loadFailed')}</p>
      </PanelSection>
    );
  }

  const view = load.data;
  const isPublic = view.visibility === 'public';
  const behind = view.published_version !== null && view.published_version !== view.current_version;
  const audience = view.audience.everyone
    ? t('bots.publish.audienceEveryone')
    : view.audience.user_ids.length + view.audience.group_ids.length === 0
      ? t('bots.publish.audienceNone')
      : t('bots.publish.audienceSome', {
          people: view.audience.user_ids.length,
          groups: view.audience.group_ids.length,
        });
  const monthly = view.budget.monthly_tokens;

  return (
    <div data-testid="bots-profile-publish">
      <PanelSection title={t('bots.publish.title')}>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {isPublic ? (
              <Tag tone="success" icon={<Globe size={10} aria-hidden="true" />}>
                {t('bots.shared.publicTag')}
              </Tag>
            ) : (
              <Tag icon={<Lock size={10} aria-hidden="true" />}>{t('bots.publish.statusPrivate')}</Tag>
            )}
            {view.paused && <Tag tone="warning">{t('bots.publish.paused')}</Tag>}
          </div>
          {isPublic && <p className="text-xs text-fg-secondary">{t('bots.publish.statusPublic')}</p>}
          <p className="text-xs text-fg-muted" data-testid="bots-publish-versions">
            {view.published_version === null
              ? t('bots.publish.notPublished', { current: view.current_version })
              : t('bots.publish.versionLine', { published: view.published_version, current: view.current_version })}
          </p>
          {isPublic && (
            <p className={`text-[11px] ${behind ? 'text-warning' : 'text-fg-faint'}`}>
              {behind
                ? t('bots.publish.behind', { current: view.current_version, published: view.published_version ?? 0 })
                : t('bots.publish.upToDate')}
            </p>
          )}
          {view.users > 0 && (
            <p className="text-[11px] text-fg-faint">{t('bots.publish.users', { count: view.users })}</p>
          )}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {isPublic ? (
              <>
                <Button
                  size="sm"
                  disabled={busy || !behind}
                  onClick={() => void write({ publish: true })}
                  data-testid="bots-publish-current"
                >
                  <Upload size={13} className="mr-1" />
                  {busy
                    ? t('bots.publish.publishing')
                    : t('bots.publish.publishCurrent', { version: view.current_version })}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setDialog('edit')} data-testid="bots-publish-edit">
                  <Pencil size={13} className="mr-1" />
                  {t('bots.publish.edit')}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmPrivate(true)}>
                  <Lock size={13} className="mr-1" />
                  {t('bots.publish.makePrivate')}
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => setDialog('publish')} data-testid="bots-publish-start">
                <Globe size={13} className="mr-1" />
                {t('bots.publish.makePublic')}
              </Button>
            )}
          </div>
        </div>
      </PanelSection>
      <PanelSection title={t('bots.publish.audience')}>
        <p className="text-xs text-fg-secondary" data-testid="bots-publish-audience">
          {audience}
        </p>
      </PanelSection>
      <PanelSection title={t('bots.publish.grants')}>
        <ul className="space-y-1 text-xs text-fg-secondary">
          <li>
            {view.grants.kb_folder_ids.length > 0
              ? t('bots.publish.grantsFolders', { count: view.grants.kb_folder_ids.length })
              : t('bots.publish.grantsNoFolders')}
          </li>
          <li>{view.grants.computer ? t('bots.publish.grantsComputer') : t('bots.publish.grantsNoComputer')}</li>
        </ul>
      </PanelSection>
      <PanelSection title={t('bots.publish.budget')}>
        <ul className="space-y-1 text-xs text-fg-secondary">
          <li>
            {monthly === null
              ? t('bots.publish.budgetMonthlyDefault', { tokens: formatTokens(PUBLIC_AGENT_DEFAULT_MONTHLY_TOKENS) })
              : t('bots.publish.budgetMonthly', { tokens: formatTokens(monthly) })}
          </li>
          <li>
            {view.budget.daily_tokens_per_user === null
              ? t('bots.publish.budgetNoDaily')
              : t('bots.publish.budgetDaily', { tokens: formatTokens(view.budget.daily_tokens_per_user) })}
          </li>
        </ul>
      </PanelSection>

      {dialog && (
        <PublishSettingsDialog
          bot={bot}
          view={view}
          startPublic={dialog === 'publish'}
          onClose={() => setDialog(null)}
          onSaved={(next) => {
            applied(next);
            setDialog(null);
          }}
        />
      )}
      <ConfirmDialog
        open={confirmPrivate}
        onClose={() => setConfirmPrivate(false)}
        onConfirm={() => {
          setConfirmPrivate(false);
          void write({ visibility: 'private' });
        }}
        title={t('bots.publish.makePrivateConfirm', { name: bot.name })}
        description={t('bots.publish.makePrivateDescription')}
        confirmLabel={t('bots.publish.makePrivate')}
      />
    </div>
  );
}

export function BotFeedbackPanel({ botId, name }: { botId: string; name: string }) {
  const t = useT();
  const [load, setLoad] = useState<Load<BotFeedbackView[]>>({ state: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setLoad({ state: 'loading' });
    fetchBotFeedback(botId).then(
      (data) => !cancelled && setLoad({ state: 'ready', data }),
      () => !cancelled && setLoad({ state: 'failed' }),
    );
    return () => {
      cancelled = true;
    };
  }, [botId]);

  return (
    <PanelSection title={t('bots.feedback.title')} hint={t('bots.feedback.hint', { name })}>
      {load.state === 'loading' ? (
        <Spinner className="h-4 w-4 text-fg-faint" />
      ) : load.state === 'failed' ? (
        <p className="text-xs text-danger">{t('bots.feedback.failed')}</p>
      ) : load.data.length === 0 ? (
        <p className="text-xs text-fg-faint">{t('bots.feedback.empty')}</p>
      ) : (
        <div className="space-y-2">
          <p className="text-[11px] text-fg-muted" data-testid="bots-feedback-summary">
            {t('bots.feedback.summary', {
              up: load.data.filter((row) => row.rating === 1).length,
              down: load.data.filter((row) => row.rating === -1).length,
            })}
          </p>
          <ul className="divide-y divide-edge" data-testid="bots-feedback-list">
            {load.data.map((row) => (
              <li key={row.id} className="flex items-start gap-2 py-2" data-rating={row.rating}>
                <span
                  className={`mt-0.5 flex-shrink-0 ${row.rating === 1 ? 'text-success' : 'text-danger'}`}
                  title={row.rating === 1 ? t('bots.feedback.helpful') : t('bots.feedback.notHelpful')}
                >
                  {row.rating === 1 ? (
                    <ThumbsUp size={13} aria-label={t('bots.feedback.helpful')} />
                  ) : (
                    <ThumbsDown size={13} aria-label={t('bots.feedback.notHelpful')} />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  {row.comment && <p className="whitespace-pre-wrap text-xs text-fg">{row.comment}</p>}
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-fg-faint">
                    <span className="truncate" title={row.user.nickname}>
                      {row.user.nickname}
                    </span>
                    <span>{formatDate(row.created_at)}</span>
                    {row.version !== null && <span>{t('bots.feedback.version', { version: row.version })}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </PanelSection>
  );
}
