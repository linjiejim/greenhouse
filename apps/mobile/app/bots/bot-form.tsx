/**
 * `/bots/bot-form?botId=&template=&request=&inviteTo=` — create a Bot (from a
 * gallery template or custom), edit one, or edit a Bot another Bot proposed
 * (a `bot_create` card's 先改一下) before accepting it (spec
 * docs/specs/20261008-mobile-bots.md §2.5.7). A SwiftUI Form sheet; Android:
 * ./bot-form.android.tsx. The behaviour is src/bots/manage/use-bot-form.ts.
 *
 * Fields: the look (a live preview, the species as a menu, the resting mood
 * as a segmented control — written with `withPlant` / `withMood`), name (the
 * server's rules checked as you type; a refusal, else a length hint, goes
 * under the field), role, purpose (not for a proposal: the card has none),
 * instructions. No model / tools / step cap on mobile. Chrome is the shared
 * `FormChrome` (✕ confirms discarding edits, swipe-down is blocked while
 * dirty, ✓ saves).
 *
 * After ✓: a new Bot opens its DM (its greeting and starters are there) or
 * the conversation it was made for; an edit or an accepted proposal closes
 * the sheet (the profile / the card underneath updates in place). The form is
 * held from ✓ until the sheet is gone (`useBotForm`'s `onHold`): accepting
 * settles the card before the sheet closes, and the "already decided" state
 * must not flash in between.
 */

import React, { useLayoutEffect, useRef, useState } from 'react';
import { Text as RNText, View, useWindowDimensions } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  HStack,
  Picker,
  ProgressView,
  RNHostView,
  Section,
  Spacer,
  Text,
  TextField,
  VStack,
  useNativeState,
} from '@expo/ui/swift-ui';
import {
  accessibilityLabel,
  autocorrectionDisabled,
  foregroundStyle,
  lineLimit,
  pickerStyle,
  tag,
} from '@expo/ui/swift-ui/modifiers';
import { useT } from '../../src/lib/i18n';
import { BOT_DESCRIPTION_MAX, BOT_INSTRUCTIONS_MAX, BOT_NAME_MAX, BOT_ROLE_MAX } from '../../src/shared/bots';
import { nameIssueKey } from '../../src/bots/manage/bot-form-model';
import { useBotForm, useBotFormSource, type BotFormInit } from '../../src/bots/manage/use-bot-form';
import { openThread } from '../../src/bots/nav';
import { BotsRouteGate } from '../../src/bots/route-gate';
import { BotAvatar } from '../../src/bots/ui/bot-avatar';
import { makeStyles, space, typo, useTheme } from '../../src/theme';
import { EmptyState } from '../../src/ui/empty';
import { NativeForm } from '../../src/ui/native-form';
import { PLANT_IDS, PLANT_MOODS, type PlantId, type PlantMood } from '../../src/ui/plant-avatar/plant-ids';
import { FormChrome, SheetClose } from '../../src/ui/sheet-chrome';

type Chrome = React.ComponentProps<typeof FormChrome>;

/**
 * Closed Bots → home + "unavailable" (src/bots/route-gate.tsx; latched, as every SwiftUI sheet).
 * A Bot's identity (create / edit) needs the identity gate only, like Settings → My Bots; a
 * proposal, or a Bot made for a conversation, belongs to the conversations.
 */
export default function BotFormRoute() {
  const { request, inviteTo } = useLocalSearchParams<{ request?: string; inviteTo?: string }>();
  return (
    <BotsRouteGate kind={request || inviteTo ? 'threads' : 'identity'} latched>
      <BotFormSheet />
    </BotsRouteGate>
  );
}

