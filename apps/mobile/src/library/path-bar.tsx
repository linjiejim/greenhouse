/**
 * Where a folder sits: 知识库 › 运营 › 广告复盘. Every level but the last is a button back to
 * that level; the bar scrolls sideways when the path is long and starts scrolled to its end.
 */

import React, { useRef } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { makeStyles, space, typo, useTheme, weight } from '../theme';
import { Icon, Touchable } from '../ui/core';

export function PathBar({ levels, onPick }: { levels: readonly string[]; onPick: (index: number) => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const scroller = useRef<ScrollView>(null);
  return (
    <ScrollView
      ref={scroller}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.bar}
      onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: false })}
      accessibilityRole="toolbar"
    >
      {levels.map((name, index) => {
        const last = index === levels.length - 1;
        return (
          <View key={`${index}-${name}`} style={styles.level}>
            {index > 0 ? <Icon name="chevR" size={11} weight="semibold" color={c.tertiaryLabel} /> : null}
            {last ? (
              <Text style={[styles.name, styles.current]} numberOfLines={1} accessibilityRole="header">
                {name}
              </Text>
            ) : (
              <Touchable onPress={() => onPick(index)} accessibilityRole="button" hitSlop={8}>
                <Text style={[styles.name, styles.link]} numberOfLines={1}>
                  {name}
                </Text>
              </Touchable>
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}

const useStyles = makeStyles((c) => ({
  bar: { paddingHorizontal: space.margin + space.xs, paddingVertical: space.sm, alignItems: 'center' },
  level: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginRight: space.xs },
  name: { ...typo.subheadline, maxWidth: 180 },
  link: { color: c.accent },
  current: { color: c.secondaryLabel, fontWeight: weight.semibold },
}));
