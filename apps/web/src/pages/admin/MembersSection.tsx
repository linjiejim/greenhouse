import { errorText } from '../../lib/errors';
import { useOverlayDraft } from '../../lib/useOverlayDraft';
/**
 * 管理 → 成员与分组 (ADM-01, ADM-02, ADM-03): invite by email (a one-time link, mailed when the
 * mail service can send and always there to hand over),
 * change role and modules, disable or re-enable, issue a reset link; groups with their people.
 */

import { useState, type FormEvent } from 'react';
import { Copy, Plus } from 'lucide-react';
import {
  Button,
  ConfirmDialog,
  Empty,
  ErrorBox,
  Field,
  FieldGroup,
  Input,
  Menu,
  MultiSelect,
  Overlay,
  OverlayActions,
  Select,
  Skeleton,
  StatusBadge,
  Switch,
  Tabs,
  TextArea,
  type Tone,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { MEMBER_MODULES, type Group, type IssuedLink, type MemberAdmin } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import type { MessageKey } from '../../i18n/zh';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { calendarDay, relativeTime } from '../../lib/time';
import { MemberAvatar } from '../../shell/MemberAvatar';

const MEMBERS = ['admin', 'members'] as const;
const GROUPS = ['admin', 'groups'] as const;

const STATUS: Record<MemberAdmin['status'], { word: MessageKey; tone: Tone }> = {
  active: { word: 'members.active', tone: 'success' },
  invited: { word: 'members.invited', tone: 'neutral' },
  reset_required: { word: 'members.resetRequired', tone: 'warning' },
  disabled: { word: 'members.disabled', tone: 'neutral' },
};

const MODULE_LABEL: Record<(typeof MEMBER_MODULES)[number], MessageKey> = {
  knowledge: 'nav.knowledge',
  tables: 'nav.tables',
  apps: 'nav.apps',
  computer: 'agents.tabComputer',
};

function LinkDialog({ link, email, onClose }: { link: IssuedLink; email: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const me = useMe();
  const notify = useNotify();
  return (
    <Overlay
      variant="dialog"
      title={
        link.delivery === 'emailed'
          ? t('members.linkEmailedTitle')
          : link.delivery === 'failed'
            ? t('members.linkFailedTitle')
            : t('members.linkTitle')
      }
      onClose={onClose}
    >
      <p className="app-muted">
        {link.delivery === 'emailed'
          ? t('members.linkEmailedBody', { email })
          : link.delivery === 'failed'
            ? t('members.linkFailedBody', { email })
            : t('members.linkBody', { email })}
      </p>
      <div className="app-copy-row">
        <Input readOnly value={link.url} aria-label={t('members.link')} onFocus={(event) => event.target.select()} />
        <Button onClick={() => void navigator.clipboard?.writeText(link.url).then(() => notify(t('row.linkCopied')))}>
          <Copy size={icon.sm} />
          {t('row.copyLink')}
        </Button>
      </div>
      <p className="app-muted">
        {t('members.linkExpires', { time: calendarDay(link.expires_at, { locale, timeZone: me.timezone }) })}
      </p>
      <OverlayActions>
        <Button kind="primary" onClick={onClose}>
          {t('common.done')}
        </Button>
      </OverlayActions>
    </Overlay>
  );
}

function InviteDrawer({ onClose, onLink }: { onClose: () => void; onLink: (link: IssuedLink, email: string) => void }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const dismiss = useOverlayDraft({ email, name, role }, saving, onClose);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const result = await api.admin.invite({ email: email.trim(), name: name.trim(), role });
      await client.invalidateQueries({ queryKey: MEMBERS });
      onClose();
      onLink(result.link, result.member.email);
    } catch (caught) {
      setError(
        caught instanceof ApiClientError && caught.code === 'email_taken'
          ? t('members.emailTaken')
          : caught instanceof ApiClientError
            ? caught.message
            : t('common.error'),
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <Overlay variant="dialog" title={t('members.invite')} onClose={onClose} beforeClose={dismiss.beforeClose}>
        <form {...dismiss.formProps} id="invite" className="app-form" onSubmit={(event) => void submit(event)}>
          <Field label={t('login.email')} required error={error || undefined}>
            <Input type="email" value={email} autoFocus onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <Field label={t('activate.name')} required>
            <Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
          </Field>
          <FieldGroup label={t('members.role')}>
            <Select
              label={t('members.role')}
              value={role}
              options={[
                { value: 'member', label: t('members.roleMember') },
                { value: 'admin', label: t('members.roleAdmin') },
              ]}
              onChange={(value) => setRole(value as 'member' | 'admin')}
            />
          </FieldGroup>
        </form>
        <OverlayActions>
          <Button onClick={dismiss.close}>{t('common.cancel')}</Button>
          <Button kind="primary" type="submit" form="invite" loading={saving} disabled={!email.trim() || !name.trim()}>
            {t('members.sendInvite')}
          </Button>
        </OverlayActions>
      </Overlay>
      {dismiss.confirmation}
    </>
  );
}

function MemberDrawer({ member, onClose }: { member: MemberAdmin; onClose: () => void }) {
  const { t } = useI18n();
  const notify = useNotify();
  const client = useQueryClient();
  const save = (input: Parameters<typeof api.admin.updateMember>[1]) =>
    api.admin
      .updateMember(member.id, input)
      .then(() => client.invalidateQueries({ queryKey: MEMBERS }))
      .catch((error: unknown) => notify(errorText(error, t)));
  return (
    <Overlay title={member.name} onClose={onClose}>
      <section className="app-section">
        <FieldGroup label={t('members.role')}>
          <Select
            label={t('members.role')}
            value={member.role}
            options={[
              { value: 'member', label: t('members.roleMember') },
              { value: 'admin', label: t('members.roleAdmin') },
            ]}
            onChange={(role) => void save({ role: role as 'member' | 'admin' })}
          />
        </FieldGroup>
      </section>
      <section className="app-section">
        <h3 className="app-section-title">{t('members.modules')}</h3>
        <div className="app-settings-group">
          {MEMBER_MODULES.map((module) => (
            <div key={module} className="app-setting-row">
              <span className="app-setting-text">
                <strong>{t(MODULE_LABEL[module])}</strong>
              </span>
              <Switch
                label={t(MODULE_LABEL[module])}
                checked={member.modules[module]}
                onChange={(on) => void save({ modules: { [module]: on } })}
              />
            </div>
          ))}
        </div>
      </section>
    </Overlay>
  );
}

function Members() {
  const { t, locale } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const client = useQueryClient();
  const members = useInfiniteQuery({
    queryKey: MEMBERS,
    queryFn: ({ pageParam }) => api.admin.members({ cursor: pageParam, limit: 100 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<{ link: IssuedLink; email: string } | null>(null);
  const [editing, setEditing] = useState<MemberAdmin | null>(null);
  const [disabling, setDisabling] = useState<MemberAdmin | null>(null);
  const items = members.data?.pages.flatMap((page) => page.items) ?? [];
  const failed = (error: unknown) => notify(errorText(error, t));
  const setStatus = (member: MemberAdmin, status: 'active' | 'disabled') =>
    api.admin
      .updateMember(member.id, { status })
      .then(() => client.invalidateQueries({ queryKey: MEMBERS }))
      .catch(failed);

  return (
    <section className="app-section">
      <div className="app-section-heading">
        <h2 className="app-section-title">{t('members.count', { count: items.length })}</h2>
        <Button kind="primary" onClick={() => setInviting(true)}>
          <Plus size={icon.md} />
          {t('members.invite')}
        </Button>
      </div>
      {members.isPending ? (
        <Skeleton lines={5} />
      ) : members.isError ? (
        <ErrorBox onRetry={() => void members.refetch()}>{errorText(members.error, t)}</ErrorBox>
      ) : (
        <ul className="app-list">
          {items.map((member) => {
            const status = STATUS[member.status];
            return (
              <li key={member.id} className="app-list-row is-static">
                <MemberAvatar name={member.name} url={member.avatar_url} size={28} />
                <button type="button" className="app-list-main app-link-button" onClick={() => setEditing(member)}>
                  <span className="app-list-title">
                    {member.name}
                    {member.role === 'admin' ? ` · ${t('members.roleAdmin')}` : ''}
                  </span>
                  <span className="app-list-meta">
                    {member.email}
                    {member.last_login_at
                      ? ` · ${t('members.lastLogin', { time: relativeTime(member.last_login_at, { locale, timeZone: me.timezone }) })}`
                      : ''}
                  </span>
                </button>
                <StatusBadge status={t(status.word)} tone={status.tone} />
                <Menu
                  label={t('row.actionsFor', { name: member.name })}
                  items={[
                    { label: t('members.edit'), onClick: () => setEditing(member) },
                    ...(member.status !== 'disabled'
                      ? [
                          {
                            label: member.status === 'invited' ? t('members.newInvite') : t('members.resetLink'),
                            onClick: () =>
                              void api.admin
                                .memberLink(member.id)
                                .then((issued) => setLink({ link: issued, email: member.email }))
                                .catch(failed),
                          },
                        ]
                      : []),
                    '-',
                    member.status === 'disabled'
                      ? { label: t('members.enable'), onClick: () => void setStatus(member, 'active') }
                      : {
                          label: t('members.disable'),
                          danger: true,
                          disabled: member.id === me.id,
                          onClick: () => setDisabling(member),
                        },
                  ]}
                />
              </li>
            );
          })}
        </ul>
      )}
      {inviting && (
        <InviteDrawer onClose={() => setInviting(false)} onLink={(issued, email) => setLink({ link: issued, email })} />
      )}
      {link && <LinkDialog link={link.link} email={link.email} onClose={() => setLink(null)} />}
      {editing && (
        <MemberDrawer
          member={items.find((item) => item.id === editing.id) ?? editing}
          onClose={() => setEditing(null)}
        />
      )}
      {disabling && (
        <ConfirmDialog
          danger
          title={t('members.disableTitle', { name: disabling.name })}
          confirmLabel={t('members.disable')}
          onCancel={() => setDisabling(null)}
          onConfirm={() => {
            void setStatus(disabling, 'disabled');
            setDisabling(null);
          }}
        >
          {t('members.disableBody')}
        </ConfirmDialog>
      )}
    </section>
  );
}

function GroupDrawer({ group, onClose }: { group: Group | null; onClose: () => void }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const directory = useQuery({ queryKey: ['members', 'directory'], queryFn: () => api.members.directory() });
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [people, setPeople] = useState<string[]>(group?.member_ids ?? []);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const dismiss = useOverlayDraft({ name, description, people }, saving, onClose);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const input = { name: name.trim(), description, member_ids: people };
      if (group) await api.admin.saveGroup(group.id, input);
      else await api.admin.createGroup(input);
      await client.invalidateQueries({ queryKey: GROUPS });
      onClose();
    } catch (caught) {
      setError(errorText(caught, t));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <Overlay title={group ? group.name : t('groups.new')} onClose={onClose} beforeClose={dismiss.beforeClose}>
        <form {...dismiss.formProps} id="group" className="app-form" onSubmit={(event) => void submit(event)}>
          <Field label={t('groups.name')} required error={error || undefined}>
            <Input value={name} maxLength={60} autoFocus onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label={t('groups.description')}>
            <TextArea
              value={description}
              maxLength={500}
              maxRows={4}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <FieldGroup label={t('groups.people')}>
            <MultiSelect
              label={t('groups.people')}
              value={people}
              max={4}
              options={(directory.data?.items ?? []).map((member) => ({
                value: member.id,
                label: member.name,
                description: member.email,
              }))}
              onChange={setPeople}
            />
          </FieldGroup>
        </form>
        <OverlayActions>
          <Button onClick={dismiss.close}>{t('common.cancel')}</Button>
          <Button kind="primary" type="submit" form="group" loading={saving} disabled={!name.trim()}>
            {t('common.save')}
          </Button>
        </OverlayActions>
      </Overlay>
      {dismiss.confirmation}
    </>
  );
}

function Groups() {
  const { t } = useI18n();
  const notify = useNotify();
  const client = useQueryClient();
  const groups = useQuery({ queryKey: GROUPS, queryFn: () => api.admin.groups() });
  const [editing, setEditing] = useState<Group | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Group | null>(null);
  const items = groups.data?.items ?? [];
  return (
    <section className="app-section">
      <div className="app-section-heading">
        <h2 className="app-section-title">{t('groups.count', { count: items.length })}</h2>
        <Button onClick={() => setEditing('new')}>
          <Plus size={icon.md} />
          {t('groups.new')}
        </Button>
      </div>
      {groups.isPending ? (
        <Skeleton lines={3} />
      ) : !items.length ? (
        <Empty title={t('groups.none')} />
      ) : (
        <ul className="app-list">
          {items.map((group) => (
            <li key={group.id} className="app-list-row is-static">
              <button type="button" className="app-list-main app-link-button" onClick={() => setEditing(group)}>
                <span className="app-list-title">{group.name}</span>
                <span className="app-list-meta">
                  {t('chat.people', { count: group.member_ids.length })}
                  {group.description ? ` · ${group.description}` : ''}
                </span>
              </button>
              <Menu
                label={t('row.actionsFor', { name: group.name })}
                items={[
                  { label: t('members.edit'), onClick: () => setEditing(group) },
                  '-',
                  { label: t('row.delete'), danger: true, onClick: () => setDeleting(group) },
                ]}
              />
            </li>
          ))}
        </ul>
      )}
      {editing && <GroupDrawer group={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog
          danger
          title={t('groups.deleteTitle', { name: deleting.name })}
          confirmLabel={t('row.delete')}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const target = deleting;
            setDeleting(null);
            void api.admin
              .removeGroup(target.id)
              .then(() => client.invalidateQueries({ queryKey: GROUPS }))
              .catch((error: unknown) => notify(errorText(error, t)));
          }}
        >
          {t('groups.deleteBody')}
        </ConfirmDialog>
      )}
    </section>
  );
}

export function MembersSection() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'members' | 'groups'>('members');
  const labels = { members: t('members.tab'), groups: t('groups.tab') };
  return (
    <>
      <Tabs
        label={t('admin.members')}
        items={[labels.members, labels.groups]}
        value={labels[tab]}
        onChange={(label) => setTab(label === labels.groups ? 'groups' : 'members')}
      />
      {tab === 'members' ? <Members /> : <Groups />}
    </>
  );
}
