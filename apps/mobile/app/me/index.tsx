import { brandFont as font } from '../../src/ui/brand-font';
/**
 * 「我」 — the root of the page sheet the sidebar's foot opens. A SwiftUI Form, iOS Settings–style:
 *
 *  - account: the initial, name and email, the role; the 工作站 row (→ stations page);
 *  - 阅读: the in-app text size (seven steps on top of the system size, src/settings/text-size.ts);
 *  - 我的 Agent: the agents I connected (src/api/agent.ts) and their writes and spend (→ agents);
 *  - 通用: 通知 (→ notifications), theme (this phone's), language (the account's) and how many recent conversations home lists (this phone's);
 *  - 关于 (version, update, 发送反馈 → feedback), then 退出登录 (destructive, confirmed; the sheet closes first).
 */

import React, { useCallback } from 'react';
import { Stack, useRouter } from 'expo-router';
import {
  Button,
  Circle,
  HStack,
  LabeledContent,
  Picker,
  RNHostView,
  Section,
  Slider,
  Text,
  VStack,
  ZStack,
} from '@expo/ui/swift-ui';
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
import { listConnections } from '../../src/api/agent';
import { useResource } from '../../src/data/use-resource';
import { useT } from '../../src/lib/i18n';
import { relativeTimeNow } from '../../src/lib/time-words';
import { chooseTextSize } from '../../src/settings/text-size';
import { usePushRow, useSettings } from '../../src/settings/use-settings';
import { usePrefs, type LangPref, type ThemePref } from '../../src/store/prefs';
import { HOME_RECENT_CHOICES, type HomeRecent } from '../../src/data/home';
import { useTheme } from '../../src/theme';
import { TEXT_STEP_NAMES, TEXT_STEPS, type TextStep } from '../../src/theme/type-scale';
import { AgentAvatar } from '../../src/ui/avatar';
import { FormNavRow, NativeForm } from '../../src/ui/native-form';
import { toolbarIcon } from '../../src/ui/toolbar-icon';

const SECONDARY = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

