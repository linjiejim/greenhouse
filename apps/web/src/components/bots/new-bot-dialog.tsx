/**
 * "New Bot": a template gallery (chief / researcher / operator / writer /
 * analyst / custom / from an Agent), then the same editable form for all of
 * them. A template or Agent only pre-fills — the member can rename, re-role and re-dress
 * before anything is created. Templates that need the computer say so when
 * the organization has none, instead of promising browsing that won't work.
 */

import { useEffect, useMemo, useState } from 'react';
import { TEMPLATE_PLANT, withPlant, type PlantId } from '@greenhouse/types';
import { BOT_TEMPLATES, type BotTemplate, type BotTemplateKey, type BotView } from '@greenhouse/types/bots';
import { Button, Dialog, Tag, toast } from '../ui';
import { FormActions } from '../form';
import { ArrowLeft, Bot, Monitor, Plus } from '../../lib/icons';
import { useI18n } from '../../lib/i18n';
import { useAuthStore, useProfileStore } from '../../stores';
import { botPlant, freshPlant } from '../../lib/plant-avatar';
import * as botsApi from '../../lib/api/bots';
import { computerReady, useBotsStore } from './bots-store';
import { BotAvatar } from './bot-avatar';
import { BotFields, useBotNameMessage, type BotDraft } from './bot-form';
import { botNameIssueFromCode, validateBotName } from './bot-name';
import { AgentPicker, snapshotableAgents } from './agent-picker';
import { botDraftFromAgent } from './agent-snapshot';

/** A blank Bot wears a plant none of the member's Bots has yet. */
export function emptyBotDraft(taken: readonly PlantId[]): BotDraft {
  return { name: '', role: '', instructions: '', avatar: withPlant({}, freshPlant(taken)), model_id: null };
}

/** A template pre-fills its copy and pins its plant (Ivy → ivy …), whatever the stored template avatar says. */
export function templateBotDraft(template: BotTemplate, copyLocale: 'en' | 'zh'): BotDraft {
  const copy = template.copy[copyLocale];
  return {
    name: copy.name,
    role: copy.role,
    instructions: copy.instructions,
    avatar: withPlant(template.avatar, TEMPLATE_PLANT[template.key]),
    model_id: null,
  };
}

