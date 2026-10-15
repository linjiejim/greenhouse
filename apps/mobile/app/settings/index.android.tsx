import { BrandText as Text } from '../../src/ui/brand-text.android';
/**
 * Settings on Android — the Settings modal's root as a Material 3 form (iOS: ./index.tsx,
 * SwiftUI; both read src/settings/use-settings.ts): the account (picture, name, email, role,
 * change picture / name), 工作站, 通知, 外观 (theme, language — account settings), 关于 and
 * 退出登录.
 */

import React from 'react';
import { Stack, useRouter } from 'expo-router';
import { Box, ListItem } from '@expo/ui/jetpack-compose';
import { background, clip, fillMaxWidth, Shapes, size } from '@expo/ui/jetpack-compose/modifiers';
import { useT } from '../../src/lib/i18n';
import { usePushRow, useSettings } from '../../src/settings/use-settings';
import type { LangPref, ThemePref } from '../../src/store/prefs';
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
  const s = useSettings();
  const push = usePushRow();
  const name = s.user?.name || t('settings.fallbackName');

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
                  {(name.trim()[0] ?? '?').toUpperCase()}
                </Text>
              </Box>
            </ListItem.LeadingContent>
            <ListItem.HeadlineContent>
              <Text style={{ typography: 'titleMedium' }} maxLines={1}>
                {name}
              </Text>
            </ListItem.HeadlineContent>
            {s.user?.email ? (
              <ListItem.SupportingContent>
                <Text color={m.onSurfaceVariant} style={{ typography: 'bodyMedium' }} maxLines={1}>
                  {s.user.email}
                </Text>
              </ListItem.SupportingContent>
            ) : null}
          </ListItem>
          <FormActionRow label={t('settings.changeAvatar')} icon="image" onPress={() => void s.changeAvatar()} />
          <FormActionRow label={t('settings.changeName')} icon="pen" onPress={() => void s.rename()} />
          {s.user?.role ? (
            <FormValueRow
              label={t('settings.role')}
              value={t(s.user.role === 'admin' ? 'settings.roleAdmin' : 'settings.roleMember')}
            />
          ) : null}
          <FormNavRow label={t('integration.aboutMe')} onPress={() => router.push('/settings/account')} />
          <FormNavRow
            label={t('integration.changePassword')}
            onPress={() => router.push({ pathname: '/settings/account', params: { mode: 'password' } })}
          />
          <FormNavRow
            label={t('station.title')}
            value={s.station?.name ?? '—'}
            icon="server"
            onPress={() => router.push('/settings/stations')}
          />
        </FormSection>

        <FormSection>
          <FormNavRow
            label={t('settings.notifications')}
            value={push || undefined}
            icon="bell"
            onPress={() => router.push('/settings/notifications')}
          />
        </FormSection>

        {/* ── appearance ── */}
        <FormSection title={t('settings.appearance')}>
          <FormSegmentedRow<ThemePref>
            label={t('settings.theme')}
            value={s.theme}
            onChange={s.setTheme}
            options={[
              { value: 'system', label: t('settings.themeSystem') },
              { value: 'light', label: t('settings.themeLight') },
              { value: 'dark', label: t('settings.themeDark') },
            ]}
          />
          <FormSelectRow<LangPref>
            label={t('settings.language')}
            value={s.lang}
            onChange={s.setLanguage}
            options={[
              { value: 'zh', label: t('settings.langZh') },
              { value: 'en', label: t('settings.langEn') },
            ]}
          />
        </FormSection>

        {/* ── about ── */}
        <FormSection title={t('settings.about')} footer={t('settings.footer')}>
          <FormValueRow label={t('settings.version')} value={s.version || '—'} />
          <FormValueRow label={t('settings.update')} value={s.update} />
        </FormSection>

        <FormSection>
          <FormActionRow label={t('settings.logout')} icon="logout" destructive onPress={() => void s.signOut()} />
        </FormSection>
      </NativeForm>
    </>
  );
}
