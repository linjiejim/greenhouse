/**
 * 分享 (KNOW-10): members, groups or the whole workspace, each viewer or editor. Shares from the
 * folders above are listed and explained; a share here can only widen them. Saving replaces the
 * item's own shares at once. Only the owner of a personal item gets here; the team space is
 * everyone's already and an Agent's folder stays private (the API answers `team_space` and
 * `agent_folder_private`, which read the same).
 */

import { useEffect, useState } from 'react';
import { Building2, User, Users, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
  ConfirmDialog,
  ErrorBox,
  FieldGroup,
  IconButton,
  MultiSelect,
  Overlay,
  OverlayActions,
  Select,
  Skeleton,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { KnowledgeShare, KnowledgeShareRole } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useMe } from '../../app/session';
import { useNotify } from '../../app/notify';
import { useKnowledgeActions, useShares } from '../../data/knowledge';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useI18n, type Translate } from '../../lib/i18n';

type Entry = Pick<KnowledgeShare, 'type' | 'id' | 'name' | 'role'>;
const keyOf = (entry: Pick<Entry, 'type' | 'id'>) => `${entry.type}:${entry.id ?? ''}`;

const same = (a: readonly Entry[], b: readonly Entry[]) =>
  a.length === b.length &&
  a.every((entry) => b.some((other) => keyOf(other) === keyOf(entry) && other.role === entry.role));

export function shareError(error: unknown, t: Translate): string {
  if (error instanceof ApiClientError && error.code === 'team_space') return t('knowledge.teamShared');
  if (error instanceof ApiClientError && error.code === 'agent_folder_private') return t('knowledge.agentPrivate');
  return errorText(error, t);
}

function EntryIcon({ type }: { type: Entry['type'] }) {
  const Icon = type === 'member' ? User : type === 'group' ? Users : Building2;
  return <Icon size={icon.md} strokeWidth={icon.stroke} className="app-file-icon" aria-hidden />;
}

