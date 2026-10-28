import { useWindowDimensions } from 'react-native';
import { ScreenActions } from '../ui/screen-actions';
import { font } from '../ui/form-controls.web';
/**
 * 「我」 — the root of the page sheet the sidebar's foot opens. A SwiftUI Form, iOS Settings–style:
 *
 *  - account: the initial, name and email, the role; the 工作站 row (→ stations page);
 *  - 阅读: the in-app text size (seven steps on top of the system size, src/settings/text-size.ts);
 *  - 我的 Agent: the agents I connected (src/api/agent.ts) and their writes and spend (→ agents);
 *    连接: the outside services my agent uses through connectors (→ connectors);
 *  - 通用: 通知 (→ notifications), theme (this phone's), language (the account's) and how many recent conversations home lists (this phone's);
 *  - 关于 (version, update, 发送反馈 → feedback), then 退出登录 (destructive, confirmed; the sheet closes first).
 */

import React, { useCallback } from 'react';
import { Stack, useRouter } from 'expo-router';
import {
  Button,
  HStack,
  LabeledContent,
  Picker,
  RNHostView,
  Section,
  Slider,
  Text,
  VStack,
} from '../ui/form-controls.web';
import {
  accessibilityElement,
  accessibilityLabel,
  foregroundStyle,
  frame,
  lineLimit,
  pickerStyle,
  tag,
} from '../ui/form-controls.web';
import { listConnections } from '../api/agent';
import { useResource } from '../data/use-resource';
import { useT } from '../lib/i18n';
import { relativeTimeNow } from '../lib/time-words';
import { chooseTextSize } from '../settings/text-size';
import { usePushRow, useSettings } from '../settings/use-settings';
import { usePrefs, type LangPref, type ThemePref } from '../store/prefs';
import { HOME_RECENT_CHOICES, type HomeRecent } from '../data/home';
import { useTheme } from '../theme';
import { TEXT_STEP_NAMES, TEXT_STEPS, type TextStep } from '../theme/type-scale';
import { AgentAvatar, Avatar } from '../ui/avatar';
import { FormNavRow, NativeForm } from '../ui/native-form';
import { WIDE_MIN } from '../shell/wide-model';
import { hasPlugin } from '../plugins/manifest';
import { useStationManifest } from '../plugins/store';

const SECONDARY = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

export default function Me() {
  const t = useT();
  const manifest = useStationManifest((s) => s.data);
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
  // In the wide settings window Preferences owns theme / language / text size and the window owns close.
  const wide = useWindowDimensions().width >= WIDE_MIN;

  return (
    <>
      <Stack.Screen
        options={wide ? { title: t('client.account'), headerLeft: () => null } : { title: t('me.title') }}
      />
      {wide ? null : (
        <ScreenActions
          placement={'right'}
          actions={[{ id: 'action-1', icon: 'x' as const, label: t('common.close'), onPress: () => router.back() }]}
        />
      )}
      <NativeForm>
        {/* ── account ── */}
        <Section>
          {/* one VoiceOver element: "name, role · email" — the picture is decoration */}
          <HStack spacing={14} modifiers={[accessibilityElement('combine')]}>
            <RNHostView matchContents>
              <Avatar name={name} size={56} />
            </RNHostView>
            <VStack alignment="leading" spacing={2}>
              <Text modifiers={[font({ textStyle: 'title3', weight: 'semibold' }), lineLimit(1)]}>{name}</Text>
              <Text modifiers={[font({ textStyle: 'subheadline' }), SECONDARY, lineLimit(1)]}>
                {[role, s.user?.email].filter(Boolean).join(' · ')}
              </Text>
            </VStack>
          </HStack>
        </Section>

        {/* ── reading: the in-app text size ── */}
        {wide ? null : (
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
        )}

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
          <FormNavRow label={t('connectors.title')} value="" onPress={() => router.push('/me/connectors')} />
        </Section>

        {/* ── general ── */}
        <Section title={t('me.general')}>
          <FormNavRow
            label={t('settings.notifications')}
            value={push}
            onPress={() => router.push('/me/notifications')}
          />
          {wide ? null : (
            <>
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
            </>
          )}
        </Section>

        {/* ── about ── */}
        <Section title={t('settings.about')} footer={wide ? undefined : <Text>{t('settings.footer')}</Text>}>
          <LabeledContent label={t('settings.version')}>
            <Text>{s.version || '—'}</Text>
          </LabeledContent>
          <LabeledContent label={t('settings.update')}>
            <Text>{s.update}</Text>
          </LabeledContent>
          {hasPlugin(manifest, 'feedback') ? (
            <FormNavRow label={t('feedback.title')} value="" onPress={() => router.push('/me/feedback')} />
          ) : null}
        </Section>

        <Section>
          <Button role="destructive" onPress={() => void s.signOut()}>
            <Text modifiers={[frame({ maxWidth: 9999 }), foregroundStyle(hex.red)]}>{t('settings.logout')}</Text>
          </Button>
        </Section>
      </NativeForm>
    </>
  );
}