export function NewBotDialog({
  open,
  inviteTo,
  onClose,
  onCreated,
}: {
  open: boolean;
  /** Add the new Bot to this conversation (Invite → "Create a new Bot"). */
  inviteTo?: string;
  onClose: () => void;
  /**
   * The Bot exists. `invitedTo` is set when it also joined `inviteTo`;
   * `inviteFailed` when it was created but could not join (the member stays
   * where they were — the toast already said why).
   */
  onCreated: (result: { bot: BotView; dmSessionId: string; invitedTo?: string; inviteFailed?: boolean }) => void;
}) {
  const { t, locale } = useI18n();
  const copyLocale = locale === 'zh' ? 'zh' : 'en';
  const bots = useBotsStore((state) => state.bots);
  const runtime = useBotsStore((state) => state.computerRuntime);
  const upsertBot = useBotsStore((state) => state.upsertBot);
  const nickname = useAuthStore((state) => state.currentUser?.nickname ?? null);
  const models = useProfileStore((state) => state.models);
  const profiles = useProfileStore((state) => state.profiles);
  const fetchProfiles = useProfileStore((state) => state.fetchProfiles);
  const nameMessage = useBotNameMessage();
  const [step, setStep] = useState<'gallery' | 'agents' | 'form'>('gallery');
  const [templateKey, setTemplateKey] = useState<BotTemplateKey | null>(null);
  const takenPlants = useMemo(() => bots.map(botPlant), [bots]);
  const [draft, setDraft] = useState<BotDraft>(() => emptyBotDraft(takenPlants));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverIssue, setServerIssue] = useState<ReturnType<typeof botNameIssueFromCode>>(null);
  const hasComputer = computerReady(runtime);
  const agents = useMemo(() => snapshotableAgents(profiles), [profiles]);

  useEffect(() => {
    if (!open) return;
    setStep('gallery');
    setTemplateKey(null);
    setDraft(emptyBotDraft(takenPlants));
    setTouched(false);
    setServerIssue(null);
    void fetchProfiles();
    // Reset on open only: a Bot list refresh must not re-dress the draft mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchProfiles, open]);

  const issue = useMemo(
    () => validateBotName(draft.name, { otherNames: bots.map((bot) => bot.name), nickname }),
    [bots, draft.name, nickname],
  );

  const choose = (template: BotTemplate | null) => {
    setTemplateKey(template?.key ?? null);
    setDraft(template ? templateBotDraft(template, copyLocale) : emptyBotDraft(takenPlants));
    // A template name the member already uses must show as a conflict right away.
    setTouched(Boolean(template));
    setServerIssue(null);
    setStep('form');
  };

  const chooseAgent = (agent: (typeof agents)[number]) => {
    setTemplateKey(null);
    setDraft(botDraftFromAgent(agent));
    setTouched(true);
    setServerIssue(null);
    setStep('form');
  };

  const create = async () => {
    setTouched(true);
    if (issue) return;
    setSaving(true);
    setServerIssue(null);
    let created: { bot: BotView; dm_session_id: string };
    try {
      created = await botsApi.createBot({
        ...(templateKey ? { template_key: templateKey } : {}),
        name: draft.name.trim(),
        role: draft.role.trim(),
        instructions: draft.instructions.trim(),
        avatar: draft.avatar,
        model_id: draft.model_id,
      });
    } catch (err) {
      const code = botsApi.isBotsApiError(err) ? botNameIssueFromCode(err.code) : null;
      if (code) setServerIssue(code);
      else toast(err instanceof Error && err.message ? err.message : t('bots.form.failed'), 'error');
      setSaving(false);
      return;
    }

    // From here on the Bot exists. Joining the conversation is a separate
    // step: if it fails (the group filled up meanwhile, the conversation is
    // gone), say exactly that — never "create failed", which would invite a
    // second Create that can only hit "name taken".
    const { bot, dm_session_id } = created;
    upsertBot(bot);
    if (!inviteTo) {
      toast(t('bots.form.created', { name: bot.name }), 'success');
      setSaving(false);
      onCreated({ bot, dmSessionId: dm_session_id });
      return;
    }
    try {
      await botsApi.addConversationMember(inviteTo, bot.id);
      toast(t('bots.form.created', { name: bot.name }), 'success');
      onCreated({ bot, dmSessionId: dm_session_id, invitedTo: inviteTo });
    } catch (err) {
      toast(
        t('bots.form.createdNotInvited', {
          name: bot.name,
          reason: err instanceof Error && err.message ? err.message : t('bots.invite.failed'),
        }),
        'warning',
      );
      onCreated({ bot, dmSessionId: dm_session_id, inviteFailed: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('bots.gallery.title')} size="lg">
      {step === 'gallery' ? (
        <div data-testid="bots-template-gallery">
          <p className="mb-3 text-sm text-fg-muted">{t('bots.gallery.subtitle')}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {BOT_TEMPLATES.map((template) => {
              const copy = template.copy[copyLocale];
              const warn = template.needsComputer && !hasComputer;
              return (
                <button
                  key={template.key}
                  type="button"
                  onClick={() => choose(template)}
                  className="flex items-start gap-3 rounded-xl border border-edge bg-surface-card p-3 text-left transition-colors hover:border-primary-edge hover:bg-primary-subtle"
                  data-template={template.key}
                >
                  <BotAvatar avatar={template.avatar} templateKey={template.key} size="md" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold text-fg">{copy.role}</span>
                      <span className="truncate text-xs text-fg-faint">{copy.name}</span>
                    </span>
                    <span className="mt-0.5 block text-xs leading-5 text-fg-muted">{copy.pitch}</span>
                    {warn && (
                      <span className="mt-1.5 block" title={t('bots.gallery.needsComputer')}>
                        <Tag tone="warning" icon={<Monitor size={10} />}>
                          {t('bots.gallery.needsComputerShort')}
                        </Tag>
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => choose(null)}
              className="flex items-start gap-3 rounded-xl border border-dashed border-edge-strong p-3 text-left transition-colors hover:border-primary-edge hover:bg-primary-subtle"
              data-template="custom"
            >
              <span className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-surface-muted text-fg-muted">
                <Plus size={20} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-fg">{t('bots.gallery.custom')}</span>
                <span className="mt-0.5 block text-xs leading-5 text-fg-muted">{t('bots.gallery.customPitch')}</span>
              </span>
            </button>
            {agents.length > 0 && (
              <button
                type="button"
                onClick={() => setStep('agents')}
                className="flex items-start gap-3 rounded-xl border border-dashed border-edge-strong p-3 text-left transition-colors hover:border-primary-edge hover:bg-primary-subtle"
                data-template="agent"
              >
                <span className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-surface-muted text-fg-muted">
                  <Bot size={20} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-fg">{t('bots.gallery.fromAgent')}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-fg-muted">
                    {t('bots.gallery.fromAgentPitch')}
                  </span>
                </span>
              </button>
            )}
          </div>
        </div>
      ) : step === 'agents' ? (
        <div>
          <AgentPicker agents={agents} onPick={chooseAgent} />
          <FormActions className="mt-4">
            <Button variant="ghost" onClick={() => setStep('gallery')}>
              <ArrowLeft size={14} className="mr-1" />
              {t('bots.gallery.back')}
            </Button>
          </FormActions>
        </div>
      ) : (
        <div data-testid="bots-new-bot-form">
          <BotFields
            value={draft}
            onChange={(next) => {
              setDraft(next);
              setTouched(true);
              setServerIssue(null);
            }}
            nameError={touched ? nameMessage(issue ?? serverIssue, draft.name) : nameMessage(serverIssue, draft.name)}
            models={models}
            avatarTemplateKey={templateKey}
          />
          {templateKey &&
            BOT_TEMPLATES.find((template) => template.key === templateKey)?.needsComputer &&
            !hasComputer && <p className="mt-3 text-[11px] text-warning">{t('bots.gallery.needsComputer')}</p>}
          <FormActions
            className="mt-4"
            leading={
              <Button variant="ghost" onClick={() => setStep('gallery')}>
                <ArrowLeft size={14} className="mr-1" />
                {t('bots.gallery.back')}
              </Button>
            }
          >
            <Button
              disabled={saving || (touched && !!issue)}
              onClick={() => void create()}
              data-testid="bots-create-bot"
            >
              {saving ? t('bots.form.creating') : t('bots.form.create')}
            </Button>
          </FormActions>
        </div>
      )}
    </Dialog>
  );
}
