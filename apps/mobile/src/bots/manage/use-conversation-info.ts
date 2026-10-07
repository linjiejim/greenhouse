/**
 * The behaviour behind a conversation's info sheet (app/bots/info.tsx), the
 * group-rules sheet and the invite sheet (spec docs/specs/20261008-mobile-bots.md
 * §2.5.7): the conversation's detail (`GET /api/bots/conversations/:id?limit=1`
 * — the detail rides on a one-message page) and every change made there, each
 * applied at once:
 *
 *  - rename / rules / lead / "let Bots ask each other" → `PATCH`;
 *  - remove (confirmed first) → `DELETE …/members/:botId`;
 *  - invite → `POST …/members` (`already_member` counts as done).
 *
 * Writes are optimistic; the server's answer (the fresh detail) replaces the
 * guess, a refusal restores what was there and says so (`alertError`). Every
 * write also makes the server push `bots:conversation`, which the open thread
 * reloads on; this sheet listens for the same push (a change made on another
 * device, a Bot joining by itself) and re-reads. The pure rules are in
 * ./group-model.ts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addConversationMember,
  getConversation,
  removeConversationMember,
  updateConversation,
  type BotsWrite,
} from '../../api/bots';
import { useT } from '../../lib/i18n';
import { realtime } from '../../realtime';
import type { BotConversationDetail } from '../../shared/bots';
import { alertError, confirmAction } from '../../ui/dialogs';
import { toast } from '../../ui/toast';
import { useBots } from '../store';
import { withLead, withoutMember } from './group-model';

export type InfoLoad = 'loading' | 'ready' | 'not_found' | 'forbidden' | 'error';

export function useConversationInfo(c: string) {
  const t = useT();
  const [detail, setDetail] = useState<BotConversationDetail | null>(null);
  const [load, setLoad] = useState<InfoLoad>('loading');
  // The latest detail, for rollbacks that must not capture a stale render.
  const current = useRef<BotConversationDetail | null>(null);
  current.current = detail;
  // Answers to reads started before the latest write are dropped (they predate it).
  const readSeq = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++readSeq.current;
    const result = await getConversation(c, { limit: 1 });
    if (seq !== readSeq.current) return;
    if (result.ok) {
      setDetail(result.value.conversation);
      setLoad('ready');
      return;
    }
    if (result.status === 403) useBots.getState().noteForbidden();
    // A failed refresh keeps what is on screen.
    if (current.current) return;
    setLoad(result.status === 404 ? 'not_found' : result.status === 403 ? 'forbidden' : 'error');
  }, [c]);

  useEffect(() => {
    setDetail(null);
    setLoad('loading');
    void reload();
    return realtime.on((event) => {
      if (event.type === 'resync' || (event.type === 'bots:conversation' && event.sessionId === c)) void reload();
    });
  }, [c, reload]);

  /** One write: the guess now, then the server's detail — or the old one back and an alert. */
  const write = useCallback(
    async (
      guess: (d: BotConversationDetail) => BotConversationDetail,
      send: () => Promise<BotsWrite<BotConversationDetail>>,
      failure: string,
    ): Promise<BotsWrite<BotConversationDetail> | null> => {
      const before = current.current;
      if (!before) return null;
      readSeq.current += 1;
      setDetail(guess(before));
      const result = await send();
      if (result.ok) {
        setDetail(result.value);
        // The drawer shows the title and the roster too.
        void useBots.getState().loadConversations();
      } else {
        setDetail(before);
        alertError(failure, result.message || undefined);
      }
      return result;
    },
    [],
  );

  const rename = useCallback(
    async (title: string) => {
      const next = title.trim() || null;
      if (next === (current.current?.title ?? null)) return;
      await write(
        (d) => ({ ...d, title: next }),
        () => updateConversation(c, { title: next }),
        t('bots.manage.saveFailed'),
      );
    },
    [c, t, write],
  );

  const setRules = useCallback(
    async (description: string): Promise<boolean> => {
      const result = await write(
        (d) => ({ ...d, description: description.trim() }),
        () => updateConversation(c, { description }),
        t('bots.manage.saveFailed'),
      );
      return !!result?.ok;
    },
    [c, t, write],
  );

  const setLead = useCallback(
    async (botId: string) => {
      if (botId === current.current?.lead_bot_id) return;
      await write(
        (d) => withLead(d, botId),
        () => updateConversation(c, { lead_bot_id: botId }),
        t('bots.manage.saveFailed'),
      );
    },
    [c, t, write],
  );

  const setAllowBotChat = useCallback(
    async (on: boolean) => {
      await write(
        (d) => ({ ...d, allow_bot_chat: on }),
        () => updateConversation(c, { allow_bot_chat: on }),
        t('bots.manage.saveFailed'),
      );
    },
    [c, t, write],
  );

  /** Asks first ("Remove {name} from this conversation?"), then removes. */
  const remove = useCallback(
    async (botId: string) => {
      const name = useBots.getState().byId[botId]?.name ?? '';
      const ok = await confirmAction({
        title: t('bots.manage.removeConfirm', { name }),
        confirmLabel: t('bots.manage.remove'),
        destructive: true,
      });
      if (!ok) return;
      const result = await write(
        (d) => withoutMember(d, botId),
        () => removeConversationMember(c, botId),
        t('bots.manage.removeFailed', { name }),
      );
      if (result?.ok) toast(t('bots.manage.removed', { name }), 'personMinus');
    },
    [c, t, write],
  );

  /** Adds a Bot (a guest in a DM); true when it is in the conversation now. */
  const invite = useCallback(
    async (botId: string): Promise<boolean> => {
      const name = useBots.getState().byId[botId]?.name ?? '';
      const result = await addConversationMember(c, botId);
      if (!result.ok && result.code !== 'already_member') {
        alertError(
          result.code === 'member_limit' ? t('bots.manage.max6') : t('bots.manage.inviteFailed', { name }),
          result.code === 'member_limit' ? undefined : result.message || undefined,
        );
        return false;
      }
      if (result.ok) setDetail(result.value);
      void useBots.getState().loadConversations();
      toast(t('bots.manage.invited', { name }), 'userPlus');
      return true;
    },
    [c, t],
  );

  return { load, detail, reload, rename, setRules, setLead, setAllowBotChat, remove, invite };
}