export function ShareDialog({
  type,
  id,
  name,
  onClose,
}: {
  type: 'folder' | 'doc';
  id: string;
  name: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const shares = useShares(type, id);
  const { share } = useKnowledgeActions();
  const directory = useQuery({
    queryKey: ['members', 'directory'],
    queryFn: () => api.members.directory(),
    staleTime: 5 * 60_000,
  });
  const groups = useQuery({ queryKey: ['groups', 'directory'], queryFn: () => api.members.groups() });
  const [draft, setDraft] = useState<Entry[] | null>(null);
  const [adding, setAdding] = useState<string[]>([]);
  const [role, setRole] = useState<KnowledgeShareRole>('viewer');
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (shares.data && draft === null)
      setDraft(
        shares.data.items.map(({ type: kind, id: who, name: label, role: as }) => ({
          type: kind,
          id: who,
          name: label,
          role: as,
        })),
      );
  }, [shares.data, draft]);

  const roleWord = (value: KnowledgeShareRole) =>
    value === 'editor' ? t('knowledge.canEdit') : t('knowledge.canView');
  const roleOptions = [
    { value: 'viewer', label: t('knowledge.canView') },
    { value: 'editor', label: t('knowledge.canEdit') },
  ];
  // A group deleted since it was shared has no name any more; the share stays until removed here.
  const nameOf = (entry: Pick<Entry, 'type' | 'name'>) =>
    entry.type === 'workspace'
      ? t('knowledge.everyone')
      : entry.name || (entry.type === 'group' ? t('knowledge.deletedGroup') : t('knowledge.someone'));
  const taken = new Set((draft ?? []).map(keyOf));
  const options = [
    ...(taken.has('workspace:')
      ? []
      : [{ value: 'workspace:', label: t('knowledge.everyone'), description: t('knowledge.everyoneHint') }]),
    ...(groups.data?.items ?? [])
      .filter((group) => !taken.has(`group:${group.id}`))
      .map((group) => ({
        value: `group:${group.id}`,
        label: group.name,
        description: t('chat.people', { count: group.member_ids.length }),
      })),
    ...(directory.data?.items ?? [])
      .filter((member) => member.id !== me.id && !taken.has(`member:${member.id}`))
      .map((member) => ({ value: `member:${member.id}`, label: member.name, description: member.email })),
  ];
  const labelOf = (value: string) => options.find((option) => option.value === value)?.label ?? '';
  const dirty = draft !== null && !!shares.data && !same(draft, shares.data.items);

  const add = () => {
    if (!adding.length) return;
    const added = adding.map((value): Entry => {
      const [kind, who] = value.split(':') as [Entry['type'], string];
      return { type: kind, id: kind === 'workspace' ? null : who, name: labelOf(value), role };
    });
    setDraft([...(draft ?? []), ...added]);
    setAdding([]);
    setError('');
  };

  const save = async () => {
    if (!draft) return;
    setError('');
    try {
      await share.mutateAsync({
        type,
        id,
        input: {
          items: draft.map((entry) => ({ type: entry.type, ...(entry.id ? { id: entry.id } : {}), role: entry.role })),
        },
      });
      onClose();
      notify(t('knowledge.sharedDone', { name }));
    } catch (caught) {
      setError(shareError(caught, t));
    }
  };

  return (
    <Overlay
      variant="dialog"
      wide
      title={t('knowledge.shareTitle', { name })}
      help={t('knowledge.shareHelp')}
      onClose={onClose}
      beforeClose={() => {
        if (!dirty) return true;
        setAsking(true);
        return false;
      }}
    >
      {shares.isPending || draft === null ? (
        shares.isError ? (
          <ErrorBox onRetry={() => void shares.refetch()}>{shareError(shares.error, t)}</ErrorBox>
        ) : (
          <Skeleton lines={3} />
        )
      ) : (
        <div className="app-overlay-stack">
          {shares.data!.inherited.length > 0 && (
            <section className="app-share-section" aria-label={t('knowledge.inherited')}>
              <h3 className="app-section-title">{t('knowledge.inherited')}</h3>
              <ul className="app-share-list">
                {shares.data!.inherited.map((entry) => (
                  <li key={`${entry.folder_id}:${keyOf(entry)}`}>
                    <EntryIcon type={entry.type} />
                    <span className="app-list-main">
                      <span className="app-list-title">{nameOf(entry)}</span>
                      <span className="app-list-meta">{t('knowledge.fromFolder', { folder: entry.folder_name })}</span>
                    </span>
                    <span className="app-muted">{roleWord(entry.role)}</span>
                  </li>
                ))}
              </ul>
              <p className="app-muted">{t('knowledge.inheritedHint')}</p>
            </section>
          )}
          <section className="app-share-section" aria-label={t('knowledge.sharedWith')}>
            <h3 className="app-section-title">{t('knowledge.sharedWith')}</h3>
            {draft.length ? (
              <ul className="app-share-list">
                {draft.map((entry) => (
                  <li key={keyOf(entry)}>
                    <EntryIcon type={entry.type} />
                    <span className="app-list-main">
                      <span className="app-list-title">{nameOf(entry)}</span>
                    </span>
                    <Select
                      label={t('knowledge.roleOf', { name: nameOf(entry) })}
                      size="sm"
                      value={entry.role}
                      options={roleOptions}
                      onChange={(value) =>
                        setDraft(
                          draft.map((other) =>
                            keyOf(other) === keyOf(entry) ? { ...other, role: value as KnowledgeShareRole } : other,
                          ),
                        )
                      }
                    />
                    <IconButton
                      size="sm"
                      label={t('knowledge.unshare', { name: nameOf(entry) })}
                      onClick={() => setDraft(draft.filter((other) => keyOf(other) !== keyOf(entry)))}
                    >
                      <X size={icon.sm} strokeWidth={icon.stroke} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="app-muted">{t('knowledge.notShared')}</p>
            )}
          </section>
          <FieldGroup label={t('knowledge.addPeople')}>
            <div className="app-share-add">
              <MultiSelect
                label={t('knowledge.addPeople')}
                placeholder={t('knowledge.pickPeople')}
                value={adding}
                max={3}
                options={options}
                onChange={setAdding}
              />
              <Select
                label={t('knowledge.role')}
                value={role}
                options={roleOptions}
                onChange={(value) => setRole(value as KnowledgeShareRole)}
              />
              <Button onClick={add} disabled={!adding.length}>
                {t('knowledge.add')}
              </Button>
            </div>
          </FieldGroup>
          {error && (
            <p className="app-form-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
      <OverlayActions>
        <Button onClick={() => (dirty ? setAsking(true) : onClose())}>{t('common.cancel')}</Button>
        <Button
          kind="primary"
          loading={share.isPending}
          disabled={!dirty}
          disabledReason={t('knowledge.nothingChanged')}
          onClick={() => void save()}
        >
          {t('knowledge.saveShares')}
        </Button>
      </OverlayActions>
      {asking && (
        <ConfirmDialog
          danger
          title={t('knowledge.discardSharesTitle')}
          confirmLabel={t('knowledge.discard')}
          cancelLabel={t('knowledge.keepEditing')}
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            onClose();
          }}
        >
          {t('knowledge.discardSharesBody')}
        </ConfirmDialog>
      )}
    </Overlay>
  );
}
