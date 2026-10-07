/**
 * The behaviour behind `/bots/new-group` (app/bots/new-group.tsx; spec
 * docs/specs/20261008-mobile-bots.md §2.5.7): pick 2–6 of the member's active
 * Bots — the first pick leads (it answers and delegates when no one is
 * @-mentioned) — then `POST /api/bots/conversations { bot_ids }`. A group is
 * named later, from its info sheet. The pure rules are in ./group-model.ts.
 */

import { useCallback, useMemo, useState } from 'react';
import { createConversation } from '../../api/bots';
import { useT } from '../../lib/i18n';
import { alertError } from '../../ui/dialogs';
import { useBots } from '../store';
import { botsById, conversationTitle } from '../vendor/web-helpers';
import { groupCanCreate, groupCandidates, pickedLead, togglePick } from './group-model';
import { useBotDirectory } from './use-bot-directory';

export function useGroupForm() {
  const t = useT();
  const bots = useBots((s) => s.bots);
  const directory = useBotDirectory();
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const candidates = useMemo(() => groupCandidates(bots), [bots]);
  // A Bot archived while the sheet is open drops out of the picks too.
  const picked = useMemo(() => selected.filter((id) => bots.some((bot) => bot.id === id)), [selected, bots]);

  const toggle = useCallback((botId: string) => setSelected((current) => togglePick(current, botId)), []);

  const save = useCallback(async (): Promise<{ c: string; title: string } | null> => {
    if (saving || !groupCanCreate(picked)) return null;
    setSaving(true);
    const result = await createConversation({ bot_ids: picked });
    setSaving(false);
    if (!result.ok) {
      // `bot_not_found`: a pick was archived elsewhere — the refreshed list drops it.
      if (result.status === 404) void useBots.getState().loadBots();
      alertError(t('bots.manage.groupFailed'), result.message || undefined);
      return null;
    }
    void useBots.getState().loadConversations();
    const title = conversationTitle(result.value, botsById(useBots.getState().bots), {
      unknownBot: '',
      group: t('bots.manage.groupTitle'),
      archived: (name) => `${name} ${t('bots.common.archivedSuffix')}`,
    });
    return { c: result.value.session_id, title };
  }, [saving, picked, t]);

  return {
    /** Every active Bot, the main one first. */
    bots: candidates,
    botsLoaded: directory.loaded,
    /** The Bot list never arrived (offline, refused): the sheet offers a retry. */
    failed: directory.failed,
    retry: directory.retry,
    selected: picked,
    lead: pickedLead(picked),
    toggle,
    canSave: !saving && groupCanCreate(picked),
    saving,
    save,
  };
}
