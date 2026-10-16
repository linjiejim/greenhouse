/**
 * `/agents/edit` on Android (iOS: ./edit.tsx; both read src/agents/use-agent-form.ts): the
 * template gallery for a new Agent, then a Material form — the look (plant menu and colours),
 * name, role and instructions. ✓ creates it and opens its thread, or saves and goes back.
 */

import React from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { RNHostView } from '@expo/ui/jetpack-compose';
import { TintSwatches } from '../../src/agents/tint-swatches';
import { availableTemplates, templatePitch, useAgentForm, type AgentDraft } from '../../src/agents/use-agent-form';
import { useT } from '../../src/lib/i18n';
import { AGENT_NAME_MAX } from '../../src/shared/contract';
import { openConversation } from '../../src/shell/nav';
import { useAuth } from '../../src/store/auth';
import { AgentAvatar } from '../../src/ui/agent-avatar';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import {
  FormFields,
  FormNavRow,
  FormSection,
  FormSelectRow,
  FormTextField,
  NativeForm,
  useNativeState,
} from '../../src/ui/native-form.android';
import { PLANT_IDS, type PlantId } from '../../src/ui/plant-avatar/plant-ids';
import { FormChrome, SheetClose } from '../../src/ui/sheet-chrome';
import { toast } from '../../src/ui/toast';

export default function AgentEdit() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const t = useT();
  const router = useRouter();
  const me = useAuth((s) => s.user);
  const form = useAgentForm(id || null);
  const { draft } = form;
  const title = id ? t('agents.edit') : t('agents.new');

  const save = async () => {
    const outcome = await form.save();
    if (!outcome) return;
    if (outcome.kind === 'saved') {
      router.back();
      return;
    }
    toast(t('agents.created', { name: outcome.name }), 'check');
    if (outcome.conversationId)
      openConversation(router, { id: outcome.conversationId, title: outcome.name, compose: true }, 'dismissTo');
    else router.back();
  };

  if (id && form.loadFailed) {
    return (
      <>
        <Stack.Screen options={{ title }} />
        <SheetClose />
        <EmptyState icon="alert" title={t('agents.loadFailed')} onRetry={() => void form.retry()} />
      </>
    );
  }
  if (!draft) {
    return (
      <>
        <Stack.Screen options={{ title }} />
        <SheetClose />
        {id ? (
          <LoadingState />
        ) : (
          <NativeForm>
            <FormSection title={t('agents.templates')} footer={t('agents.templatesFooter')}>
              {availableTemplates(me).map((template) => (
                <FormNavRow
                  key={template.key}
                  label={`${template.copy[form.lang].name} · ${template.copy[form.lang].role}`}
                  value={templatePitch(template, me, form.lang)}
                  icon="sparkle"
                  onPress={() => form.choose(template)}
                />
              ))}
              <FormNavRow
                label={t('agents.blank')}
                value={t('agents.blankPitch')}
                icon="plus"
                onPress={() => form.choose(null)}
              />
            </FormSection>
          </NativeForm>
        )}
      </>
    );
  }
  return (
    <>
      <FormChrome
        title={title}
        dirty={form.dirty}
        canSave={form.canSave}
        saving={form.saving}
        onSave={() => void save()}
      />
      <AgentFields
        key={`${draft.template_key ?? 'blank'}:${id ?? 'new'}`}
        form={form}
        draft={draft}
        agentId={id ?? null}
      />
    </>
  );
}

function AgentFields({
  form,
  draft,
  agentId,
}: {
  form: ReturnType<typeof useAgentForm>;
  draft: AgentDraft;
  agentId: string | null;
}) {
  const t = useT();
  const nameText = useNativeState(draft.name);
  const roleText = useNativeState(draft.role);
  const instructionsText = useNativeState(draft.instructions);
  const stableId = agentId ?? draft.template_key ?? 'new';
  return (
    <NativeForm>
      <FormSection title={t('agents.look')}>
        <RNHostView matchContents>
          <View style={{ alignItems: 'center', paddingVertical: 12, gap: 12 }}>
            <AgentAvatar
              agent={{ id: stableId, avatar: { plant: draft.plant, tint: draft.tint }, template_key: null }}
              size={72}
            />
            <TintSwatches
              plant={draft.plant}
              stableId={stableId}
              tint={draft.tint}
              onChange={(tint) => form.set('tint', tint)}
            />
          </View>
        </RNHostView>
        <FormSelectRow<PlantId>
          label={t('agents.plant')}
          value={draft.plant}
          onChange={(plant) => form.set('plant', plant)}
          options={PLANT_IDS.map((plant) => ({ value: plant, label: t(`agents.plantName.${plant}`) }))}
        />
      </FormSection>
      <FormFields>
        <FormTextField
          label={t('agents.name')}
          state={nameText}
          onChangeText={(text) => form.set('name', text)}
          placeholder={t('agents.namePlaceholder')}
          supporting={t('agents.nameHint', { max: AGENT_NAME_MAX })}
          error={draft.name.trim().length > AGENT_NAME_MAX ? t('agents.nameHint', { max: AGENT_NAME_MAX }) : null}
          autoFocus={!agentId && !draft.template_key}
        />
        <FormTextField
          label={t('agents.role')}
          state={roleText}
          onChangeText={(text) => form.set('role', text)}
          placeholder={t('agents.rolePlaceholder')}
        />
        <FormTextField
          label={t('agents.instructions')}
          state={instructionsText}
          onChangeText={(text) => form.set('instructions', text)}
          placeholder={t('agents.instructionsPlaceholder')}
          supporting={t('agents.instructionsHint')}
          multiline
        />
      </FormFields>
    </NativeForm>
  );
}
