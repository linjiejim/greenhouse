/**
 * "Editing Your Message · Cancel" — above the input row while the member edits a task chat's last
 * message (spec 20261011-agent-first-class D23): Send then answers the edited message again
 * instead of adding a new one. Cancel puts back what the composer held before.
 */

import React, { memo } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useT } from '../../lib/i18n';
import { HIT, makeStyles, space, typo, useTheme, weight } from '../../theme';
import { Icon, Touchable } from '../../ui/core';
import { Glass } from '../../ui/glass';

export const EditBar = memo(function EditBar({ onCancel }: { onCancel: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  return (
    <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)} style={styles.wrap}>
      <Glass style={styles.capsule}>
        <Icon name="pen" size={13} weight="medium" color={c.secondaryLabel} />
        <View style={styles.texts} accessible accessibilityHint={t('bots.thread.editHint')}>
          <Text numberOfLines={1} style={styles.text} accessibilityLiveRegion="polite">
            {t('bots.thread.editing')}
          </Text>
        </View>
        <Touchable
          onPress={onCancel}
          pressedStyle={{ opacity: 0.55 }}
          hitSlop={{ top: (HIT - 22) / 2, bottom: (HIT - 22) / 2, left: space.sm, right: space.sm }}
          accessibilityRole="button"
        >
          <Text style={styles.cancel}>{t('common.cancel')}</Text>
        </Touchable>
      </Glass>
    </Animated.View>
  );
});

const useStyles = makeStyles((c) => ({
  wrap: { alignItems: 'center' },
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: HIT - 10,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: (HIT - 10) / 2,
  },
  texts: { flexShrink: 1 },
  text: { ...typo.footnote, color: c.secondaryLabel },
  cancel: { ...typo.footnote, fontWeight: weight.semibold, color: c.accent },
}));
