import { BrandText as Text } from '../../src/ui/brand-text.android';
/**
 * 「我」 on Android — the page sheet's root as a Material 3 form (iOS: ./index.tsx, SwiftUI; both
 * read src/settings/use-settings.ts): the account (name, email, role), 工作站, the text size, My
 * Agents, 通知, 外观 (theme on this phone, the account's language), 关于 and 退出登录.
 */

import React from 'react';
import { Stack, useRouter } from 'expo-router';
import { Box, ListItem } from '@expo/ui/jetpack-compose';
import { background, clip, fillMaxWidth, Shapes, size } from '@expo/ui/jetpack-compose/modifiers';
import { useT } from '../../src/lib/i18n';
import { usePushRow, useSettings } from '../../src/settings/use-settings';
import { usePrefs, type LangPref, type ThemePref } from '../../src/store/prefs';
import { chooseTextSize } from '../../src/settings/text-size';
import { TEXT_STEP_NAMES, type TextStep } from '../../src/theme/type-scale';
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

export default function Me() {
  const t = useT();
  const m = useM3();
  const router = useRouter();
  const s = useSettings();
  const push = usePushRow();
  const name = s.user?.nickname || t('settings.fallbackName');
  const step = usePrefs((state) => state.textStep);

  return (
    <>
      {/* closed with the app bar's ← / system back — no iOS-style 完成 button */}
      <Stack.Screen options={{ title: t('me.title') }} />
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
          {s.user?.role ? (
            <FormValueRow
              label={t('settings.role')}
              value={t(s.user.role === 'super' ? 'settings.roleAdmin' : 'settings.roleMember')}
            />
          ) : null}
          <FormNavRow
            label={t('station.title')}
            value={s.station?.name ?? '—'}
            icon="server"
            onPress={() => router.push('/me/stations')}
          />
        </FormSection>

        {/* ── reading: the in-app text size (src/settings/text-size.ts) ── */}
        <FormSection title={t('me.reading')} footer={t('me.textSizeHint')}>
          <FormSelectRow<string>
            label={t('me.textSize')}
            value={String(step)}
            onChange={(next) => chooseTextSize(Number(next) as TextStep)}
            options={TEXT_STEP_NAMES.map((name, index) => ({ value: String(index), label: t(`me.textStep.${name}`) }))}
          />
        </FormSection>

        <FormSection>
          <FormNavRow label={t('nav.agent')} icon="sparkle" onPress={() => router.push('/me/agents')} />
          <FormNavRow
            label={t('settings.notifications')}
            value={push || undefined}
            icon="bell"
            onPress={() => router.push('/me/notifications')}
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
            onChange={(next) => void s.setLanguage(next)}
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
          <FormNavRow label={t('feedback.title')} icon="comment" onPress={() => router.push('/me/feedback')} />
        </FormSection>

        <FormSection>
          <FormActionRow label={t('settings.logout')} icon="logout" destructive onPress={() => void s.signOut()} />
        </FormSection>
      </NativeForm>
    </>
  );
}
