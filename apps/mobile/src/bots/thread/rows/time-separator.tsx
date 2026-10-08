/**
 * A Messages-style time separator: "**Today** 09:12", "**Yesterday** 18:40",
 * "**Fri, Oct 3** 14:02" (the year too when it isn't this one) — the day part
 * in semibold, in the app's language (where it goes is ../thread-rows.ts).
 */

import React, { memo } from 'react';
import { Text, View } from 'react-native';
import { useLocale, useT } from '../../../lib/i18n';
import { makeStyles, space, typo, useTheme, weight } from '../../../theme';
import { useFontScaleKey } from '../../../ui/font-scale';
import { separatorDay } from '../thread-rows';

export const TimeSeparator = memo(function TimeSeparator({ at }: { at: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  // keyed on the text size: re-measures when Dynamic Type changes (src/ui/font-scale.ts)
  const fontKey = useFontScaleKey();
  const t = useT();
  const locale = useLocale();
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  const when = new Date(ms);
  const form = separatorDay(ms, Date.now());
  const day =
    form === 'today'
      ? t('bots.thread.today')
      : form === 'yesterday'
        ? t('bots.thread.yesterday')
        : when.toLocaleDateString(locale, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            year: form === 'dateYear' ? 'numeric' : undefined,
          });
  const time = when.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  return (
    <View key={fontKey} style={styles.wrap}>
      <Text style={styles.text}>
        <Text style={styles.day}>{day}</Text> {time}
      </Text>
    </View>
  );
});

const useStyles = makeStyles((c) => ({
  wrap: { alignItems: 'center', paddingTop: space.md, paddingBottom: space.xs },
  text: { ...typo.caption1, color: c.secondaryLabel },
  day: { fontWeight: weight.semibold },
}));
