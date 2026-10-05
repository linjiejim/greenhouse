/**
 * "New Bot" confirmation card — a Bot proposed a teammate (`team.create`).
 *
 * Nothing is created until the member presses Create, and every field is
 * editable first: a Bot persisting a new identity on its own would let a
 * prompt-injected page plant a permanent helper. Once created, the new Bot
 * joins this conversation and the engine lets the proposer continue.
 */

import { useMemo, useState } from 'react';
import type { BotCreatePayload, BotRequestView } from '@greenhouse/types/bots';
import { ArtifactCard, ArtifactCardActions } from '../chat/artifact-card';
import { Button } from '../ui';
import { Sparkles } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { useAuthStore } from '../../stores';
import { useBotsStore } from './bots-store';
import { BotFields, useBotNameMessage, type BotDraft } from './bot-form';
import { validateBotName } from './bot-name';
import { useRequestDecision, type RequestCardCallbacks } from './request-decision';
import { ExpiredFooter, useSettledStatus } from './request-card-parts';
import type { BotLookup } from './transcript-rows';
import { BotAvatar } from './bot-avatar';

export function BotCreateCard({
  request,
  lookup,
  onSettled,
  onStale,
  onAskAgain,
}: RequestCardCallbacks & {
  request: BotRequestView;
  lookup: BotLookup;
  onAskAgain: (botId: string) => void;
}) {
  const t = useT();
  const payload = request.payload as BotCreatePayload;
  const proposer = lookup(request.bot_id)?.name ?? t('bots.deletedBot');
  const { busy, decide } = useRequestDecision(request, { onSettled, onStale });
  const { pending, expired, status } = useSettledStatus(request);
  const nickname = useAuthStore((state) => state.currentUser?.nickname ?? null);
  const bots = useBotsStore((state) => state.bots);
  const loadBots = useBotsStore((state) => state.loadBots);
  const nameMessage = useBotNameMessage();
  const [draft, setDraft] = useState<BotDraft>(() => ({
    name: payload.name ?? '',
    role: payload.role ?? '',
    instructions: payload.instructions ?? '',
    avatar: payload.avatar ?? {},
    model_id: null,
  }));
  const [touched, setTouched] = useState(false);
  const issue = useMemo(
    () => validateBotName(draft.name, { otherNames: bots.map((bot) => bot.name), nickname }),
    [bots, draft.name, nickname],
  );

  const create = async () => {
    setTouched(true);
    if (issue) return;
    const outcome = await decide({
      decision: 'approve',
      bot: {
        name: draft.name.trim(),
        role: draft.role.trim(),
        instructions: draft.instructions.trim(),
        avatar: draft.avatar,
      },
    });
    // The new Bot shows up in the strip and the conversation members.
    if (outcome.ok) void loadBots().catch(() => {});
  };

  return (
    <ArtifactCard
      icon={<Sparkles size={14} />}
      title={t('bots.requests.createTitle', { name: proposer })}
      meta={pending ? undefined : draft.name}
      status={status}
      tone={pending ? 'accent' : 'neutral'}
      collapsed={!pending && !expired}
      footer={
        pending ? (
          <ArtifactCardActions>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide({ decision: 'deny' })}>
              {t('bots.requests.dismiss')}
            </Button>
            <Button size="sm" disabled={busy || (touched && !!issue)} onClick={() => void create()}>
              {t('bots.requests.create')}
            </Button>
          </ArtifactCardActions>
        ) : (
          <ExpiredFooter request={request} onAskAgain={onAskAgain} />
        )
      }
    >
      {pending ? (
        <BotFields
          value={draft}
          onChange={(next) => {
            setDraft(next);
            setTouched(true);
          }}
          nameError={touched ? nameMessage(issue, draft.name) : undefined}
          compact
        />
      ) : (
        <div className="flex items-center gap-2">
          <BotAvatar avatar={draft.avatar} size="sm" />
          <span className="text-sm font-medium text-fg">{draft.name}</span>
          {draft.role && <span className="text-xs text-fg-muted">{draft.role}</span>}
        </div>
      )}
    </ArtifactCard>
  );
}
