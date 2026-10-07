/**
 * The behaviour behind `/bots/rules` (app/bots/rules.tsx; spec
 * docs/specs/20261008-mobile-bots.md §2.5.7): a group's rules — read by every
 * Bot in it before each reply — as one text, at most 2000 characters, saved
 * with `PATCH /api/bots/conversations/:id { description }`. The route loads
 * the conversation first and mounts the form with the rules frozen as the
 * initial text (the native field owns what is typed).
 */

import { useCallback, useState } from 'react';
import { updateConversation } from '../../api/bots';
import { useT } from '../../lib/i18n';
import { alertError } from '../../ui/dialogs';
import { toast } from '../../ui/toast';
import { useBots } from '../store';
import { GROUP_RULES_MAX } from './group-model';

export function useRulesForm(c: string, initialProp: string) {
  const t = useT();
  const [initial] = useState(initialProp);
  const [text, setText] = useState(initialProp);
  const [saving, setSaving] = useState(false);

  const dirty = text !== initial;
  const tooLong = text.length > GROUP_RULES_MAX;
  const canSave = dirty && !tooLong && !saving;

  /** `latest`: the native field's text when ✓ was pressed (its change event is async). */
  const save = useCallback(
    async (latest?: string): Promise<boolean> => {
      const value = latest ?? text;
      if (saving || value === initial || value.length > GROUP_RULES_MAX) return false;
      setSaving(true);
      const result = await updateConversation(c, { description: value });
      setSaving(false);
      if (!result.ok) {
        alertError(t('bots.manage.saveFailed'), result.message || undefined);
        return false;
      }
      void useBots.getState().loadConversations();
      toast(t('bots.manage.saved'), 'check');
      return true;
    },
    [c, initial, saving, t, text],
  );

  return { initial, text, setText, dirty, tooLong, canSave, saving, save, max: GROUP_RULES_MAX };
}