export default function Me() {
  const t = useT();
  const { hex } = useTheme();
  const router = useRouter();
  const s = useSettings();
  const homeRecent = usePrefs((state) => state.homeRecent);
  const setHomeRecent = usePrefs((state) => state.setHomeRecent);
  const push = usePushRow();
  const step = usePrefs((state) => state.textStep);
  const connections = useResource(useCallback(() => listConnections(), []));
  const name = s.user?.nickname || t('settings.fallbackName');
  const role = s.user?.role ? t(s.user.role === 'super' ? 'settings.roleAdmin' : 'settings.roleMember') : '';

  return (
    <>
      <Stack.Screen options={{ title: t('me.title') }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={toolbarIcon('x')}
          accessibilityLabel={t('common.close')}
          onPress={() => router.back()}
        />
      </Stack.Toolbar>
      <NativeForm>
        {/* ── account ── */}
        <Section>
          {/* one VoiceOver element: "name, role · email" — the picture is decoration */}
          <HStack spacing={14} modifiers={[accessibilityElement('combine')]}>
            <ZStack modifiers={[accessibilityHidden()]}>
              <Circle
                modifiers={[foregroundStyle(hex.accentFill), frame({ width: 56, height: 56 }), accessibilityHidden()]}
              />
              <Text
                modifiers={[
                  font({ textStyle: 'title2', weight: 'semibold' }),
                  foregroundStyle(hex.accentText),
                  accessibilityHidden(),
                ]}
              >
                {(name.trim()[0] ?? '?').toUpperCase()}
              </Text>
            </ZStack>
            <VStack alignment="leading" spacing={2}>
              <Text modifiers={[font({ textStyle: 'title3', weight: 'semibold' }), lineLimit(1)]}>{name}</Text>
              <Text modifiers={[font({ textStyle: 'subheadline' }), SECONDARY, lineLimit(1)]}>
                {[role, s.user?.email].filter(Boolean).join(' · ')}
              </Text>
            </VStack>
          </HStack>
          <FormNavRow
            label={t('station.title')}
            value={s.station?.name ?? '—'}
            onPress={() => router.push('/me/stations')}
          />
        </Section>

        {/* ── reading: the in-app text size ── */}
        <Section title={t('me.reading')} footer={<Text>{t('me.textSizeHint')}</Text>}>
          <LabeledContent label={t('me.textSize')}>
            <Text>{t(`me.textStep.${TEXT_STEP_NAMES[step]}`)}</Text>
          </LabeledContent>
          <Slider
            value={step}
            min={0}
            max={TEXT_STEPS.length - 1}
            step={1}
            minimumValueLabel={<Text modifiers={[font({ textStyle: 'footnote' })]}>A</Text>}
            maximumValueLabel={<Text modifiers={[font({ textStyle: 'title2' })]}>A</Text>}
            onValueChange={(value) => chooseTextSize(Math.round(value) as TextStep)}
            modifiers={[accessibilityLabel(t('me.textSize'))]}
          />
        </Section>

        {/* ── my agents ── */}
        <Section title={t('nav.agent')}>
          {(connections.data?.connections ?? []).slice(0, 4).map((agent) => (
            <Button key={agent.client_id} onPress={() => router.push('/me/agents')}>
              <HStack spacing={12}>
                <RNHostView matchContents>
                  <AgentAvatar name={agent.client_name} avatar={agent.avatar} size={32} />
                </RNHostView>
                <VStack alignment="leading" spacing={2}>
                  <Text modifiers={[font({ textStyle: 'body' }), foregroundStyle(hex.label), lineLimit(1)]}>
                    {agent.client_name}
                  </Text>
                  <Text
                    modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(hex.secondaryLabel), lineLimit(1)]}
                  >
                    {agent.last_seen_at
                      ? t('me.agentSeen', { when: relativeTimeNow(agent.last_seen_at) })
                      : t('me.agentConnected')}
                  </Text>
                </VStack>
              </HStack>
            </Button>
          ))}
          <FormNavRow label={t('me.agentActivity')} value="" onPress={() => router.push('/me/agents')} />
        </Section>

        {/* ── general ── */}
        <Section title={t('me.general')}>
          <FormNavRow
            label={t('settings.notifications')}
            value={push}
            onPress={() => router.push('/me/notifications')}
          />
          <Picker
            label={t('settings.theme')}
            selection={s.theme}
            onSelectionChange={(v) => s.setTheme(v as ThemePref)}
            modifiers={[pickerStyle('menu')]}
          >
            <Text modifiers={[tag('system')]}>{t('settings.themeSystem')}</Text>
            <Text modifiers={[tag('light')]}>{t('settings.themeLight')}</Text>
            <Text modifiers={[tag('dark')]}>{t('settings.themeDark')}</Text>
          </Picker>
          <Picker
            label={t('settings.language')}
            selection={s.lang}
            onSelectionChange={(v) => void s.setLanguage(v as LangPref)}
            modifiers={[pickerStyle('menu')]}
          >
            <Text modifiers={[tag('zh')]}>{t('settings.langZh')}</Text>
            <Text modifiers={[tag('en')]}>{t('settings.langEn')}</Text>
          </Picker>
          <Picker
            label={t('settings.homeRecent')}
            selection={String(homeRecent)}
            onSelectionChange={(v) => setHomeRecent(Number(v) as HomeRecent)}
            modifiers={[pickerStyle('menu')]}
          >
            {HOME_RECENT_CHOICES.map((n) => (
              <Text key={n} modifiers={[tag(String(n))]}>
                {n === 0 ? t('settings.homeRecentNone') : String(n)}
              </Text>
            ))}
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
          <FormNavRow label={t('feedback.title')} value="" onPress={() => router.push('/me/feedback')} />
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
