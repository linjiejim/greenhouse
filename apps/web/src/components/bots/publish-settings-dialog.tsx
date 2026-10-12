/**
 * Publishing settings of one of the member's Agents (spec 20261011-agent-first-class P4, D33–D37):
 * public or private, who may use it (everyone, or chosen members and groups), what it may use
 * (knowledge folders the owner can read — never another Agent's reference folder — and its own
 * computer, one per person) and its own budget. A centered Dialog opened from the profile drawer's
 * Publish tab (the drawer stays read-only context). Saving is one `PUT /api/bots/:id/publication`;
 * the first time an Agent goes public it publishes the current version with it.
 *
 * The pickers load the shareable members, the groups and both kb folder trees; a list that failed to
 * load is not written back (an unchanged setting is never wiped by a failed read), and a selected id
 * the lists no longer carry stays listed — checked — so the owner can let it go.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  PUBLIC_AGENT_DEFAULT_MONTHLY_TOKENS,
  type BotPublicationView,
  type BotPublicationWrite,
  type BotView,
} from '@greenhouse/types/bots';
import type { ShareableUser, UserGroup } from '@greenhouse/types/api';
import { Button, Checkbox, Dialog, Input, SearchInput, Spinner, Toggle, toast } from '../ui';
import { FormActions, FormError, FormField, FormGrid, FormSection } from '../form';
import { useT } from '../../lib/i18n';
import { formatTokens } from '../../lib/utils';
import { useAuthStore } from '../../stores';
import { fetchShareableUsers } from '../../lib/api/sessions';
import { listGroups } from '../../lib/api/groups';
import { listDriveFolders, type DriveFolder } from '../../lib/api/drive';
import { isBotsApiError, updateBotPublication } from '../../lib/api/bots';

const MAX_TOKENS = 1_000_000_000;

/** A grantable kb folder with its path, e.g. `Sales / Playbooks`. */
export interface GrantableFolder {
  id: number;
  path: string;
  visibility: 'team' | 'private';
}

/**
 * The folders an owner can grant, with their paths: every team folder and their own personal ones,
 * minus any Agent's reference folder and everything under it (`bot_id` on its root).
 */
