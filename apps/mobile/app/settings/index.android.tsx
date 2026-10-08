/**
 * Settings on Android — the Settings modal's root as a Material 3 form (iOS:
 * ./index.tsx, SwiftUI; both read src/settings/use-settings.ts):
 *
 *  - account card (initial avatar, name, email), role, 工作站 → stations page,
 *  - 外观: theme (segmented; applied app-wide at once) and language (menu),
 *  - 对话: default agent (menu of GET /api/profiles) and 标签 → tag library,
 *  - 用量 (when the account has limits), 关于 (version, which JS bundle runs),
 *  - 退出登录 (error color, confirmed).
 */

import React from 'react';
import { Stack, useRouter } from 'expo-router';
import { Box, ListItem, Text } from '@expo/ui/jetpack-compose';
import { background, clip, fillMaxWidth, Shapes, size } from '@expo/ui/jetpack-compose/modifiers';
import { saveAccountLocale } from '../../src/api/auth';
import type { LangPref, ThemePref } from '../../src/store/prefs';
import { profileLabel } from '../../src/chat/profile-menu';
import { compactNumber } from '../../src/lib/format';
import { useT } from '../../src/lib/i18n';
import { ROLE_LABEL, useSettings } from '../../src/settings/use-settings';
import { useM3 } from '../../src/ui/m3';
import {
  FormActionRow,
  FormNavRow,
  FormSection,
  FormSegmentedRow,
  FormSelectRow,
  FormValueRow,
  NativeForm,
} from '../../src/ui/native-form.android';

export default function Settings() {
  const t = useT();
  const m = useM3();
  const router = useRouter();
  const { user, nickname, station, prefs, profiles, shownProfile, tagCount, tagsLoaded, version, update, signOut } =
    useSettings();
  const { theme, setTheme, lang, setLang, setProfileId } = prefs;

  return (
    <>
      {/* closed with the app bar's ← / system back — no iOS-style 完成 button */}
      <Stack.Screen options={{ title: t('settings.title') }} />
      <NativeForm>
        {/* ── account ── */}
        <FormSection>
          <ListItem colors={{ containerColor: m.surfaceContainer }} modifiers={[fillMaxWidth()]}>
            <ListItem.LeadingContent>
              <Box contentAlignment="center" modifiers={[size(52, 52), clip(Shapes.Circle), background(m.primary)]}>
                <Text color={m.onPrimary} style={{ typography: 'titleLarge' }}>
                  {(nickname.trim()[0] ?? '?').toUpperCase()}
                </Text>
              </Box>
            </ListItem.LeadingContent>
            <ListItem.HeadlineContent>
              <Text style={{ typography: 'titleMedium' }} maxLines={1}>
                {nickname}
              </Text>
            </ListItem.HeadlineContent>
            {user?.email ? (
              <ListItem.SupportingContent>
                <Text color={m.onSurfaceVariant} style={{ typography: 'bodyMedium' }} maxLines={1}>
                  {user.email}
                </Text>
              </ListItem.SupportingContent>
            ) : null}
          </ListItem>
          {user?.role ? <FormValueRow label={t('settings.role')} value={t(ROLE_LABEL[user.role])} /> : null}
          <FormNavRow
            label={t('station.title')}
            value={station?.name ?? '—'}
            icon="server"
            onPress={() => router.push('/settings/stations')}
          />
        </FormSection>

        {/* ── appearance ── */}
        <FormSection title={t('settings.appearance')}>
          <FormSegmentedRow<ThemePref>
            label={t('settings.theme')}
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'system', label: t('settings.themeSystem') },
              { value: 'light', label: t('settings.themeLight') },
              { value: 'dark', label: t('settings.themeDark') },
            ]}
          />
          <FormSelectRow<LangPref>
            label={t('settings.language')}
            value={lang}
            onChange={(v) => {
              setLang(v);
              void saveAccountLocale(v);
            }}
            options={[
              { value: 'zh', label: t('settings.langZh') },
              { value: 'en', label: t('settings.langEn') },
            ]}
          />
        </FormSection>

        {/* ── conversations ── */}
        <FormSection title={t('settings.conversations')} footer={t('settings.defaultAgentHint')}>
          {profiles === null ? (
            <FormValueRow label={t('settings.defaultAgent')} loading />
          ) : profiles.length === 0 ? (
            <FormValueRow label={t('settings.defaultAgent')} value={t('settings.unavailable')} />
          ) : (
            <FormSelectRow
              label={t('settings.defaultAgent')}
              value={shownProfile}
              onChange={setProfileId}
              options={profiles.map((p) => ({ value: p.id, label: profileLabel(p, lang, t) }))}
            />
          )}
          <FormNavRow
            label={t('settings.tags')}
            value={tagsLoaded ? String(tagCount) : undefined}
            icon="tag"
            onPress={() => router.push('/settings/tags')}
          />
        </FormSection>

        {/* ── usage ── */}
        {user?.daily_message_limit || user?.monthly_token_limit ? (
          <FormSection title={t('settings.usage')}>
            {user.daily_message_limit ? (
              <FormValueRow label={t('settings.dailyLimit')} value={String(user.daily_message_limit)} />
            ) : null}
            {user.monthly_token_limit ? (
              <FormValueRow label={t('settings.monthlyLimit')} value={compactNumber(user.monthly_token_limit)} />
            ) : null}
          </FormSection>
        ) : null}

        {/* ── about ── */}
        <FormSection title={t('settings.about')} footer={t('settings.footer')}>
          <FormValueRow label={t('settings.version')} value={version || '—'} />
          <FormValueRow label={t('settings.update')} value={update} />
        </FormSection>

        <FormSection>
          <FormActionRow label={t('settings.logout')} icon="logout" destructive onPress={() => void signOut()} />
        </FormSection>
      </NativeForm>
    </>
  );
}
