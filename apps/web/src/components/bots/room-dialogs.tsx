/**
 * Room dialogs (spec 20261011-agent-first-class P5):
 * - `NewRoomDialog` — "New conversation with people": pick people (`GET /api/rooms/people`), an
 *   optional title, optionally some of the member's own Agents → `POST /api/rooms` → open it. One
 *   person, no title, no Agents is the pair's private chat (the existing one opens).
 * - `AddPeopleDialog` — add people to a room (one `POST …/participants` each).
 * - `RoomAgentsDialog` — the Agents in a room (take out the ones the member may) and the ones they
 *   may bring: their own, and public Agents offered to them (the server checks the rest, D45).
 *
 * Every refusal is explained in the member's words (`roomErrorMessage`): the room routes answer
 * with a status, not a code.
 */

import { useEffect, useMemo, useState } from 'react';
import type { BotConversationDetail, BotView } from '@greenhouse/types/bots';
import { Button, Checkbox, Dialog, EmptyState, Input, SearchInput, Skeleton, toast } from '../ui';
import { FormActions, FormError, FormField, FormSection } from '../form';
import { AlertTriangle, Users } from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';
import * as botsApi from '../../lib/api/bots';
import type { RoomPerson } from '../../lib/api/bots';
import { BotAvatar } from './bot-avatar';
import { sharedBotAsView, useBotsStore } from './bots-store';
import { openBotsConversation } from './navigation';
import { PersonAvatar } from './person-avatar';
import type { RoomView } from './use-room';

type Translate = ReturnType<typeof useT>;

/** A room route's refusal in the member's words (the routes answer with a status; `busy` is the one code). */
export function roomErrorMessage(err: unknown, t: Translate, fallback: TranslationKey): string {
  if (botsApi.isBotsApiError(err, 'busy')) return t('bots.room.errors.busy');
  if (botsApi.isBotsApiError(err)) {
    if (err.status === 400) return t('bots.room.errors.people');
    if (err.status === 403) return t('bots.room.errors.notAllowed');
    if (err.status === 404) return t('bots.room.errors.agentGone');
    if (err.status === 409) return t('bots.room.errors.notForEveryone');
  }
  return t(fallback, { reason: err instanceof Error ? err.message : String(err) });
}

type PeopleLoad = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; people: RoomPerson[] };

/** Who the member can talk with, read each time a picker opens. */
function useRoomPeople(open: boolean): { load: PeopleLoad; retry: () => void } {
  const [load, setLoad] = useState<PeopleLoad>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoad({ state: 'loading' });
    botsApi.listRoomPeople().then(
      (people) => live && setLoad({ state: 'ready', people }),
      () => live && setLoad({ state: 'failed' }),
    );
    return () => {
      live = false;
    };
  }, [open, attempt]);
  return { load, retry: () => setAttempt((value) => value + 1) };
}