export function grantableFolders(team: readonly DriveFolder[], personal: readonly DriveFolder[]): GrantableFolder[] {
  const out: GrantableFolder[] = [];
  for (const [folders, visibility] of [
    [team, 'team'],
    [personal, 'private'],
  ] as const) {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    for (const folder of folders) {
      const names: string[] = [];
      let node: DriveFolder | undefined = folder;
      let agentFolder = false;
      const seen = new Set<number>();
      while (node && !seen.has(node.id)) {
        seen.add(node.id);
        if (node.bot_id) agentFolder = true;
        names.unshift(node.name);
        node = node.parent_id === null ? undefined : byId.get(node.parent_id);
      }
      if (!agentFolder) out.push({ id: folder.id, path: names.join(' / '), visibility });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** A token field's value: empty = null (the default / no limit), else a whole number in range. */
export function parseTokens(raw: string): number | null | 'invalid' {
  const text = raw.trim().replace(/[,\s_]/g, '');
  if (!text) return null;
  if (!/^\d+$/.test(text)) return 'invalid';
  const value = Number(text);
  return value >= 1 && value <= MAX_TOKENS ? value : 'invalid';
}

type Lists = {
  users: ShareableUser[] | null;
  groups: UserGroup[] | null;
  folders: GrantableFolder[] | null;
};

export function PublishSettingsDialog({
  bot,
  view,
  startPublic = false,
  onClose,
  onSaved,
}: {
  bot: BotView;
  view: BotPublicationView;
  /** Opened from "Publish…": the switch starts on Public. */
  startPublic?: boolean;
  onClose: () => void;
  onSaved: (next: BotPublicationView) => void;
}) {
  const t = useT();
  const me = useAuthStore((state) => state.currentUser?.id ?? null);
  const [isPublic, setPublic] = useState(startPublic || view.visibility === 'public');
  const [everyone, setEveryone] = useState(view.audience.everyone);
  const [userIds, setUserIds] = useState(() => new Set(view.audience.user_ids));
  const [groupIds, setGroupIds] = useState(() => new Set(view.audience.group_ids));
  const [folderIds, setFolderIds] = useState(() => new Set(view.grants.kb_folder_ids));
  const [computer, setComputer] = useState(view.grants.computer);
  const [monthly, setMonthly] = useState(view.budget.monthly_tokens?.toString() ?? '');
  const [daily, setDaily] = useState(view.budget.daily_tokens_per_user?.toString() ?? '');
  const neverPublished = view.published_version === null;
  const [publishNow, setPublishNow] = useState(neverPublished);
  const [query, setQuery] = useState('');
  const [lists, setLists] = useState<Lists>({ users: null, groups: null, folders: null });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      fetchShareableUsers(),
      listGroups(),
      listDriveFolders({ scope: 'kb', visibility: 'team' }, 'all'),
      listDriveFolders({ scope: 'kb', visibility: 'private' }, 'all'),
    ]).then(([users, groups, team, personal]) => {
      if (cancelled) return;
      setLists({
        users: users.status === 'fulfilled' ? users.value.filter((user) => user.id !== me) : null,
        groups: groups.status === 'fulfilled' ? groups.value : null,
        folders:
          team.status === 'fulfilled' && personal.status === 'fulfilled'
            ? grantableFolders(team.value, personal.value)
            : null,
      });
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [me]);

  const toggle = <T,>(set: Set<T>, id: T): Set<T> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  // Loaded members plus any selected one the list no longer has (deactivated…), so it can be dropped.
  const memberRows = useMemo(() => {
    const loaded = lists.users ?? [];
    const known = new Set(loaded.map((user) => user.id));
    const missing = [...userIds].filter((id) => !known.has(id)).map((id) => ({ id, nickname: id, email: '' }));
    const needle = query.trim().toLocaleLowerCase();
    return [...loaded, ...missing].filter(
      (user) =>
        !needle ||
        user.nickname.toLocaleLowerCase().includes(needle) ||
        user.email.toLocaleLowerCase().includes(needle),
    );
  }, [lists.users, query, userIds]);

  const folderRows = useMemo(() => {
    const loaded = lists.folders ?? [];
    const known = new Set(loaded.map((folder) => folder.id));
    const missing = [...folderIds]
      .filter((id) => !known.has(id))
      .map((id) => ({ id, path: `#${id}`, visibility: 'private' as const }));
    return [...loaded, ...missing];
  }, [folderIds, lists.folders]);

  const save = async () => {
    setError(null);
    const monthlyTokens = parseTokens(monthly);
    const dailyTokens = parseTokens(daily);
    if (monthlyTokens === 'invalid' || dailyTokens === 'invalid') {
      setError(t('bots.publish.invalidNumber'));
      return;
    }
    if (isPublic && !everyone && userIds.size === 0 && groupIds.size === 0) {
      setError(t('bots.publish.needsAudience'));
      return;
    }
    const write: BotPublicationWrite = {
      visibility: isPublic ? 'public' : 'private',
      audience: { everyone, user_ids: [...userIds], group_ids: [...groupIds] },
      grants: {
        computer,
        // A folder list that failed to load is left as it is.
        ...(lists.folders ? { kb_folder_ids: [...folderIds] } : {}),
      },
      budget: { monthly_tokens: monthlyTokens, daily_tokens_per_user: dailyTokens },
      ...(isPublic && (neverPublished || publishNow) ? { publish: true } : {}),
    };
    setSaving(true);
    try {
      const next = await updateBotPublication(bot.id, write);
      toast(
        write.publish
          ? t('bots.publish.published', { version: next.published_version ?? bot.current_version })
          : t('bots.publish.saved'),
        'success',
      );
      onSaved(next);
    } catch (err) {
      setError(
        isBotsApiError(err, 'bot_protected')
          ? t('bots.publish.protected')
          : t('bots.publish.saveFailed', { reason: err instanceof Error ? err.message : String(err) }),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={t('bots.publish.dialogTitle', { name: bot.name })} size="lg">
      <div className="space-y-4" data-testid="bots-publish-dialog">
        <div className="flex items-start gap-3">
          <Toggle
            checked={isPublic}
            onChange={setPublic}
            label={t('bots.publish.visibility')}
            className="mt-0.5 flex-shrink-0"
          />
          <div className="min-w-0">
            <p className="text-sm font-medium text-fg">{t('bots.publish.visibility')}</p>
            <p className="text-[11px] leading-4 text-fg-faint">{t('bots.publish.visibilityHint')}</p>
          </div>
        </div>

        <FormSection title={t('bots.publish.audience')}>
          <Checkbox
            checked={everyone}
            onChange={(event) => setEveryone(event.target.checked)}
            label={t('bots.publish.everyone')}
            data-testid="bots-publish-everyone"
          />
          {!everyone &&
            (loading ? (
              <Spinner className="mt-3 h-4 w-4 text-fg-faint" />
            ) : (
              <FormGrid className="mt-3">
                <div>
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="text-xs font-medium text-fg-secondary">{t('bots.publish.members')}</span>
                    {userIds.size > 0 && (
                      <span className="text-[11px] text-fg-faint">
                        {t('bots.publish.selected', { count: userIds.size })}
                      </span>
                    )}
                  </div>
                  <SearchInput
                    value={query}
                    onChange={setQuery}
                    placeholder={t('bots.publish.searchMembers')}
                    aria-label={t('bots.publish.searchMembers')}
                  />
                  <ul className="mt-1.5 max-h-48 space-y-1 overflow-y-auto" data-testid="bots-publish-members">
                    {memberRows.length === 0 ? (
                      <li className="text-xs text-fg-faint">{t('bots.publish.noMembers')}</li>
                    ) : (
                      memberRows.map((user) => (
                        <li key={user.id}>
                          <Checkbox
                            checked={userIds.has(user.id)}
                            onChange={() => setUserIds((current) => toggle(current, user.id))}
                            label={
                              <span className="min-w-0 truncate text-xs" title={user.email || user.nickname}>
                                {user.nickname || user.email}
                              </span>
                            }
                          />
                        </li>
                      ))
                    )}
                  </ul>
                </div>
                <div>
                  <div className="mb-1.5 text-xs font-medium text-fg-secondary">{t('bots.publish.groups')}</div>
                  <ul className="max-h-56 space-y-1 overflow-y-auto" data-testid="bots-publish-groups">
                    {(lists.groups ?? []).length === 0 ? (
                      <li className="text-xs text-fg-faint">{t('bots.publish.noGroups')}</li>
                    ) : (
                      (lists.groups ?? []).map((group) => (
                        <li key={group.id}>
                          <Checkbox
                            checked={groupIds.has(group.id)}
                            onChange={() => setGroupIds((current) => toggle(current, group.id))}
                            label={
                              <span className="min-w-0 truncate text-xs" title={group.name}>
                                {group.name}
                              </span>
                            }
                          />
                        </li>
                      ))
                    )}
                  </ul>
                </div>
              </FormGrid>
            ))}
        </FormSection>

        <FormSection title={t('bots.publish.grants')}>
          <div className="mb-1.5 text-xs font-medium text-fg-secondary">{t('bots.publish.folders')}</div>
          <p className="mb-1.5 text-[11px] leading-4 text-fg-faint">{t('bots.publish.foldersHint')}</p>
          {loading ? (
            <Spinner className="h-4 w-4 text-fg-faint" />
          ) : folderRows.length === 0 ? (
            <p className="text-xs text-fg-faint">{t('bots.publish.noFolders')}</p>
          ) : (
            <ul className="max-h-48 space-y-1 overflow-y-auto" data-testid="bots-publish-folders">
              {folderRows.map((folder) => (
                <li key={folder.id}>
                  <Checkbox
                    checked={folderIds.has(folder.id)}
                    onChange={() => setFolderIds((current) => toggle(current, folder.id))}
                    label={
                      <span className="flex min-w-0 items-center gap-1.5 text-xs">
                        <span className="flex-shrink-0 text-[10px] text-fg-faint">
                          {folder.visibility === 'team'
                            ? t('bots.publish.foldersTeam')
                            : t('bots.publish.foldersPersonal')}
                        </span>
                        <span className="min-w-0 truncate" title={folder.path}>
                          {folder.path}
                        </span>
                      </span>
                    }
                  />
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex items-start gap-3">
            <Toggle
              checked={computer}
              onChange={setComputer}
              size="sm"
              label={t('bots.publish.computer')}
              className="mt-0.5 flex-shrink-0"
            />
            <div className="min-w-0">
              <p className="text-xs font-medium text-fg-secondary">{t('bots.publish.computer')}</p>
              <p className="text-[11px] leading-4 text-fg-faint">{t('bots.publish.computerHint')}</p>
            </div>
          </div>
        </FormSection>

        <FormSection title={t('bots.publish.budget')}>
          <FormGrid>
            <FormField
              label={t('bots.publish.monthly')}
              help={t('bots.publish.monthlyHint', { tokens: formatTokens(PUBLIC_AGENT_DEFAULT_MONTHLY_TOKENS) })}
            >
              <Input
                size="sm"
                inputMode="numeric"
                value={monthly}
                onChange={(event) => setMonthly(event.target.value)}
                placeholder={PUBLIC_AGENT_DEFAULT_MONTHLY_TOKENS.toLocaleString()}
                data-testid="bots-publish-monthly"
              />
            </FormField>
            <FormField label={t('bots.publish.daily')} help={t('bots.publish.dailyHint')}>
              <Input
                size="sm"
                inputMode="numeric"
                value={daily}
                onChange={(event) => setDaily(event.target.value)}
                placeholder={t('bots.publish.dailyPlaceholder')}
                data-testid="bots-publish-daily"
              />
            </FormField>
          </FormGrid>
        </FormSection>

        {isPublic &&
          (neverPublished ? (
            <p className="text-xs text-fg-muted">{t('bots.publish.firstPublish', { version: view.current_version })}</p>
          ) : (
            view.published_version !== view.current_version && (
              <Checkbox
                checked={publishNow}
                onChange={(event) => setPublishNow(event.target.checked)}
                label={t('bots.publish.publishNow', { version: view.current_version })}
              />
            )
          ))}

        <FormError>{error}</FormError>
        <FormActions>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={saving} onClick={() => void save()} data-testid="bots-publish-save">
            {saving ? t('bots.form.saving') : t('bots.form.save')}
          </Button>
        </FormActions>
      </div>
    </Dialog>
  );
}