function BotFormSheet() {
  const t = useT();
  const params = useLocalSearchParams<{ botId?: string; template?: string; request?: string; inviteTo?: string }>();
  const source = useBotFormSource({
    botId: params.botId || undefined,
    template: params.template || undefined,
    requestId: params.request || undefined,
    inviteTo: params.inviteTo || undefined,
  });
  // ✕ / ✓ for the ready form (handed up by BotFormSections: nav chrome can't sit among the Form's
  // SwiftUI children).
  const [chrome, setChrome] = useState<Chrome | null>(null);
  // The form whose own save is out or went through: it stays (same init, same key) whatever the
  // source reads by then — an accepted proposal's card is settled before the sheet closes. Set in
  // the ✓ press, before the request goes; the card only settles once the server has answered.
  const [held, setHeld] = useState<BotFormInit | null>(null);
  const init = source.status === 'ready' ? source.init : held;

  const title = params.request
    ? t('bots.manage.formProposal')
    : params.botId
      ? t('bots.manage.edit')
      : t('bots.manage.formNew');
  // The Form is mounted from the first frame, loading included: a SwiftUI Form that
  // only mounts once the sheet is up doesn't get the nav bar's top inset, and its
  // first (untitled) section slides under the bar.
  return (
    <>
      {chrome && init ? (
        <FormChrome {...chrome} />
      ) : (
        <>
          <Stack.Screen options={{ title }} />
          <SheetClose />
        </>
      )}
      {!init && (source.status === 'failed' || source.status === 'missing') ? (
        <View style={{ flex: 1, justifyContent: 'center' }}>
          {source.status === 'failed' ? (
            <EmptyState icon="alert" title={t('bots.manage.loadFailed')} onRetry={source.retry} />
          ) : params.request ? (
            <EmptyState
              icon="sparkle"
              title={t('bots.manage.proposalGone')}
              message={t('bots.manage.proposalGoneHint')}
            />
          ) : (
            <EmptyState icon="person" title={t('bots.manage.botMissing')} message={t('bots.manage.botMissingHint')} />
          )}
        </View>
      ) : (
        <NativeForm>
          {init ? (
            // Keyed: the (uncontrolled) fields capture their text from the right source once.
            <BotFormSections
              key={`${init.mode}:${init.bot?.id ?? init.request?.id ?? init.templateKey ?? 'custom'}`}
              init={init}
              onHold={setHeld}
              onChrome={setChrome}
            />
          ) : (
            <Section>
              <HStack>
                <Spacer />
                <ProgressView />
                <Spacer />
              </HStack>
            </Section>
          )}
        </NativeForm>
      )}
    </>
  );
}