function toggle(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Search + a checklist of people (initial, name, email). */
function PeoplePicker({
  load,
  onRetry,
  selected,
  onToggle,
  exclude,
}: {
  load: PeopleLoad;
  onRetry: () => void;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  /** Already in the room. */
  exclude?: ReadonlySet<string>;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    if (load.state !== 'ready') return [];
    const needle = query.trim().toLocaleLowerCase();
    return load.people.filter(
      (person) =>
        !exclude?.has(person.id) &&
        (!needle ||
          person.nickname.toLocaleLowerCase().includes(needle) ||
          person.email.toLocaleLowerCase().includes(needle)),
    );
  }, [exclude, load, query]);

  if (load.state === 'loading') {
    return (
      <div className="space-y-2" aria-busy="true">
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex items-center gap-2">
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-3 flex-1" />
          </div>
        ))}
      </div>
    );
  }
  if (load.state === 'failed') {
    return (
      <EmptyState
        variant="compact"
        tone="danger"
        icon={AlertTriangle}
        title={t('bots.room.peopleFailed')}
        action={
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t('bots.retry')}
          </Button>
        }
      />
    );
  }
  const available = load.people.filter((person) => !exclude?.has(person.id));
  if (available.length === 0) {
    return (
      <EmptyState
        variant="compact"
        icon={Users}
        title={exclude ? t('bots.room.everyoneHere') : t('bots.room.nobodyTitle')}
        description={exclude ? undefined : t('bots.room.nobodyDescription')}
      />
    );
  }
  return (
    <div>
      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder={t('bots.room.searchPeople')}
        aria-label={t('bots.room.searchPeople')}
      />
      <ul className="mt-1.5 max-h-56 space-y-0.5 overflow-y-auto" data-testid="room-people-list">
        {shown.length === 0 ? (
          <li className="px-1 py-2 text-xs text-fg-faint">{t('bots.room.noPersonMatch', { query: query.trim() })}</li>
        ) : (
          shown.map((person) => (
            <li
              key={person.id}
              className="rounded-md px-1 py-1 hover:bg-surface-muted"
              data-testid="room-person-option"
              data-user-id={person.id}
            >
              <Checkbox
                checked={selected.has(person.id)}
                onChange={() => onToggle(person.id)}
                aria-label={person.nickname}
                label={
                  <span className="flex min-w-0 items-center gap-2">
                    <PersonAvatar name={person.nickname} size="xs" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-fg">{person.nickname}</span>
                      {person.email && person.email !== person.nickname && (
                        <span className="block truncate text-[11px] text-fg-faint">{person.email}</span>
                      )}
                    </span>
                  </span>
                }
              />
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

export function NewRoomDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const bots = useBotsStore((state) => state.bots);
  const loadConversations = useBotsStore((state) => state.loadConversations);
  const { load, retry } = useRoomPeople(open);
  const [people, setPeople] = useState<Set<string>>(new Set());
  const [agents, setAgents] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPeople(new Set());
    setAgents(new Set());
    setTitle('');
    setError(null);
  }, [open]);

  const privateChat = people.size === 1 && !title.trim() && agents.size === 0;

  const create = async () => {
    if (people.size === 0 || creating) return;
    setCreating(true);
    setError(null);
    try {
      const { conversation } = await botsApi.createRoom({
        userIds: [...people],
        title,
        botIds: [...agents],
      });
      useBotsStore.getState().noteSession(conversation.session_id);
      void loadConversations().catch(() => {});
      onClose();
      openBotsConversation(conversation.session_id);
    } catch (err) {
      setError(roomErrorMessage(err, t, 'bots.room.errors.createFailed'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('bots.room.newTitle')} size="md">
      <div className="space-y-4" data-testid="room-new-dialog">
        <p className="text-xs leading-5 text-fg-muted">{t('bots.room.newHint')}</p>
        <PeoplePicker
          load={load}
          onRetry={retry}
          selected={people}
          onToggle={(id) => setPeople((current) => toggle(current, id))}
        />
        <FormField label={t('bots.room.titleLabel')} help={t('bots.room.titleHelp')}>
          <Input
            value={title}
            maxLength={200}
            placeholder={t('bots.room.titlePlaceholder')}
            onChange={(event) => setTitle(event.target.value)}
            data-testid="room-title-field"
          />
        </FormField>
        {bots.length > 0 && (
          <FormSection title={t('bots.room.bringAgents')} description={t('bots.room.bringAgentsHint')}>
            <ul className="max-h-40 space-y-0.5 overflow-y-auto" data-testid="room-agent-options">
              {bots.map((bot) => (
                <li key={bot.id} className="rounded-md px-1 py-1 hover:bg-surface-muted">
                  <Checkbox
                    checked={agents.has(bot.id)}
                    onChange={() => setAgents((current) => toggle(current, bot.id))}
                    aria-label={bot.name}
                    label={
                      <span className="flex min-w-0 items-center gap-2">
                        <BotAvatar bot={bot} size="xs" />
                        <span className="min-w-0 truncate text-sm text-fg">{bot.name}</span>
                        {bot.role && <span className="min-w-0 truncate text-[11px] text-fg-faint">{bot.role}</span>}
                      </span>
                    }
                  />
                </li>
              ))}
            </ul>
          </FormSection>
        )}
        <FormError>{error}</FormError>
        <FormActions
          leading={
            privateChat ? (
              <span className="text-[11px] text-fg-faint" data-testid="room-private-hint">
                {t('bots.room.privateHint')}
              </span>
            ) : undefined
          }
        >
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={people.size === 0 || creating} onClick={() => void create()} data-testid="room-create">
            {creating ? t('bots.room.creating') : privateChat ? t('bots.room.openPrivate') : t('bots.room.create')}
          </Button>
        </FormActions>
      </div>
    </Dialog>
  );
}

export function AddPeopleDialog({
  open,
  conversation,
  onClose,
  onChanged,
}: {
  open: boolean;
  conversation: BotConversationDetail;
  onClose: () => void;
  onChanged: (next: BotConversationDetail) => void;
}) {
  const t = useT();
  const { load, retry } = useRoomPeople(open);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const here = useMemo(
    () => new Set((conversation.participants ?? []).map((person) => person.user_id)),
    [conversation.participants],
  );

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setError(null);
  }, [open]);

  const add = async () => {
    if (selected.size === 0 || adding) return;
    setAdding(true);
    setError(null);
    let latest: BotConversationDetail | null = null;
    const added: string[] = [];
    try {
      // One person at a time: each joins with their own line in the conversation.
      for (const userId of selected) {
        latest = await botsApi.addRoomPerson(conversation.session_id, userId);
        added.push(userId);
      }
      if (latest) onChanged(latest);
      toast(
        added.length === 1 ? t('bots.room.personAdded') : t('bots.room.peopleAdded', { count: added.length }),
        'success',
      );
      onClose();
    } catch (err) {
      if (latest) onChanged(latest);
      setSelected((current) => new Set([...current].filter((id) => !added.includes(id))));
      setError(roomErrorMessage(err, t, 'bots.room.errors.addFailed'));
    } finally {
      setAdding(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('bots.room.addPeople')} size="md">
      <div className="space-y-4" data-testid="room-add-people-dialog">
        <p className="text-xs leading-5 text-fg-muted">{t('bots.room.addPeopleHint')}</p>
        <PeoplePicker
          load={load}
          onRetry={retry}
          selected={selected}
          onToggle={(id) => setSelected((current) => toggle(current, id))}
          exclude={here}
        />
        <FormError>{error}</FormError>
        <FormActions>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={selected.size === 0 || adding} onClick={() => void add()} data-testid="room-add-people">
            {t('bots.room.add')}
          </Button>
        </FormActions>
      </div>
    </Dialog>
  );
}

export function RoomAgentsDialog({
  open,
  conversation,
  room,
  onClose,
  onChanged,
}: {
  open: boolean;
  conversation: BotConversationDetail;
  room: RoomView;
  onClose: () => void;
  /** Something changed: the detail when the route returned one, else null (re-read). */
  onChanged: (next: BotConversationDetail | null) => void;
}) {
  const t = useT();
  const bots = useBotsStore((state) => state.bots);
  const [publicAgents, setPublicAgents] = useState<BotView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    botsApi.listPublicAgents().then(
      (agents) => live && setPublicAgents(agents.map(sharedBotAsView)),
      () => live && setPublicAgents([]),
    );
    return () => {
      live = false;
    };
  }, [open]);

  const here = new Set(conversation.members.map((member) => member.bot_id));
  const candidates = [...bots, ...publicAgents.filter((agent) => !bots.some((bot) => bot.id === agent.id))].filter(
    (bot) => !here.has(bot.id),
  );

  const bring = async (bot: BotView) => {
    setBusy(bot.id);
    try {
      onChanged(await botsApi.addRoomAgent(conversation.session_id, bot.id));
      toast(t('bots.invite.added', { name: bot.name }), 'success');
    } catch (err) {
      toast(roomErrorMessage(err, t, 'bots.room.errors.bringFailed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (bot: BotView) => {
    setBusy(bot.id);
    try {
      await botsApi.removeRoomAgent(conversation.session_id, bot.id);
      onChanged(null);
      toast(t('bots.info.removed', { name: bot.name }), 'success');
    } catch (err) {
      toast(roomErrorMessage(err, t, 'bots.room.errors.removeFailed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('bots.room.agentsTitle')} size="md">
      <div className="space-y-4" data-testid="room-agents-dialog">
        <p className="text-xs leading-5 text-fg-muted">{t('bots.room.agentsHint')}</p>
        <FormSection title={t('bots.room.agentsHere')}>
          {room.agents.length === 0 ? (
            <p className="text-xs text-fg-faint">{t('bots.room.noAgentsHere')}</p>
          ) : (
            <ul className="space-y-0.5" data-testid="room-agents-here">
              {room.agents.map((agent) => (
                <li
                  key={agent.bot.id}
                  className="flex items-center gap-2 rounded-md px-1 py-1"
                  data-testid="room-agent-row"
                  data-bot-id={agent.bot.id}
                >
                  <BotAvatar bot={agent.bot} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-fg">{agent.bot.name}</span>
                    <span className="block truncate text-[11px] text-fg-faint">
                      {agent.mine
                        ? t('bots.room.yours')
                        : t('bots.room.ownedBy', { name: room.personName(agent.member.owner_user_id) })}
                    </span>
                  </span>
                  {agent.removable && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void remove(agent.bot)}
                      data-testid="room-agent-remove"
                    >
                      {t('bots.room.removeAgent')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </FormSection>
        <FormSection title={t('bots.room.bringAgent')}>
          {candidates.length === 0 ? (
            <p className="text-xs text-fg-faint">{t('bots.room.noAgentsLeft')}</p>
          ) : (
            <ul className="max-h-56 space-y-0.5 overflow-y-auto" data-testid="room-agent-candidates">
              {candidates.map((bot) => (
                <li
                  key={bot.id}
                  className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-muted"
                  data-testid="room-agent-candidate"
                  data-bot-id={bot.id}
                >
                  <BotAvatar bot={bot} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-fg">{bot.name}</span>
                    <span className="block truncate text-[11px] text-fg-faint">
                      {bot.user_id && bots.some((own) => own.id === bot.id)
                        ? bot.role || t('bots.room.yours')
                        : t('bots.room.publicAgent')}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void bring(bot)}
                    data-testid="room-agent-bring"
                  >
                    {t('bots.room.bring')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </FormSection>
        <FormActions>
          <Button variant="ghost" onClick={onClose}>
            {t('bots.room.done')}
          </Button>
        </FormActions>
      </div>
    </Dialog>
  );
}
