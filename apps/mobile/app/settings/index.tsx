import { brandFont as font } from '../../src/ui/brand-font';
/**
 * Settings — the root of the Settings modal (page sheet with its own native
 * stack, large title, ✓ Done). A real SwiftUI Form, iOS Settings–style:
 *
 *  - account: avatar + name + email (one VoiceOver element — the initial is
 *    decoration), role, and the 工作站 row (→ stations page),
 *  - 外观: theme (segmented; applied app-wide at once via Appearance) and
 *    language (menu picker),
 *  - 对话: 标签 (→ tag library page), — internal accounts on iOS — 我的 Bot
 *    · {n} (→ /settings/bots, where Bots are made and managed) and — when the
 *    account has external tools — 连接器 · {n} (→ /settings/connectors: the
 *    member's own keys and sign-ins). No default agent to pick (2026-10): new
 *    chats start with Sprouty — the footer says so, and how to talk to one
 *    Bot on its own (its profile → 新对话),
 *  - 用量 (when the account has limits), 关于 (version, OTA update),
 *  - 退出登录 (destructive, confirmed): the modal closes first, then the auth
 *    store signs out and the root layout routes to /login (local — can't fail).
 *
 * Drill-down rows are the shared `FormNavRow` (label · muted value · chevron).
 */

import React, { useEffect } from 'react';
import { Stack, useRouter } from 'expo-router';
import {
  Button,
  Circle,
  HStack,
  LabeledContent,
  Picker,
  Section,
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
import { chooseLanguage } from '../../src/settings/account-language';
import type { LangPref, ThemePref } from '../../src/store/prefs';
import { useBotIdentityEnabled } from '../../src/bots/availability';
import { sproutyBot, useBots } from '../../src/bots/store';
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
  const { user, nickname, station, prefs, tagCount, tagsLoaded, version, update, signOut, connectors } =
    useSettings();
  const { theme, setTheme, lang } = prefs;
  const myBots = useMyBots();

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
              <Circle
                modifiers={[foregroundStyle(hex.accent), frame({ width: 56, height: 56 }), accessibilityHidden()]}
              />
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
            // the account takes it too: the server writes in it (Bot greetings, event lines), like the web's switch
            onSelectionChange={(v) => chooseLanguage(v as LangPref)}
            modifiers={[pickerStyle('menu')]}
          >
            <Text modifiers={[tag('zh')]}>{t('settings.langZh')}</Text>
            <Text modifiers={[tag('en')]}>{t('settings.langEn')}</Text>
          </Picker>
        </Section>

        {/* ── conversations ── */}
        <Section
          title={t('settings.conversations')}
          footer={myBots.main ? <Text>{t('settings.newChatHint', { name: myBots.main })}</Text> : undefined}
        >
          <FormNavRow
            label={t('settings.tags')}
            value={tagsLoaded ? String(tagCount) : ''}
            onPress={() => router.push('/settings/tags')}
          />
          {myBots.shown ? (
            <FormNavRow
              label={t('settings.myBots')}
              value={myBots.count === null ? '' : String(myBots.count)}
              onPress={() => router.push('/settings/bots')}
            />
          ) : null}
          {connectors !== null ? (
            <FormNavRow
              label={t('settings.connectors')}
              value={String(connectors)}
              onPress={() => router.push('/settings/connectors')}
            />
          ) : null}
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

/**
 * The 我的 Bot row (internal accounts on iOS — the identity routes need no
 * more, whatever the `bots` switch says) with the active Bot count, and the
 * main Bot's name (Sprouty, whom new chats start with) for the footer.
 */
function useMyBots() {
  const shown = useBotIdentityEnabled();
  const botsLoaded = useBots((s) => s.botsLoaded);
  const count = useBots((s) => (s.botsLoaded ? s.bots.length : null));
  const loadBots = useBots((s) => s.loadBots);
  const main = useBots((s) => sproutyBot(s)?.name ?? null);

  useEffect(() => {
    if (shown && !botsLoaded) void loadBots();
  }, [shown, botsLoaded, loadBots]);

  return { shown, count, main: shown ? main : null };
}
