/**
 * Settings — the root of the Settings modal (page sheet with its own native
 * stack, large title, ✓ Done). A real SwiftUI Form, iOS Settings–style:
 *
 *  - account: avatar + name + email (one VoiceOver element — the initial is
 *    decoration), role, and the 工作站 row (→ stations page),
 *  - 外观: theme (segmented; applied app-wide at once via Appearance) and
 *    language (menu picker),
 *  - 对话: default agent for new conversations (menu of GET /api/profiles) and
 *    标签 (→ tag library page),
 *  - 用量 (when the account has limits), 关于 (version, OTA update),
 *  - 退出登录 (destructive, confirmed): the modal closes first, then the auth
 *    store signs out and the root layout routes to /login (local — can't fail).
 *
 * Drill-down rows are the shared `FormNavRow` (label · muted value · chevron).
 */

import React from 'react';
import { Stack, useRouter } from 'expo-router';
import { Button, Circle, HStack, LabeledContent, Picker, ProgressView, Section, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import {
  accessibilityElement,
  accessibilityHidden,
  accessibilityLabel,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  pickerStyle,
  tag,
} from '@expo/ui/swift-ui/modifiers';
import type { LangPref, ThemePref } from '../../src/store/prefs';
import { profileLabel } from '../../src/chat/profile-menu';
import { compactNumber } from '../../src/lib/format';
import { useT } from '../../src/lib/i18n';
import { ROLE_LABEL, useSettings } from '../../src/settings/use-settings';
import { useTheme } from '../../src/theme';
import { FormNavRow, NativeForm } from '../../src/ui/native-form';
import { toolbarIcon } from '../../src/ui/toolbar-icon';

const SECONDARY = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

export default function Settings() {
  const t = useT();
  const { hex } = useTheme();
  const router = useRouter();
  const { user, nickname, station, prefs, profiles, shownProfile, tagCount, tagsLoaded, version, update, signOut } =
    useSettings();
  const { theme, setTheme, lang, setLang, setProfileId } = prefs;

  return (
    <>
      <Stack.Screen options={{ title: t('settings.title') }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={toolbarIcon('check')}
          variant="done"
          tintColor={hex.accent}
          accessibilityLabel={t('common.done')}
          onPress={() => router.back()}
        />
      </Stack.Toolbar>
      <NativeForm>
        {/* ── account ── */}
        <Section>
          {/* one VoiceOver element: "name, email" — the initial avatar is decoration */}
          <HStack spacing={14} modifiers={[accessibilityElement('combine')]}>
            <ZStack modifiers={[accessibilityHidden()]}>
              <Circle modifiers={[foregroundStyle(hex.accent), frame({ width: 56, height: 56 }), accessibilityHidden()]} />
              <Text
                modifiers={[
                  font({ textStyle: 'title2', weight: 'semibold' }),
                  foregroundStyle(hex.onAccent),
                  accessibilityHidden(),
                ]}
              >
                {(nickname.trim()[0] ?? '?').toUpperCase()}
              </Text>
            </ZStack>
            <VStack alignment="leading" spacing={2}>
              <Text modifiers={[font({ textStyle: 'title3', weight: 'semibold' }), lineLimit(1)]}>{nickname}</Text>
              {user?.email ? (
                <Text modifiers={[font({ textStyle: 'subheadline' }), SECONDARY, lineLimit(1)]}>{user.email}</Text>
              ) : null}
            </VStack>
          </HStack>
          {user?.role ? (
            <LabeledContent label={t('settings.role')}>
              <Text>{t(ROLE_LABEL[user.role])}</Text>
            </LabeledContent>
          ) : null}
          <FormNavRow
            label={t('station.title')}
            value={station?.name ?? '—'}
            onPress={() => router.push('/settings/stations')}
          />
        </Section>

        {/* ── appearance ── */}
        <Section title={t('settings.appearance')}>
          <Picker
            label={t('settings.theme')}
            selection={theme}
            onSelectionChange={(v) => setTheme(v as ThemePref)}
            // segmented hides the label — keep it for VoiceOver
            modifiers={[pickerStyle('segmented'), accessibilityLabel(t('settings.theme'))]}
          >
            <Text modifiers={[tag('system')]}>{t('settings.themeSystem')}</Text>
            <Text modifiers={[tag('light')]}>{t('settings.themeLight')}</Text>
            <Text modifiers={[tag('dark')]}>{t('settings.themeDark')}</Text>
          </Picker>
          <Picker
            label={t('settings.language')}
            selection={lang}
            onSelectionChange={(v) => setLang(v as LangPref)}
            modifiers={[pickerStyle('menu')]}
          >
            <Text modifiers={[tag('zh')]}>{t('settings.langZh')}</Text>
            <Text modifiers={[tag('en')]}>{t('settings.langEn')}</Text>
          </Picker>
        </Section>

        {/* ── conversations ── */}
        <Section title={t('settings.conversations')} footer={<Text>{t('settings.defaultAgentHint')}</Text>}>
          {profiles === null ? (
            <LabeledContent label={t('settings.defaultAgent')}>
              <ProgressView />
            </LabeledContent>
          ) : profiles.length === 0 ? (
            <LabeledContent label={t('settings.defaultAgent')}>
              <Text>{t('settings.unavailable')}</Text>
            </LabeledContent>
          ) : (
            <Picker
              label={t('settings.defaultAgent')}
              selection={shownProfile}
              onSelectionChange={(v) => setProfileId(String(v))}
              modifiers={[pickerStyle('menu')]}
            >
              {profiles.map((p) => (
                <Text key={p.id} modifiers={[tag(p.id)]}>
                  {profileLabel(p, lang, t)}
                </Text>
              ))}
            </Picker>
          )}
          <FormNavRow
            label={t('settings.tags')}
            value={tagsLoaded ? String(tagCount) : ''}
            onPress={() => router.push('/settings/tags')}
          />
        </Section>

        {/* ── usage ── */}
        {user?.daily_message_limit || user?.monthly_token_limit ? (
          <Section title={t('settings.usage')}>
            {user.daily_message_limit ? (
              <LabeledContent label={t('settings.dailyLimit')}>
                <Text>{String(user.daily_message_limit)}</Text>
              </LabeledContent>
            ) : null}
            {user.monthly_token_limit ? (
              <LabeledContent label={t('settings.monthlyLimit')}>
                <Text>{compactNumber(user.monthly_token_limit)}</Text>
              </LabeledContent>
            ) : null}
          </Section>
        ) : null}

        {/* ── about ── */}
        <Section title={t('settings.about')} footer={<Text>{t('settings.footer')}</Text>}>
          <LabeledContent label={t('settings.version')}>
            <Text>{version || '—'}</Text>
          </LabeledContent>
          <LabeledContent label={t('settings.update')}>
            <Text>{update}</Text>
          </LabeledContent>
        </Section>

        <Section>
          <Button role="destructive" onPress={() => void signOut()}>
            <Text modifiers={[frame({ maxWidth: 9999 })]}>{t('settings.logout')}</Text>
          </Button>
        </Section>
      </NativeForm>
    </>
  );
}
