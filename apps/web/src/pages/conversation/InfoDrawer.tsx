/**
 * The side panel's info view (CONV-22): who is here (rooms: add people and my Agents, the owner
 * removes people), the shared notes everyone here can write (CONV-24), and the summary of
 * older messages.
 */

import { useState, type FormEvent } from 'react';
import { Pin, PinOff, Plus, Trash2, UserMinus } from 'lucide-react';
import {
  Button,
  Checkbox,
  Empty,
  Field,
  IconButton,
  Input,
  MultiSelect,
  Overlay,
  Skeleton,
  TextArea,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { Conversation, ConversationDetail, Note } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import { useConversationMembers, useMemberActions, useNoteActions, useNotes } from '../../data/conversations';
import { usePeople } from '../../data/people';
import { cx } from '../../lib/cx';
import { useI18n } from '../../lib/i18n';
import { href } from '../../lib/router';
import { AgentAvatar } from '../../shell/AgentAvatar';
import { MemberAvatar } from '../../shell/MemberAvatar';

function People({ conversation }: { conversation: Conversation }) {
  const { t } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const people = usePeople();
  const room = conversation.kind === 'room';
  const members = useConversationMembers(conversation.id);
  const actions = useMemberActions(conversation.id);
  const [adding, setAdding] = useState<string[]>([]);
  const [bringing, setBringing] = useState<string[]>([]);
  const failed = (error: unknown) => notify(error instanceof ApiClientError ? error.message : t('common.error'));
  if (members.isPending) return <Skeleton lines={3} />;
  const data = members.data;
  const owner = data?.members.find((member) => member.role === 'owner')?.id === me.id;
  const inRoom = new Set(data?.members.map((member) => member.id));
  const agentsHere = new Set(data?.agents.map((agent) => agent.id));

  return (
    <section className="app-info-section">
      <h3>{t('chat.inThisConversation')}</h3>
      <ul className="app-info-people">
        {(data?.agents ?? []).map((agent) => {
          const mine = agent.owner_id === me.id;
          return (
            <li key={agent.id}>
              <AgentAvatar agent={{ id: agent.id, avatar: agent.avatar, template_key: null }} size={28} />
              {mine ? (
                <a href={href({ page: 'agent', id: agent.id, tab: 'profile' })}>{agent.name}</a>
              ) : (
                <span>{agent.name}</span>
              )}
              <span className="app-info-hint">
                {mine ? agent.role : (people.memberById.get(agent.owner_id)?.name ?? agent.role)}
              </span>
            </li>
          );
        })}
        {(data?.members ?? []).map((member) => (
          <li key={member.id}>
            <MemberAvatar name={member.name} url={member.avatar_url} size={28} />
            <span>{member.id === me.id ? `${member.name}（${t('message.you')}）` : member.name}</span>
            {member.role === 'owner' && <span className="app-info-hint">{t('chat.owner')}</span>}
            {room && owner && member.id !== me.id && (
              <IconButton
                label={t('chat.remove', { name: member.name })}
                size="sm"
                onClick={() => actions.remove.mutate(member.id, { onError: failed })}
              >
                <UserMinus size={icon.sm} />
              </IconButton>
            )}
          </li>
        ))}
      </ul>
      {room && (
        <div className="app-info-add">
          <MultiSelect
            label={t('chat.addPeople')}
            placeholder={t('chat.addPeople')}
            value={adding}
            options={people.members
              .filter((member) => !inRoom.has(member.id))
              .map((member) => ({ value: member.id, label: member.name, description: member.email }))}
            onChange={setAdding}
          />
          <MultiSelect
            label={t('chat.addAgents')}
            placeholder={t('chat.addAgents')}
            value={bringing}
            options={people.agents
              .filter((agent) => !agentsHere.has(agent.id))
              .map((agent) => ({ value: agent.handle, label: agent.name, description: agent.role }))}
            onChange={setBringing}
          />
          <Button
            disabled={!adding.length && !bringing.length}
            loading={actions.add.isPending}
            onClick={() =>
              actions.add.mutate(
                { member_ids: adding, agent_ids: bringing },
                {
                  onSuccess: () => {
                    setAdding([]);
                    setBringing([]);
                  },
                  onError: failed,
                },
              )
            }
          >
            <Plus size={icon.md} />
            {t('chat.add')}
          </Button>
        </div>
      )}
    </section>
  );
}

function NoteRow({ conversationId, note }: { conversationId: string; note: Note }) {
  const { t } = useI18n();
  const actions = useNoteActions(conversationId);
  return (
    <li className={cx('app-note', note.status === 'done' && 'is-done')}>
      <Checkbox
        checked={note.status === 'done'}
        aria-label={t('chat.noteDone')}
        onChange={(checked) => actions.update.mutate({ id: note.id, input: { status: checked ? 'done' : 'open' } })}
      />
      <div className="app-note-text">
        {note.title && <strong>{note.title}</strong>}
        {note.body && <p>{note.body}</p>}
      </div>
      <IconButton
        label={note.pinned ? t('row.unpin') : t('row.pin')}
        size="sm"
        onClick={() => actions.update.mutate({ id: note.id, input: { pinned: !note.pinned } })}
      >
        {note.pinned ? <PinOff size={icon.sm} /> : <Pin size={icon.sm} />}
      </IconButton>
      <IconButton label={t('row.delete')} size="sm" onClick={() => actions.remove.mutate(note.id)}>
        <Trash2 size={icon.sm} />
      </IconButton>
    </li>
  );
}

function Notes({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const notes = useNotes(conversationId);
  const actions = useNoteActions(conversationId);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() && !body.trim()) return;
    actions.add.mutate(
      { title: title.trim(), body },
      {
        onSuccess: () => {
          setTitle('');
          setBody('');
        },
      },
    );
  };
  return (
    <section className="app-info-section">
      <h3>{t('chat.notes')}</h3>
      {notes.isPending ? (
        <Skeleton lines={2} />
      ) : notes.items.length ? (
        <ul className="app-notes">
          {notes.items.map((note) => (
            <NoteRow key={note.id} conversationId={conversationId} note={note} />
          ))}
        </ul>
      ) : (
        <Empty title={t('chat.noNotes')} />
      )}
      <form className="app-form" onSubmit={submit} aria-label={t('chat.addNote')}>
        <Field label={t('chat.noteTitle')}>
          <Input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label={t('chat.noteBody')}>
          <TextArea value={body} maxRows={6} onChange={(event) => setBody(event.target.value)} />
        </Field>
        <Button type="submit" disabled={!title.trim() && !body.trim()} loading={actions.add.isPending}>
          {t('chat.addNote')}
        </Button>
      </form>
    </section>
  );
}

export function InfoDrawer({
  conversation,
  detail,
  onClose,
}: {
  conversation: Conversation;
  detail: ConversationDetail | undefined;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Overlay title={t('chat.info')} onClose={onClose}>
      <People conversation={conversation} />
      <Notes conversationId={conversation.id} />
      {detail?.digest && (
        <section className="app-info-section">
          <h3>{t('chat.summary')}</h3>
          <p className="app-info-summary">{detail.digest}</p>
        </section>
      )}
    </Overlay>
  );
}
