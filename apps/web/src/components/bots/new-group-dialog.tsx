/**
 * "New group": pick 2–6 Bots (the first picked leads) and optionally name it.
 * Groups are created explicitly — a DM never turns into a group, so "my chat
 * with Sage" stays exactly that.
 */

import { useEffect, useState } from 'react';
import type { BotConversationDetail } from '@greenhouse/types/bots';
import { Button, Dialog, Input, toast } from '../ui';
import { FormActions, FormField } from '../form';
import { Check } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import * as botsApi from '../../lib/api/bots';
import { useBotsStore } from './bots-store';
import { BotAvatar } from './bot-avatar';

const MIN_MEMBERS = 2;
const MAX_MEMBERS = 6;

export function NewGroupDialog({
  open,
  onClose,
  onCreated,
  onNewBot,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (conversation: BotConversationDetail) => void;
  onNewBot: () => void;
}) {
  const t = useT();
  const bots = useBotsStore((state) => state.bots);
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected([]);
    setTitle('');
  }, [open]);

  const toggle = (botId: string) =>
    setSelected((current) =>
      current.includes(botId)
        ? current.filter((id) => id !== botId)
        : current.length >= MAX_MEMBERS
          ? current
          : [...current, botId],
    );

  const create = async () => {
    setSaving(true);
    try {
      const { conversation } = await botsApi.createConversation({
        bot_ids: selected,
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      onCreated(conversation);
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : t('bots.group.failed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const tooFew = selected.length < MIN_MEMBERS;

  return (
    <Dialog open={open} onClose={onClose} title={t('bots.group.title')} size="md">
      {bots.length < MIN_MEMBERS ? (
        <div className="space-y-3">
          <p className="text-sm text-fg-muted">{t('bots.group.noBots')}</p>
          <FormActions>
            <Button onClick={onNewBot}>{t('bots.sidebar.newBot')}</Button>
          </FormActions>
        </div>
      ) : (
        <div className="space-y-4" data-testid="bots-new-group">
          <p className="text-sm text-fg-muted">{t('bots.group.hint')}</p>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2" role="group" aria-label={t('bots.group.title')}>
            {bots.map((bot) => {
              const picked = selected.includes(bot.id);
              const disabled = !picked && selected.length >= MAX_MEMBERS;
              return (
                <button
                  key={bot.id}
                  type="button"
                  aria-pressed={picked}
                  disabled={disabled}
                  onClick={() => toggle(bot.id)}
                  className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors disabled:opacity-50 ${
                    picked ? 'border-primary-edge bg-primary-subtle' : 'border-edge hover:bg-surface-muted'
                  }`}
                >
                  <BotAvatar bot={bot} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-fg">{bot.name}</span>
                    {bot.role && <span className="block truncate text-[11px] text-fg-faint">{bot.role}</span>}
                  </span>
                  {picked && <Check size={14} className="flex-shrink-0 text-primary-fg" />}
                </button>
              );
            })}
          </div>
          <FormField label={t('bots.group.name')}>
            <Input
              value={title}
              maxLength={80}
              placeholder={t('bots.group.namePlaceholder')}
              onChange={(event) => setTitle(event.target.value)}
            />
          </FormField>
          <FormActions
            leading={
              <span className="text-xs text-fg-faint">
                {tooFew ? t('bots.group.pickMore') : t('bots.group.selected', { count: selected.length })}
              </span>
            }
          >
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button disabled={tooFew || saving} onClick={() => void create()}>
              {t('bots.group.create')}
            </Button>
          </FormActions>
        </div>
      )}
    </Dialog>
  );
}