function BotFormSections({
  init,
  onHold,
  onChrome,
}: {
  init: BotFormInit;
  /** Keep this form up (its own save is out / went through) or let it go (null) — see BotFormSheet. */
  onHold: (init: BotFormInit | null) => void;
  /** The sheet draws ✕ / ✓ outside the Form: this form's state for them (null once it is gone). */
  onChrome: (chrome: Chrome | null) => void;
}) {
  const t = useT();
  const router = useRouter();
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const form = useBotForm(init, { onHold });
  const { values } = form;
  // The native fields own their text; `form.values` mirrors it (change events are async).
  const nameText = useNativeState(init.values.name);
  const roleText = useNativeState(init.values.role);
  const purposeText = useNativeState(init.values.description);
  const instructionsText = useNativeState(init.values.instructions);

  const save = async () => {
    const result = await form.save({
      name: nameText.get(),
      role: roleText.get(),
      instructions: instructionsText.get(),
      ...(init.mode === 'proposal' ? null : { description: purposeText.get() }),
    });
    if (!result.ok) return;
    if (result.openThread) openThread(router, result.openThread, 'dismissTo');
    else router.back();
  };

  // ✓ runs the latest `save` (it reads this render's form and fields).
  const latestSave = useRef(save);
  useLayoutEffect(() => {
    latestSave.current = save;
  });
  const title = t(form.title.key, form.title.vars);
  const { dirty, canSave, saving } = form;
  useLayoutEffect(() => {
    onChrome({ title, dirty, canSave, saving, onSave: () => void latestSave.current() });
    return () => onChrome(null);
  }, [onChrome, title, dirty, canSave, saving]);

  // The RN preview is keyed on the text size: on iOS (RN 0.86 Fabric) a Dynamic Type change leaves
  // mounted RN text measured at the old size (facebook/react-native#57512); SwiftUI rows follow it.
  const { fontScale } = useWindowDimensions();
  const nameError = nameIssueKey(form.nameIssue);
  const look = `${t(`bots.manage.plantName.${form.plant}`)} · ${t(`bots.manage.moodName.${form.mood}`)}`;

  return (
    <>
      <Section
        header={
          <HStack>
            <Spacer />
            <RNHostView matchContents>
              <View key={fontScale} style={styles.preview}>
                <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                  <BotAvatar
                    bot={{ id: form.stableId, avatar: values.avatar, template_key: init.templateKey }}
                    size={80}
                    state="hello"
                    animate={false}
                  />
                </View>
                <RNText style={styles.look} accessibilityLabel={`${t('bots.manage.look')}: ${look}`}>
                  {look}
                </RNText>
              </View>
            </RNHostView>
            <Spacer />
          </HStack>
        }
      >
        <Picker
          label={t('bots.manage.plant')}
          selection={form.plant}
          onSelectionChange={(plant) => form.setPlant(plant as PlantId)}
          modifiers={[pickerStyle('menu')]}
        >
          {PLANT_IDS.map((plant) => (
            <Text key={plant} modifiers={[tag(plant)]}>
              {t(`bots.manage.plantName.${plant}`)}
            </Text>
          ))}
        </Picker>
        <Picker
          label={t('bots.manage.mood')}
          selection={form.mood}
          onSelectionChange={(mood) => form.setMood(mood as PlantMood)}
          // segmented hides the label — keep it for VoiceOver
          modifiers={[pickerStyle('segmented'), accessibilityLabel(t('bots.manage.mood'))]}
        >
          {PLANT_MOODS.map((mood) => (
            <Text key={mood} modifiers={[tag(mood)]}>
              {t(`bots.manage.moodName.${mood}`)}
            </Text>
          ))}
        </Picker>
      </Section>

      {/* The footer is always a Text — the refusal in red, else the length /
          @mention hint. Adding or removing a Section footer rebuilds its rows,
          and the focused name field would drop the keyboard the moment the
          name turns valid (or invalid) mid-typing (as in app/login.tsx). */}
      <Section
        title={t('bots.manage.name')}
        footer={
          <Text modifiers={nameError ? [foregroundStyle(hex.red)] : []}>
            {nameError ? t(nameError) : t('bots.manage.nameHint', { max: BOT_NAME_MAX })}
          </Text>
        }
      >
        <TextField
          text={nameText}
          // A little over the limit, so "at most 24" shows instead of silently stopping
          maxLength={BOT_NAME_MAX * 2}
          autoFocus={init.mode === 'create' && !init.templateKey}
          placeholder={t('bots.manage.namePlaceholder')}
          onTextChange={(text) => form.set('name', text)}
          modifiers={[autocorrectionDisabled()]}
        />
      </Section>

      <Section title={t('bots.manage.role')}>
        <TextField
          text={roleText}
          maxLength={BOT_ROLE_MAX}
          placeholder={t('bots.manage.rolePlaceholder')}
          onTextChange={(text) => form.set('role', text)}
        />
      </Section>

      {init.mode === 'proposal' ? null : (
        <Section title={t('bots.manage.purpose')}>
          <TextField
            text={purposeText}
            axis="vertical"
            maxLength={BOT_DESCRIPTION_MAX}
            placeholder={t('bots.manage.purposePlaceholder')}
            onTextChange={(text) => form.set('description', text)}
            modifiers={[lineLimit({ min: 1, max: 4 })]}
          />
        </Section>
      )}

      <Section
        title={t('bots.manage.instructions')}
        footer={
          <VStack alignment="leading" spacing={6}>
            <Text>
              {init.mode === 'proposal'
                ? t('bots.manage.proposalFooter', { name: values.name.trim() || t('bots.manage.formNew') })
                : t('bots.manage.versionFooter')}
            </Text>
            {form.computerWarning ? (
              <Text modifiers={[foregroundStyle(hex.orange)]}>{t('bots.manage.computerWarn')}</Text>
            ) : null}
          </VStack>
        }
      >
        <TextField
          text={instructionsText}
          axis="vertical"
          maxLength={BOT_INSTRUCTIONS_MAX}
          placeholder={t('bots.manage.instructionsPlaceholder')}
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
