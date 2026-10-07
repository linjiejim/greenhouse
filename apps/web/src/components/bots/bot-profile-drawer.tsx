/**
 * Bot profile — a read-only drawer (who it is, how it works, what it alone
 * remembers, its files and versions) with the edit form in a centered Dialog,
 * per the Drawer/Dialog convention. Private memories are listed in full and
 * each can be forgotten: nothing a Bot keeps about the member is out of the
 * member's sight. Every save appends an immutable version (spec 20261007 §2.1).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { isSproutyBot, type BotVersionView, type BotView } from '@greenhouse/types/bots';
import { Button, ConfirmDialog, Dialog, Drawer, IconButton, Spinner, toast } from '../ui';
import { FormActions } from '../form';
import { Archive, FolderOpen, MessageCircle, MessageSquare, Pencil, Trash2, X } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { formatDay } from '../../lib/utils';
import { useAuthStore, useProfileStore } from '../../stores';
import * as botsApi from '../../lib/api/bots';
import type { BotMemoryView } from '../../lib/api/bots';
import { useBotsStore } from './bots-store';
import { BotAvatar } from './bot-avatar';
import { BotFields, useBotNameMessage, type BotDraft } from './bot-form';
import { botNameIssueFromCode, validateBotName } from './bot-name';
import { PanelSection } from './bots-side-panel';
import { openChatWith } from './navigation';

export function BotProfileDrawer({ onOpenDm }: { onOpenDm: (bot: BotView) => void }) {
  const t = useT();
  const botId = useBotsStore((state) => state.profileBotId);
  const openProfile = useBotsStore((state) => state.openProfile);
  const profileEdit = useBotsStore((state) => state.profileEdit);
  const bot = useBotsStore((state) => state.bots.find((candidate) => candidate.id === state.profileBotId));
  const markArchived = useBotsStore((state) => state.markArchived);
  const loadConversations = useBotsStore((state) => state.loadConversations);
  const models = useProfileStore((state) => state.models);
  const fetchProfiles = useProfileStore((state) => state.fetchProfiles);
  const refreshProfiles = useProfileStore((state) => state.refresh);
  const [memories, setMemories] = useState<BotMemoryView[] | null>(null);
  const [memoriesError, setMemoriesError] = useState(false);
  const [versions, setVersions] = useState<BotVersionView[] | null>(null);
  const [files, setFiles] = useState<{ folder: botsApi.BotFolderView | null; docs: botsApi.BotFileView[] } | null>(
    null,
  );
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);

  useEffect(() => {
    if (botId && profileEdit) setEditing(true);
  }, [botId, profileEdit]);

  useEffect(() => {
    void fetchProfiles();
  }, [fetchProfiles]);

  const loadMemories = useCallback(async (id: string) => {
    setMemories(null);
    setMemoriesError(false);
    try {
      const { memories: rows } = await botsApi.listBotMemories(id);
      setMemories(rows.filter((row) => row.status === 'active' || row.status === 'dormant'));
    } catch {
      setMemoriesError(true);
      setMemories([]);
    }
  }, []);

  const loadVersions = useCallback(async (id: string) => {
    setVersions(null);
    try {
      const { versions: rows } = await botsApi.listBotVersions(id);
      setVersions(rows);
    } catch {
      setVersions([]);
    }
  }, []);

  const loadFiles = useCallback(async (id: string) => {
    setFiles(null);
    try {
      setFiles(await botsApi.listBotFiles(id));
    } catch {
      setFiles({ folder: null, docs: [] });
    }
  }, []);

  useEffect(() => {
    if (botId) {
      void loadMemories(botId);
      void loadVersions(botId);
      void loadFiles(botId);
    }
  }, [botId, loadFiles, loadMemories, loadVersions]);

  const openFolder = async () => {
    if (!bot) return;
    try {
      const folder = files?.folder ?? (await botsApi.ensureBotFolder(bot.id)).folder;
      window.location.hash = folder.url;
      close();
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : t('bots.loadFailed'), 'error');
    }
  };

  // A save appends a version: refresh the history the drawer shows.
  useEffect(() => {
    if (bot?.id && versions && versions[0]?.version !== bot.current_version) void loadVersions(bot.id);
  }, [bot?.id, bot?.current_version, loadVersions, versions]);

  const close = () => openProfile(null);

  const forget = async (memory: BotMemoryView) => {
    if (!bot) return;
    setMemories((current) => current?.filter((row) => row.id !== memory.id) ?? null);
    try {
      await botsApi.deleteBotMemory(bot.id, memory.id);
      toast(t('bots.profile.forgotten'), 'success');
    } catch {
      toast(t('bots.profile.forgetFailed'), 'error');
      void loadMemories(bot.id);
    }
  };

  const archive = async () => {
    if (!bot) return;
    setArchiving(false);
    try {
      await botsApi.archiveBot(bot.id);
      markArchived(bot.id);
      close();
      void loadConversations().catch(() => {});
      void refreshProfiles();
      toast(t('bots.profile.archived', { name: bot.name }), 'success');
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : t('bots.profile.archiveFailed'), 'error');
    }
  };

  const modelName = bot?.model_id ? (models.find((model) => model.id === bot.model_id)?.id ?? bot.model_id) : null;
  return (
    <>
      <Drawer open={!!bot} onClose={close} side="right" width={400} ariaLabel={t('bots.profile.title')}>
        {bot && (
          <div className="flex min-h-0 flex-1 flex-col" data-testid="bots-profile-drawer">
            <div className="flex items-start gap-3 border-b border-edge px-4 py-4">
              <BotAvatar bot={bot} size="lg" />
              <div className="min-w-0 flex-1 pt-1">
                <h2 className="truncate text-base font-semibold text-fg" title={bot.name}>
                  {bot.name}
                </h2>
                {bot.role && <p className="truncate text-xs text-fg-muted">{bot.role}</p>}
                <p className="mt-1 text-[10px] text-fg-faint">
                  {t('bots.profile.created', { date: formatDay(bot.created_at) })} · v{bot.current_version}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button size="sm" onClick={() => openChatWith(bot.id)} data-testid="bots-profile-chat">
                    <MessageSquare size={13} className="mr-1" />
                    {t('bots.profile.chat')}
                  </Button>
                  {bot.dm_session_id !== null && (
                    <Button size="sm" variant="outline" onClick={() => onOpenDm(bot)}>
                      <MessageCircle size={13} className="mr-1" />
                      {t('bots.profile.message')}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                    <Pencil size={13} className="mr-1" />
                    {t('bots.profile.edit')}
                  </Button>
                </div>
              </div>
              <IconButton label={t('common.close')} onClick={close} size="compact">
                <X size={16} />
              </IconButton>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {bot.description && (
                <PanelSection title={t('bots.profile.description')}>
                  <p className="text-xs leading-5 text-fg-secondary">{bot.description}</p>
                </PanelSection>
              )}
              <PanelSection title={t('bots.profile.instructions')}>
                <p className="whitespace-pre-wrap text-xs leading-5 text-fg-secondary">
                  {bot.instructions || t('bots.profile.instructionsEmpty')}
                </p>
              </PanelSection>
              <PanelSection title={t('bots.profile.model')}>
                <p className="text-xs text-fg-secondary">{modelName ?? t('bots.profile.modelDefault')}</p>
              </PanelSection>
              <PanelSection title={t('bots.profile.tools')}>
                <p className="text-xs text-fg-secondary" data-testid="bots-profile-tools">
                  {bot.tools === null
                    ? t('bots.profile.toolsInherited')
                    : bot.tools.length === 0
                      ? t('bots.profile.toolsNone')
                      : bot.tools.join(', ')}
                </p>
                {bot.max_steps !== null && (
                  <p className="mt-1 text-[11px] text-fg-faint">
                    {t('bots.profile.maxSteps', { count: bot.max_steps })}
                  </p>
                )}
              </PanelSection>
              <PanelSection title={t('bots.profile.files')} hint={t('bots.profile.filesHint', { name: bot.name })}>
                {files === null ? (
                  <Spinner className="h-4 w-4 text-fg-faint" />
                ) : (
                  <div className="space-y-2" data-testid="bots-profile-files">
                    {files.docs.length === 0 ? (
                      <p className="text-xs text-fg-faint">{t('bots.profile.filesEmpty')}</p>
                    ) : (
                      <ul className="space-y-1">
                        {files.docs.map((doc) => (
                          <li key={doc.id}>
                            <a href={doc.url} className="text-xs text-primary-fg hover:underline" title={doc.title}>
                              {doc.title}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void openFolder()}
                      data-testid="bots-profile-open-folder"
                    >
                      <FolderOpen size={13} className="mr-1" />
                      {t('bots.profile.openFolder')}
                    </Button>
                  </div>
                )}
              </PanelSection>
              <PanelSection title={t('bots.profile.versions')}>
                {versions === null ? (
                  <Spinner className="h-4 w-4 text-fg-faint" />
                ) : versions.length === 0 ? (
                  <p className="text-xs text-fg-faint">{t('bots.profile.versionsEmpty')}</p>
                ) : (
                  <ul className="space-y-1" data-testid="bots-profile-versions">
                    {versions.slice(0, 10).map((version) => (
                      <li key={version.version} className="flex items-baseline gap-2 text-xs">
                        <span className="w-8 flex-shrink-0 font-medium text-fg">v{version.version}</span>
                        <span className="min-w-0 flex-1 truncate text-fg-muted" title={version.change_log}>
                          {version.change_log}
                        </span>
                        <span className="flex-shrink-0 text-[10px] text-fg-faint">{formatDay(version.created_at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </PanelSection>
              <PanelSection
                title={t('bots.profile.memories')}
                hint={t('bots.profile.memoriesHint', { name: bot.name })}
              >
                {memories === null ? (
                  <Spinner className="h-4 w-4 text-fg-faint" />
                ) : memoriesError ? (
                  <p className="text-xs text-danger">{t('bots.profile.memoriesFailed')}</p>
                ) : memories.length === 0 ? (
                  <p className="text-xs text-fg-faint">{t('bots.profile.memoriesEmpty')}</p>
                ) : (
                  <ul className="space-y-1">
                    {memories.map((memory) => (
                      <li
                        key={memory.id}
                        className="group flex items-start gap-2 rounded-md px-1 py-1 hover:bg-surface-muted"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium text-fg">{memory.title}</p>
                          <p className="whitespace-pre-wrap text-[11px] text-fg-muted">{memory.content}</p>
                        </div>
                        <IconButton
                          size="compact"
                          variant="destructive"
                          label={t('bots.profile.forget')}
                          onClick={() => void forget(memory)}
                          wrapperClassName="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 touch-visible"
                        >
                          <Trash2 size={13} />
                        </IconButton>
                      </li>
                    ))}
                  </ul>
                )}
              </PanelSection>
              <div className="px-4 py-4">
                {isSproutyBot(bot) ? (
                  // Every member's main Bot stays; it can still be renamed or re-instructed.
                  <p className="text-[11px] text-fg-faint" data-testid="bots-profile-main-bot">
                    {t('bots.profile.mainBot', { name: bot.name })}
                  </p>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setArchiving(true)}>
                    <Archive size={13} className="mr-1" />
                    {t('bots.profile.archive')}
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </Drawer>
      {bot && editing && <EditBotDialog bot={bot} models={models} onClose={() => setEditing(false)} />}
      <ConfirmDialog
        open={archiving}
        onClose={() => setArchiving(false)}
        onConfirm={() => void archive()}
        title={t('bots.profile.archiveConfirm', { name: bot?.name ?? '' })}
        description={t('bots.profile.archiveDescription')}
        confirmLabel={t('bots.profile.archive')}
        confirmVariant="destructive"
      />
    </>
  );
}

function EditBotDialog({
  bot,
  models,
  onClose,
}: {
  bot: BotView;
  models: Array<{ id: string; name: string }>;
  onClose: () => void;
}) {
  const t = useT();
  const nickname = useAuthStore((state) => state.currentUser?.nickname ?? null);
  const bots = useBotsStore((state) => state.bots);
  const upsertBot = useBotsStore((state) => state.upsertBot);
  const refreshProfiles = useProfileStore((state) => state.refresh);
  const nameMessage = useBotNameMessage();
  const [draft, setDraft] = useState<BotDraft>({
    name: bot.name,
    role: bot.role,
    description: bot.description,
    instructions: bot.instructions,
    avatar: bot.avatar,
    model_id: bot.model_id,
    tools: bot.tools,
    max_steps: bot.max_steps,
  });
  const [saving, setSaving] = useState(false);
  const [serverIssue, setServerIssue] = useState<ReturnType<typeof botNameIssueFromCode>>(null);
  const issue = useMemo(
    () =>
      validateBotName(draft.name, {
        otherNames: bots.filter((candidate) => candidate.id !== bot.id).map((candidate) => candidate.name),
        nickname,
      }),
    [bot.id, bots, draft.name, nickname],
  );

  const save = async () => {
    if (issue) return;
    setSaving(true);
    setServerIssue(null);
    try {
      const { bot: saved } = await botsApi.updateBot(bot.id, {
        name: draft.name.trim(),
        role: draft.role.trim(),
        description: draft.description.trim(),
        instructions: draft.instructions.trim(),
        avatar: draft.avatar,
        model_id: draft.model_id,
        tools: draft.tools,
        max_steps: draft.max_steps,
      });
      upsertBot(saved);
      // The Chat picker shows the same identity (name, face, instructions).
      void refreshProfiles();
      toast(t('bots.form.saved'), 'success');
      onClose();
    } catch (err) {
      const code = err instanceof botsApi.BotsApiError ? botNameIssueFromCode(err.code) : null;
      if (code) setServerIssue(code);
      else toast(err instanceof Error && err.message ? err.message : t('bots.form.failed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={t('bots.form.editTitle', { name: bot.name })} size="lg">
      <BotFields
        value={draft}
        onChange={(next) => {
          setDraft(next);
          setServerIssue(null);
        }}
        nameError={nameMessage(issue ?? serverIssue, draft.name)}
        models={models}
        avatarTemplateKey={bot.template_key}
        avatarStableId={bot.id}
      />
      <FormActions className="mt-4">
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button disabled={saving || !!issue} onClick={() => void save()}>
          {saving ? t('bots.form.saving') : t('bots.form.save')}
        </Button>
      </FormActions>
    </Dialog>
  );
}
