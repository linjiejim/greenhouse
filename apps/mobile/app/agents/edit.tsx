/**
 * `/agents/edit?id=` — an Agent's 资料 (AGNT-05: name, plant and colour, role, instructions), or
 * `/agents/edit` without an id — a new Agent (AGNT-02): the template gallery first (the ones this
 * workspace can serve, and 空白), then the same form prefilled. A SwiftUI Form sheet, mounted
 * from the first frame (apps/mobile/AGENTS.md); Android: ./edit.android.tsx. The behaviour is
 * src/agents/use-agent-form.ts.
 *
 * ✓ creates the Agent and opens its Agent thread, or saves a new version and goes back. ✕ asks
 * before throwing edits away.
 */

import React from 'react';
import { Text as RNText, View, useWindowDimensions } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  Button,
  HStack,
  Picker,
  RNHostView,
  Section,
  Spacer,
  Text,
  TextField,
  VStack,
  useNativeState,
} from '@expo/ui/swift-ui';
import { autocorrectionDisabled, foregroundStyle, lineLimit, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { TintSwatches } from '../../src/agents/tint-swatches';
import { availableTemplates, templatePitch, useAgentForm, type AgentDraft } from '../../src/agents/use-agent-form';
import { useT } from '../../src/lib/i18n';
import { AGENT_INSTRUCTIONS_MAX, AGENT_NAME_MAX, AGENT_ROLE_MAX } from '../../src/shared/contract';
import { openConversation } from '../../src/shell/nav';
import { useAuth } from '../../src/store/auth';
import { makeStyles, space, typo, useTheme } from '../../src/theme';
import { AgentAvatar } from '../../src/ui/agent-avatar';
import { EmptyState } from '../../src/ui/empty';
import { NativeForm, FormLoading } from '../../src/ui/native-form';
import { PLANT_IDS, type PlantId } from '../../src/ui/plant-avatar/plant-ids';
import { FormChrome, SheetClose } from '../../src/ui/sheet-chrome';
import { toast } from '../../src/ui/toast';

const SECONDARY = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

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

  return (
    <>
      {draft ? (
        <FormChrome
          title={title}
          dirty={form.dirty}
          canSave={form.canSave}
          saving={form.saving}
          onSave={() => void save()}
        />
      ) : (
        <>
          <Stack.Screen options={{ title }} />
          <SheetClose />
        </>
      )}
      {id && form.loadFailed ? (
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <EmptyState icon="alert" title={t('agents.loadFailed')} onRetry={() => void form.retry()} />
        </View>
      ) : (
        <NativeForm>
          {draft ? (
            <AgentFields
              key={`${draft.template_key ?? 'blank'}:${id ?? 'new'}`}
              form={form}
              draft={draft}
              agentId={id ?? null}
            />
          ) : id ? (
            <Section>
              <FormLoading />
            </Section>
          ) : (
            <Section title={t('agents.templates')} footer={<Text>{t('agents.templatesFooter')}</Text>}>
              {availableTemplates(me).map((template) => (
                <Button key={template.key} onPress={() => form.choose(template)}>
                  <HStack spacing={12}>
                    <RNHostView matchContents>
                      <View>
                        <AgentAvatar
                          agent={{ id: template.key, avatar: { plant: template.plant }, template_key: template.key }}
                          size={36}
                        />
                      </View>
                    </RNHostView>
                    <VStack alignment="leading" spacing={2}>
                      <Text>{`${template.copy[form.lang].name} · ${template.copy[form.lang].role}`}</Text>
                      <Text modifiers={[SECONDARY, lineLimit(2)]}>{templatePitch(template, me, form.lang)}</Text>
                    </VStack>
                    <Spacer />
                  </HStack>
                </Button>
              ))}
              <Button onPress={() => form.choose(null)}>
                <VStack alignment="leading" spacing={2}>
                  <Text>{t('agents.blank')}</Text>
                  <Text modifiers={[SECONDARY]}>{t('agents.blankPitch')}</Text>
                </VStack>
              </Button>
            </Section>
          )}
        </NativeForm>
      )}
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
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const { fontScale } = useWindowDimensions();
  // The native fields own their text; the draft mirrors it (change events are async).
  const nameText = useNativeState(draft.name);
  const roleText = useNativeState(draft.role);
  const instructionsText = useNativeState(draft.instructions);
  const stableId = agentId ?? draft.template_key ?? 'new';
  const look = `${t(`agents.plantName.${draft.plant}`)} · ${t(`agents.tintName.${draft.tint}`)}`;
  const nameTooLong = draft.name.trim().length > AGENT_NAME_MAX;
  return (
    <>
      <Section
        header={
          <HStack>
            <Spacer />
            <RNHostView matchContents>
              <View key={fontScale} style={styles.preview}>
                <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                  <AgentAvatar
                    agent={{ id: stableId, avatar: { plant: draft.plant, tint: draft.tint }, template_key: null }}
                    size={80}
                    animate
                  />
                </View>
                <RNText style={styles.look} accessibilityLabel={`${t('agents.look')}: ${look}`}>
                  {look}
                </RNText>
              </View>
            </RNHostView>
            <Spacer />
          </HStack>
        }
      >
        <Picker
          label={t('agents.plant')}
          selection={draft.plant}
          onSelectionChange={(plant) => form.set('plant', plant as PlantId)}
          modifiers={[pickerStyle('menu')]}
        >
          {PLANT_IDS.map((plant) => (
            <Text key={plant} modifiers={[tag(plant)]}>
              {t(`agents.plantName.${plant}`)}
            </Text>
          ))}
        </Picker>
        <RNHostView matchContents>
          <TintSwatches
            key={fontScale}
            plant={draft.plant}
            stableId={stableId}
            tint={draft.tint}
            onChange={(tint) => form.set('tint', tint)}
          />
        </RNHostView>
      </Section>

      <Section
        title={t('agents.name')}
        footer={
          <Text modifiers={nameTooLong ? [foregroundStyle(hex.red)] : []}>
            {t('agents.nameHint', { max: AGENT_NAME_MAX })}
          </Text>
        }
      >
        <TextField
          text={nameText}
          maxLength={AGENT_NAME_MAX * 2}
          autoFocus={!agentId && !draft.template_key}
          placeholder={t('agents.namePlaceholder')}
          onTextChange={(text) => form.set('name', text)}
          modifiers={[autocorrectionDisabled()]}
        />
      </Section>

      <Section title={t('agents.role')}>
        <TextField
          text={roleText}
          maxLength={AGENT_ROLE_MAX}
          placeholder={t('agents.rolePlaceholder')}
          onTextChange={(text) => form.set('role', text)}
        />
      </Section>

      <Section title={t('agents.instructions')} footer={<Text>{t('agents.instructionsHint')}</Text>}>
        <TextField
          text={instructionsText}
          axis="vertical"
          maxLength={AGENT_INSTRUCTIONS_MAX}
          placeholder={t('agents.instructionsPlaceholder')}
          onTextChange={(text) => form.set('instructions', text)}
          modifiers={[lineLimit({ min: 4, max: 12 })]}
        />
      </Section>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  preview: { alignItems: 'center', gap: space.sm, paddingTop: space.sm, paddingBottom: space.md },
  look: { ...typo.footnote, color: c.secondaryLabel, textAlign: 'center' },
}));
