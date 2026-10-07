/**
 * Conversation starters under a Bot's greeting (its template's, in the app's
 * language) — while the greeting is still the last word. A tap only
 * *prefills* the composer and focuses it (D24): the member edits and sends.
 */

import React, { memo } from 'react';
import { Text, View } from 'react-native';
import { useT } from '../../../lib/i18n';
import { makeStyles, space, typo, useTheme } from '../../../theme';
import { NativeButton } from '../../../ui/button';

export const Starters = memo(function Starters({
  starters,
  onPick,
}: {
  starters: readonly string[];
  onPick: (text: string) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  if (!starters.length) return null;
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>{t('bots.thread.startersTitle')}</Text>
      <View style={styles.chips}>
        {starters.map((starter) => (
          <NativeButton key={starter} label={starter} size="small" onPress={() => onPick(starter)} />
        ))}
      </View>
    </View>
  );
});

const useStyles = makeStyles((c) => ({
  wrap: { paddingHorizontal: space.margin, paddingTop: space.xs, paddingBottom: space.md, gap: space.sm },
  title: { ...typo.footnote, color: c.secondaryLabel },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
}));
