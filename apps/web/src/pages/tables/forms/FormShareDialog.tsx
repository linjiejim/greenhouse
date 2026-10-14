/**
 * Who may submit a form: members, groups or everyone, saved together. With none, the table's
 * editors may (the dialog says so plainly); the base's builders always may.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Building2, Trash2, Users } from 'lucide-react';
import {
  Button,
  ErrorBox,
  IconButton,
  Overlay,
  OverlayActions,
  Select,
  Skeleton,
  type SelectOption,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { Base, Form, FormShare } from '@greenhouse/contract';
import { useNotify } from '../../../app/notify';
import { usePeople } from '../../../data/people';
import { queryClient } from '../../../data/query';
import { formsKeys, useFormShares } from '../../../data/tables-forms';
import { api } from '../../../lib/api';
import { useI18n } from '../../../lib/i18n';
import { MemberAvatar } from '../../../shell/MemberAvatar';
import { formsError } from './errors';

type Entry = Pick<FormShare, 'type' | 'id' | 'name'>;
const keyOf = (entry: Pick<Entry, 'type' | 'id'>) => `${entry.type}:${entry.id ?? ''}`;

export function FormShareDialog({ base, form, onClose }: { base: Base; form: Form; onClose: () => void }) {
  const { t } = useI18n();
  const notify = useNotify();
  const { members, memberById } = usePeople();
  const shares = useFormShares(base.id, form.id);
  const groups = useQuery({
    queryKey: ['groups', 'directory'],
    queryFn: () => api.members.groups(),
    staleTime: 60_000,
  });
  const [items, setItems] = useState<Entry[] | null>(null);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = items ?? shares.data?.items ?? [];
  const taken = new Set(current.map(keyOf));
  const candidates: SelectOption[] = [
    ...(taken.has('workspace:') ? [] : [{ value: 'workspace:', label: t('tables.share.everyone') }]),
    ...(groups.data?.items ?? [])
      .filter((group) => !taken.has(`group:${group.id}`))
      .map((group) => ({ value: `group:${group.id}`, label: group.name, description: t('tables.share.group') })),
    ...members
      .filter((member) => !taken.has(`member:${member.id}`))
      .map((member) => ({
        value: `member:${member.id}`,
        label: member.name,
        description: member.email,
        icon: <MemberAvatar name={member.name} url={member.avatar_url} size={18} />,
      })),
  ];
  const nameOf = (entry: Entry) => (entry.type === 'workspace' ? t('tables.share.everyone') : entry.name);
  const add = () => {
    if (!adding) return;
    const [type, id] = adding.split(':') as [Entry['type'], string];
    const name =
      type === 'workspace'
        ? ''
        : type === 'group'
          ? (groups.data?.items.find((group) => group.id === id)?.name ?? '')
          : (memberById.get(id)?.name ?? '');
    setItems([...current, { type, id: type === 'workspace' ? null : id, name }]);
    setAdding('');
  };
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const saved = await api.tables.forms.share(form.id, {
        items: current.map((entry) => ({ type: entry.type, ...(entry.id ? { id: entry.id } : {}) })),
      });
      queryClient.setQueryData(formsKeys.shares(base.id, form.id), saved);
      notify(t('tables.forms.shareSaved'));
      onClose();
    } catch (failure) {
      setError(formsError(failure, t));
      setBusy(false);
    }
  };
  return (
    <Overlay variant="dialog" wide title={t('tables.forms.shareTitle', { name: form.name })} onClose={onClose}>
      {shares.isPending ? (
        <Skeleton lines={3} />
      ) : shares.isError ? (
        <ErrorBox onRetry={() => void shares.refetch()}>{formsError(shares.error, t)}</ErrorBox>
      ) : (
        <div className="app-tf-share">
          <p className="app-tf-note">{t('tables.forms.shareDefault')}</p>
          <div className="app-tf-share-add">
            <Select
              label={t('tables.forms.shareAdd')}
              placeholder={t('tables.forms.shareAdd')}
              value={adding}
              options={candidates}
              onChange={setAdding}
            />
            <Button onClick={add} disabled={!adding}>
              {t('tables.forms.shareAddButton')}
            </Button>
          </div>
          {current.length ? (
            <ul className="app-tb-share-list">
              {current.map((entry) => (
                <li key={keyOf(entry)}>
                  {entry.type === 'member' ? (
                    <MemberAvatar name={entry.name} url={memberById.get(entry.id ?? '')?.avatar_url} size={28} />
                  ) : (
                    <span className="app-tb-share-icon" aria-hidden>
                      {entry.type === 'group' ? <Users size={icon.md} /> : <Building2 size={icon.md} />}
                    </span>
                  )}
                  <span className="app-tb-share-name">{nameOf(entry)}</span>
                  <IconButton
                    size="sm"
                    label={t('tables.forms.shareRemove', { name: nameOf(entry) })}
                    onClick={() => setItems(current.filter((item) => keyOf(item) !== keyOf(entry)))}
                  >
                    <Trash2 size={icon.sm} strokeWidth={icon.stroke} />
                  </IconButton>
                </li>
              ))}
            </ul>
          ) : (
            <p className="app-tf-note">{t('tables.forms.shareNone')}</p>
          )}
          {error && (
            <p className="app-form-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
      <OverlayActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button kind="primary" loading={busy} disabled={!items} onClick={() => void save()}>
          {t('tables.forms.save')}
        </Button>
      </OverlayActions>
    </Overlay>
  );
}
