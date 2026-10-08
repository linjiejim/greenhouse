/**
 * Conversation starters under a Bot's greeting (its template's, in the app's
 * language) — while the greeting is still the last word. Chips only, no
 * heading. A tap only *prefills* the composer and focuses it (D24): the
 * member edits and sends.
 */

import React, { memo } from 'react';
import { View } from 'react-native';
import { makeStyles, space, useTheme } from '../../../theme';
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
  if (!starters.length) return null;
  return (
    <View style={styles.chips}>
      {starters.map((starter) => (
        <NativeButton key={starter} label={starter} size="small" onPress={() => onPick(starter)} />
      ))}
    </View>
  );
});

const useStyles = makeStyles(() => ({
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    paddingHorizontal: space.margin,
    paddingTop: space.xs,
    paddingBottom: space.md,
  },
}));
