/**
 * "Ask a Bot to build one": choose the Base (or let the Bot start a new one),
 * say what the app is for, and Chat opens a new conversation with that
 * request in the composer — not sent: the member reads it, adds what is
 * missing and sends. The Bot drafts the app as a plan the member confirms
 * there; nothing is built from this dialog.
 */

import { useState } from 'react';
import { FormField } from '../../../components/form';
import { Button, Dialog, Select, Spinner, Textarea } from '../../../components/ui';
import { publishAttachment } from '../../../lib/desktop/attach';
import { useT } from '../../../lib/i18n';
import { useBuilderBases } from './use-builder-bases';

const NEW_BASE = 'new';

export function AskBotDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const bases = useBuilderBases(open);
  const [choice, setChoice] = useState('');
  const [goal, setGoal] = useState('');
  const available = bases.kind === 'ready' ? bases.bases : [];
  const base = available.find((entry) => String(entry.id) === choice);

  const openChat = () => {
    const draft = base
      ? t('apps.center.askBot.prompt', { base: base.name, id: base.id, goal: goal.trim() })
      : t('apps.center.askBot.promptNewBase', { goal: goal.trim() });
    publishAttachment({ target: 'chat', draft: draft.trim(), newConversation: true });
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('apps.center.askBot.title')} size="md">
      <div className="space-y-4" data-testid="ask-bot-dialog">
        <p className="text-xs text-fg-muted">{t('apps.center.askBot.hint')}</p>
        <FormField label={t('apps.center.askBot.base')}>
          {bases.kind === 'loading' ? (
            <div className="flex h-9 items-center">
              <Spinner className="h-4 w-4 text-fg-faint" />
            </div>
          ) : (
            <Select
              value={choice || NEW_BASE}
              onChange={(event) => setChoice(event.target.value)}
              data-testid="ask-bot-base"
            >
              <option value={NEW_BASE}>{t('apps.center.askBot.newBase')}</option>
              {available.map((entry) => (
                <option key={entry.id} value={String(entry.id)}>
                  {entry.name}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label={t('apps.center.askBot.goal')}>
          <Textarea
            rows={3}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder={t('apps.center.askBot.goalPlaceholder')}
          />
        </FormField>
        <div className="flex justify-end gap-2 border-t border-edge pt-4">
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={openChat} data-testid="ask-bot-open">
            {t('apps.center.askBot.open')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
