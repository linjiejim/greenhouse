/**
 * A Bot's DM as its profile shows it (./profile-tabs.tsx — what it remembers
 * lately, the shared notes, the Bots that joined): the conversation's detail
 * (`GET /api/bots/conversations/:id?limit=1` — the detail rides on a
 * one-message page) and the one change made there: remove a guest (confirmed
 * first) → `DELETE …/members/:botId`.
 *
 * Nothing else is set here: Bots bring each other in whenever it helps (no
 * switch, and no manual invite since 2026-10), and group chats — with their
 * name, rules and lead — are retired.
 *
 * Writes are optimistic; the server's answer (the fresh detail) replaces the
 * guess, a refusal restores what was there and says so (`alertError`). Every
 * write also makes the server push `bots:conversation`, which the open thread
 * reloads on; this sheet listens for the same push (a change made on another
 * device, a Bot joining by itself) and re-reads. The pure rules are in
 * ./member-model.ts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getConversation, removeConversationMember, type BotsWrite } from '../../api/bots';
import { useT } from '../../lib/i18n';
import { realtime } from '../../realtime';
import type { BotConversationDetail } from '../../shared/bots';
import { alertError, confirmAction } from '../../ui/dialogs';
import { toast } from '../../ui/toast';
import { useBots } from '../store';
import { withoutMember } from './member-model';

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
    if (!c) return undefined;
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

  return { load, detail, reload, remove };
}
