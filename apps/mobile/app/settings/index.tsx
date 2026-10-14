import { brandFont as font } from '../../src/ui/brand-font';
/**
 * Settings — the root of the Settings modal (page sheet with its own native stack, large title,
 * ✓ Done). A SwiftUI Form, iOS Settings–style (SET-01, SET-02):
 *
 *  - account: picture (or the initial) + name + email; 「更换头像」 and 「修改名字」; the role;
 *    the 工作站 row (→ stations page);
 *  - 通知 (→ /settings/notifications): what reaches the member, and this phone;
 *  - 外观: theme (segmented) and language (menu) — account settings, applied at once and saved;
 *  - 关于 (version, which JS bundle runs);
 *  - 退出登录 (destructive, confirmed): the modal closes first, then the auth store signs out
 *    and the root layout routes to /login.
 */

import React from 'react';
import { Stack, useRouter } from 'expo-router';
import { Button, Circle, HStack, LabeledContent, Picker, RNHostView, Section, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import {
  accessibilityElement,
  accessibilityHidden,
  accessibilityLabel,
  foregroundStyle,
  frame,
  lineLimit,
  pickerStyle,
  tag,
} from '@expo/ui/swift-ui/modifiers';
import { Image } from 'expo-image';
import { View } from 'react-native';
import { fileUrl } from '../../src/api/files';
import { useT } from '../../src/lib/i18n';
import { usePushRow, useSettings } from '../../src/settings/use-settings';
import type { LangPref, ThemePref } from '../../src/store/prefs';
import { useTheme } from '../../src/theme';
import { FormNavRow, NativeForm } from '../../src/ui/native-form';
import { toolbarIcon } from '../../src/ui/toolbar-icon';

const SECONDARY = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

export default function Settings() {
  const t = useT();
  const { hex } = useTheme();
  const router = useRouter();
  const s = useSettings();
  const push = usePushRow();
  const name = s.user?.name || t('settings.fallbackName');

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
          {/* one VoiceOver element: "name, email" — the picture is decoration */}
          <HStack spacing={14} modifiers={[accessibilityElement('combine')]}>
            {s.user?.avatar_url ? (
              <RNHostView matchContents>
                <View style={{ width: 56, height: 56 }}>
                  <Image
                    source={{ uri: fileUrl(s.user.avatar_url) }}
                    style={{ width: 56, height: 56, borderRadius: 28 }}
                    contentFit="cover"
                    accessible={false}
                  />
                </View>
              </RNHostView>
            ) : (
              <ZStack modifiers={[accessibilityHidden()]}>
                <Circle modifiers={[foregroundStyle(hex.accent), frame({ width: 56, height: 56 }), accessibilityHidden()]} />
                <Text
                  modifiers={[
                    font({ textStyle: 'title2', weight: 'semibold' }),
                    foregroundStyle(hex.onAccent),
                    accessibilityHidden(),
                  ]}
                >
                  {(name.trim()[0] ?? '?').toUpperCase()}
                </Text>
              </ZStack>
            )}
            <VStack alignment="leading" spacing={2}>
              <Text modifiers={[font({ textStyle: 'title3', weight: 'semibold' }), lineLimit(1)]}>{name}</Text>
              {s.user?.email ? (
                <Text modifiers={[font({ textStyle: 'subheadline' }), SECONDARY, lineLimit(1)]}>{s.user.email}</Text>
              ) : null}
            </VStack>
          </HStack>
          <Button onPress={() => void s.changeAvatar()}>
            <Text modifiers={[frame({ maxWidth: 9999, alignment: 'leading' })]}>{t('settings.changeAvatar')}</Text>
          </Button>
          <Button onPress={() => void s.rename()}>
            <Text modifiers={[frame({ maxWidth: 9999, alignment: 'leading' })]}>{t('settings.changeName')}</Text>
          </Button>
          {s.user?.role ? (
            <LabeledContent label={t('settings.role')}>
              <Text>{t(s.user.role === 'admin' ? 'settings.roleAdmin' : 'settings.roleMember')}</Text>
            </LabeledContent>
          ) : null}
          <FormNavRow label={t('station.title')} value={s.station?.name ?? '—'} onPress={() => router.push('/settings/stations')} />
        </Section>

        <Section>
          <FormNavRow label={t('settings.notifications')} value={push} onPress={() => router.push('/settings/notifications')} />
        </Section>

        {/* ── appearance ── */}
        <Section title={t('settings.appearance')}>
          <Picker
            label={t('settings.theme')}
            selection={s.theme}
            onSelectionChange={(v) => s.setTheme(v as ThemePref)}
            // segmented hides the label — keep it for VoiceOver
            modifiers={[pickerStyle('segmented'), accessibilityLabel(t('settings.theme'))]}
          >
            <Text modifiers={[tag('system')]}>{t('settings.themeSystem')}</Text>
            <Text modifiers={[tag('light')]}>{t('settings.themeLight')}</Text>
            <Text modifiers={[tag('dark')]}>{t('settings.themeDark')}</Text>
          </Picker>
          <Picker
            label={t('settings.language')}
            selection={s.lang}
            onSelectionChange={(v) => s.setLanguage(v as LangPref)}
            modifiers={[pickerStyle('menu')]}
          >
            <Text modifiers={[tag('zh')]}>{t('settings.langZh')}</Text>
            <Text modifiers={[tag('en')]}>{t('settings.langEn')}</Text>
          </Picker>
        </Section>

        {/* ── about ── */}
        <Section title={t('settings.about')} footer={<Text>{t('settings.footer')}</Text>}>
          <LabeledContent label={t('settings.version')}>
            <Text>{s.version || '—'}</Text>
          </LabeledContent>
          <LabeledContent label={t('settings.update')}>
            <Text>{s.update}</Text>
          </LabeledContent>
        </Section>

        <Section>
          <Button role="destructive" onPress={() => void s.signOut()}>
            <Text modifiers={[frame({ maxWidth: 9999 })]}>{t('settings.logout')}</Text>
          </Button>
        </Section>
      </NativeForm>
    </>
  );
}
