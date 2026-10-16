import { errorText } from '../../lib/errors';
import { useOverlayDraft } from '../../lib/useOverlayDraft';
/**
 * A new room (CONV-04): a name, the people, and which of my Agents come along. Two people make
 * a direct message. Anyone in the room may add people later; an Agent comes only with its owner.
 */

import { useState, type FormEvent } from 'react';
import { Button, Field, FieldGroup, Input, MultiSelect, Overlay, OverlayActions } from '@greenhouse/ui/kit';
import { useMe } from '../../app/session';
import { useCreateConversation } from '../../data/conversations';
import { usePeople } from '../../data/people';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';

export function NewRoomDialog({ onClose, people: preset = [] }: { onClose: () => void; people?: string[] }) {
  const { t } = useI18n();
  const me = useMe();
  const { members, agents } = usePeople();
  const create = useCreateConversation();
  const [title, setTitle] = useState('');
  const [people, setPeople] = useState<string[]>(preset);
  const [bring, setBring] = useState<string[]>([]);
  const [error, setError] = useState('');

  const dismiss = useOverlayDraft({ title, people, bring }, create.isPending, onClose);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const room = await create.mutateAsync({
        kind: 'room',
        ...(title.trim() ? { title: title.trim() } : {}),
        member_ids: people,
        agent_ids: bring,
      });
      dismiss.saved();
      navigate({ page: 'conversation', id: room.id });
    } catch (caught) {
      setError(errorText(caught, t));
    }
  };

  return (
    <>
      <Overlay variant="dialog" title={t('chat.newRoom')} onClose={onClose} beforeClose={dismiss.beforeClose}>
        <form {...dismiss.formProps} id="new-room" className="app-form" onSubmit={(event) => void submit(event)}>
          <Field label={t('chat.newRoomTitle')}>
            <Input value={title} maxLength={120} autoFocus onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <FieldGroup label={t('chat.addPeople')}>
            <MultiSelect
              label={t('chat.addPeople')}
              value={people}
              options={members
                .filter((member) => member.id !== me.id)
                .map((member) => ({ value: member.id, label: member.name, description: member.email }))}
              onChange={setPeople}
            />
          </FieldGroup>
          <FieldGroup label={t('chat.addAgents')}>
            <MultiSelect
              label={t('chat.addAgents')}
              value={bring}
              options={agents.map((agent) => ({ value: agent.handle, label: agent.name, description: agent.role }))}
              onChange={setBring}
            />
          </FieldGroup>
          {error && (
            <p className="app-form-error" role="alert">
              {error}
            </p>
          )}
        </form>
        <OverlayActions>
          <Button onClick={dismiss.close}>{t('common.cancel')}</Button>
          <Button kind="primary" type="submit" form="new-room" loading={create.isPending}>
            {t('chat.createRoom')}
          </Button>
        </OverlayActions>
      </Overlay>
      {dismiss.confirmation}
    </>
  );
}
