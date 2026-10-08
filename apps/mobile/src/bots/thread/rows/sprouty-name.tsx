/**
 * The Sprouty naming hint (spec §2.5.10): under the main Bot's greeting, while
 * it still carries its built-in name and has never been edited — "Your main
 * assistant is called Sprouty — want to give it a name of your own?" [Rename]
 * [Keep Sprouty]. Rename opens the Bot form; Keep hides it for good on this
 * device (a pref keyed by the Bot, so another account or station asks again).
 * Waits for the pref before showing anything — no flash of a hint already
 * dismissed.
 */

import React, { memo, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { loadPref, savePref } from '../../../api/token-storage';
import { useT } from '../../../lib/i18n';
import { isSproutyBot, SPROUTY_BOT_TEMPLATE, type BotView } from '../../../shared/bots';
import { makeStyles, radius, space, squircle, typo, useTheme } from '../../../theme';
import { useFontScaleKey } from '../../../ui/font-scale';
import { NativeButton } from '../../../ui/button';
import { BotAvatar } from '../../ui/bot-avatar';

/** The built-in name in either language (the template's copy). */
const BUILT_IN_NAMES = new Set([SPROUTY_BOT_TEMPLATE.copy.en.name, SPROUTY_BOT_TEMPLATE.copy.zh.name]);

/** The main Bot, still as it came: built-in name, first version. */
export function wantsNameHint(bot: BotView | undefined): bot is BotView {
  return (
    !!bot && isSproutyBot(bot) && bot.status === 'active' && bot.current_version === 1 && BUILT_IN_NAMES.has(bot.name)
  );
}

/** Pref keys allow letters, digits, `.`, `-`, `_` only (SecureStore). */
const prefKey = (botId: string) => `botsNameHint_${botId.replace(/[^A-Za-z0-9._-]/g, '_')}`;

export const SproutyNameHint = memo(function SproutyNameHint({
  bot,
  onRename,
}: {
  bot: BotView;
  onRename: (botId: string) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  // keyed on the text size: re-measures when Dynamic Type changes (src/ui/font-scale.ts)
  const fontKey = useFontScaleKey();
  const t = useT();
  const [shown, setShown] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void loadPref(prefKey(bot.id)).then((dismissed) => {
      if (alive) setShown(!dismissed);
    });
    return () => {
      alive = false;
    };
  }, [bot.id]);
  if (!shown) return null;
  const keep = () => {
    setShown(false);
    void savePref(prefKey(bot.id), '1');
  };
  return (
    <View key={fontKey} style={styles.card}>
      <View style={styles.head}>
        <BotAvatar bot={bot} size={28} animate={false} />
        <Text style={styles.text}>{t('bots.thread.nameHint', { name: bot.name })}</Text>
      </View>
      <View style={styles.actions}>
        <NativeButton label={t('bots.thread.nameHintRename')} size="small" onPress={() => onRename(bot.id)} />
        <NativeButton label={t('bots.thread.nameHintKeep', { name: bot.name })} size="small" onPress={keep} />
      </View>
    </View>
  );
});

const useStyles = makeStyles((c) => ({
  card: {
    marginHorizontal: space.margin,
    marginBottom: space.md,
    padding: space.md,
    gap: space.sm + 2,
    borderRadius: radius.lg,
    backgroundColor: c.tertiaryFill,
    ...squircle,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm + 2 },
  text: { flex: 1, ...typo.subheadline, color: c.label },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
}));
