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

import React, { useEffect, useMemo } from 'react';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { Stack, useNavigation, useRouter } from 'expo-router';
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
import { AFTER_DISMISS_MS, useAuth } from '../../src/store/auth';
import { usePrefs, type LangPref, type ThemePref } from '../../src/store/prefs';
import { useTags } from '../../src/store/tags';
import { useActiveStation } from '../../src/stations/use-active-station';
import { effectiveProfile, profileLabel, useProfiles } from '../../src/chat/profile-menu';
import type { UserRole } from '../../src/shared/greenhouse-types';
import { compactNumber } from '../../src/lib/format';
import { useT, type TranslationKey } from '../../src/lib/i18n';
import { useTheme } from '../../src/theme';
import { confirmAction } from '../../src/ui/dialogs';
import { FormNavRow, NativeForm } from '../../src/ui/native-form';

const SECONDARY = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

const ROLE_LABEL: Record<UserRole, TranslationKey> = {
  super: 'settings.roleSuper',
  team: 'settings.roleTeam',
  external: 'settings.roleExternal',
};

export default function Settings() {
  const t = useT();
  const { hex } = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  const lang = usePrefs((s) => s.lang);
  const setLang = usePrefs((s) => s.setLang);
  const profileId = usePrefs((s) => s.profileId);
  const setProfileId = usePrefs((s) => s.setProfileId);
  const station = useActiveStation();
  const tagCount = useTags((s) => s.tags.length);
  const tagsLoaded = useTags((s) => s.loaded);
  const loadTags = useTags((s) => s.load);
  // the composer's catalog cache — both pickers edit `prefs.profileId`
  const profiles = useProfiles();

  useEffect(() => {
    void loadTags();
  }, [loadTags]);

  // The stored id may be unset ('default') or stale (picked on another
  // station); show the agent the server will actually use.
  const shownProfile = useMemo(
    () => effectiveProfile(profiles, profileId)?.id,
    [profiles, profileId],
  );

  const nickname = user?.nickname || t('settings.fallbackName');
  // iOS convention: "1.3.2 (5)" — marketing version + build number
  const build = Constants.platform?.ios?.buildNumber;
  const version = `${Constants.expoConfig?.version ?? ''}${build ? ` (${build})` : ''}`.trim();

  const signOut = async () => {
    const ok = await confirmAction({
      title: t('settings.logout'),
      message: t('settings.logoutConfirm'),
      confirmLabel: t('settings.logout'),
      destructive: true,
    });
    if (!ok) return;
    navigation.getParent()?.goBack();
    setTimeout(logout, AFTER_DISMISS_MS);
  };

  return (
    <>
      <Stack.Screen options={{ title: t('settings.title') }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="checkmark"
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
            <Text>{updateLabel(t)}</Text>
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


/** Which JS bundle is running: dev server, the binary's embedded bundle, or an OTA update. */
function updateLabel(t: ReturnType<typeof useT>): string {
  if (__DEV__) return t('settings.updateDev');
  if (!Updates.isEnabled || Updates.isEmbeddedLaunch || !Updates.updateId) return t('settings.updateEmbedded');
  const day = Updates.createdAt ? Updates.createdAt.toISOString().slice(0, 10) : '';
  return [Updates.updateId.slice(0, 8), day].filter(Boolean).join(' · ');
}
