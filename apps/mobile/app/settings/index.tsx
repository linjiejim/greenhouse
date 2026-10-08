import { brandFont as font } from '../../src/ui/brand-font';
/**
 * Settings — the root of the Settings modal (page sheet with its own native
 * stack, large title, ✓ Done). A real SwiftUI Form, iOS Settings–style:
 *
 *  - account: avatar + name + email (one VoiceOver element — the initial is
 *    decoration), role, and the 工作站 row (→ stations page),
 *  - 外观: theme (segmented; applied app-wide at once via Appearance) and
 *    language (menu picker),
 *  - 对话: default agent for new conversations (menu of GET /api/profiles),
 *    标签 (→ tag library page) and — internal accounts on iOS — 我的 Bot · {n}
 *    (→ /settings/bots); when that default is one of the member's Bots and
 *    Bots threads are on, the footer also says the ongoing conversation in
 *    Bots is the same Bot (spec docs/specs/20261008-mobile-bots.md D4),
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
  ProgressView,
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
import { saveAccountLocale } from '../../src/api/auth';
import type { LangPref, ThemePref } from '../../src/store/prefs';
import { useBotIdentityEnabled, useBotsEnabled } from '../../src/bots/availability';
import { sproutyBot, useBots } from '../../src/bots/store';
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
  const myBots = useMyBots(shownProfile);

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
            onSelectionChange={(v) => {
              setLang(v as LangPref);
              // the server writes in the account's language (Bot greetings, event lines) — keep it in step, like the web
              void saveAccountLocale(v as LangPref);
            }}
            modifiers={[pickerStyle('menu')]}
          >
            <Text modifiers={[tag('zh')]}>{t('settings.langZh')}</Text>
            <Text modifiers={[tag('en')]}>{t('settings.langEn')}</Text>
          </Picker>
        </Section>

        {/* ── conversations ── */}
        <Section
          title={t('settings.conversations')}
          footer={
            <Text>
              {myBots.defaultBot
                ? `${t('settings.defaultAgentHint')}\n${t('bots.manage.mainFooter', { name: myBots.defaultBot })}`
                : t('settings.defaultAgentHint')}
            </Text>
          }
        >
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
          {myBots.shown ? (
            <FormNavRow
              label={t('settings.myBots')}
              value={myBots.count === null ? '' : String(myBots.count)}
              onPress={() => router.push('/settings/bots')}
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
 * name of the Bot new chats start with when the default agent is one of the
 * member's Bots (`sprouty` → the main Bot, `bot:<id>[@v]` → that Bot) and
 * Bots threads exist to have an ongoing conversation with it.
 */
function useMyBots(profileId: string | undefined) {
  const shown = useBotIdentityEnabled();
  const threads = useBotsEnabled();
  const botsLoaded = useBots((s) => s.botsLoaded);
  const count = useBots((s) => (s.botsLoaded ? s.bots.length : null));
  const loadBots = useBots((s) => s.loadBots);
  const defaultBot = useBots((s) => {
    if (!profileId) return null;
    if (profileId === 'sprouty') return sproutyBot(s)?.name ?? null;
    const id = profileId.startsWith('bot:') ? profileId.slice(4).split('@')[0] : null;
    const bot = id ? s.byId[id] : undefined;
    return bot && bot.status === 'active' ? bot.name : null;
  });

  useEffect(() => {
    if (shown && !botsLoaded) void loadBots();
  }, [shown, botsLoaded, loadBots]);

  return { shown, count, defaultBot: shown && threads ? defaultBot : null };
}
