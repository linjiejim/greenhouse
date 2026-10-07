/**
 * The Bot form fields — name, role, instructions, look and (optionally)
 * model. Shared by "New Bot", the profile editor and the in-chat
 * "new Bot" confirmation card, so a Bot proposed by another Bot is edited
 * with exactly the same rules as one the member makes by hand.
 */

import { useEffect } from 'react';
import type { AvatarConfig } from '@greenhouse/types/profile-manifest';
import { BOT_DESCRIPTION_MAX, BOT_INSTRUCTIONS_MAX, BOT_NAME_MAX, BOT_ROLE_MAX } from '@greenhouse/types/bots';
import { FormField, FormGrid, FormGroup } from '../form';
import { Input, Select, Textarea } from '../ui';
import { useT } from '../../lib/i18n';
import type { ChatModel } from '../../lib/api/profiles';
import { useProfileStore } from '../../stores';
import { AvatarPicker } from './avatar-picker';
import { BotToolsField } from './bot-tools-field';
import type { BotNameIssue } from './bot-name';

export interface BotDraft {
  name: string;
  role: string;
  description: string;
  instructions: string;
  avatar: AvatarConfig;
  model_id: string | null;
  /** null = inherit the owner's whole allowed set. */
  tools: string[] | null;
  max_steps: number | null;
}

const MAX_STEPS_LIMIT = 50;

export function useBotNameMessage() {
  const t = useT();
  return (issue: BotNameIssue | 'limit' | null, name: string): string | undefined => {
    switch (issue) {
      case 'required':
        return t('bots.form.required');
      case 'too_long':
        return t('bots.form.tooLong', { max: BOT_NAME_MAX });
      case 'chars':
        return t('bots.form.chars');
      case 'reserved':
        return t('bots.form.reserved', { name: name.trim() });
      case 'is_you':
        return t('bots.form.isYou');
      case 'taken':
        return t('bots.form.taken', { name: name.trim() });
      case 'limit':
        return t('bots.form.limit');
      default:
        return undefined;
    }
  };
}

export function BotFields({
  value,
  onChange,
  nameError,
  models,
  compact = false,
  avatarTemplateKey,
  avatarStableId,
}: {
  value: BotDraft;
  onChange: (next: BotDraft) => void;
  nameError?: string;
  /** Offer a model choice (the Chat catalog); omitted → the field is hidden. */
  models?: ChatModel[];
  /** The in-chat card: tighter instructions box and a static avatar preview. */
  compact?: boolean;
  /** The Bot's template and id, so a legacy avatar resolves to the plant it shows everywhere else. */
  avatarTemplateKey?: string | null;
  avatarStableId?: string;
}) {
  const t = useT();
  const fetchTools = useProfileStore((state) => state.fetchTools);
  const set = <K extends keyof BotDraft>(key: K, next: BotDraft[K]) => onChange({ ...value, [key]: next });
  // The tool picker is built from the member's own allowed set (lazy, cached by the store).
  useEffect(() => {
    if (!compact) void fetchTools();
  }, [compact, fetchTools]);

  return (
    <div className="space-y-4">
      <FormGrid>
        <FormField
          label={t('bots.form.name')}
          required
          error={nameError}
          help={nameError ? undefined : t('bots.form.count', { count: [...value.name].length, max: BOT_NAME_MAX })}
        >
          <Input
            value={value.name}
            maxLength={BOT_NAME_MAX * 2}
            placeholder={t('bots.form.namePlaceholder')}
            onChange={(event) => set('name', event.target.value)}
            autoComplete="off"
          />
        </FormField>
        <FormField label={t('bots.form.role')}>
          <Input
            value={value.role}
            maxLength={BOT_ROLE_MAX}
            placeholder={t('bots.form.rolePlaceholder')}
            onChange={(event) => set('role', event.target.value)}
            autoComplete="off"
          />
        </FormField>
      </FormGrid>
      {!compact && (
        <FormField
          label={t('bots.form.description')}
          help={t('bots.form.count', { count: [...value.description].length, max: BOT_DESCRIPTION_MAX })}
        >
          <Input
            value={value.description}
            maxLength={BOT_DESCRIPTION_MAX}
            placeholder={t('bots.form.descriptionPlaceholder')}
            onChange={(event) => set('description', event.target.value)}
            autoComplete="off"
          />
        </FormField>
      )}
      <FormField
        label={t('bots.form.instructions')}
        help={t('bots.form.count', { count: value.instructions.length, max: BOT_INSTRUCTIONS_MAX })}
      >
        <Textarea
          value={value.instructions}
          maxLength={BOT_INSTRUCTIONS_MAX}
          rows={compact ? 3 : 5}
          placeholder={t('bots.form.instructionsPlaceholder')}
          onChange={(event) => set('instructions', event.target.value)}
        />
      </FormField>
      {!compact && (
        <FormGroup label={t('bots.form.tools')}>
          <BotToolsField value={value.tools} onChange={(tools) => set('tools', tools)} />
        </FormGroup>
      )}
      {!compact && (
        <FormField label={t('bots.form.maxSteps')} help={t('bots.form.maxStepsHint')}>
          <Input
            type="number"
            min={1}
            max={MAX_STEPS_LIMIT}
            value={value.max_steps === null ? '' : String(value.max_steps)}
            placeholder={t('bots.form.maxStepsDefault')}
            onChange={(event) => {
              const raw = event.target.value.trim();
              if (raw === '') return set('max_steps', null);
              const parsed = Number.parseInt(raw, 10);
              if (Number.isInteger(parsed)) set('max_steps', Math.max(1, Math.min(MAX_STEPS_LIMIT, parsed)));
            }}
          />
        </FormField>
      )}
      {models && models.length > 1 && (
        <FormField label={t('bots.form.model')}>
          <Select value={value.model_id ?? ''} onChange={(event) => set('model_id', event.target.value || null)}>
            <option value="">{t('bots.form.modelDefault')}</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.id === model.name ? model.id : `${model.id} · ${model.name}`}
              </option>
            ))}
          </Select>
        </FormField>
      )}
      <FormGroup label={t('bots.form.avatar')}>
        <AvatarPicker
          value={value.avatar}
          onChange={(avatar) => set('avatar', avatar)}
          templateKey={avatarTemplateKey}
          stableId={avatarStableId}
          // The compact form is the in-chat card: in a transcript only the speaking Bot moves.
          animate={compact ? false : undefined}
        />
      </FormGroup>
    </div>
  );
}
