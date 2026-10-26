import React from 'react';
import { Text } from 'react-native';
import { GreetingSprout } from '../ui/greeting-sprout';
import { makeStyles, space, typo, useTheme } from '../theme';
export function GreetingTitle({ label, assistantLabel }: { label: string; assistantLabel: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <>
      <GreetingSprout size={88} accessibilityLabel={assistantLabel} style={styles.hero} />
      <Text style={styles.greeting} accessibilityRole="header">
        {label}
      </Text>
    </>
  );
}
const useStyles = makeStyles((c) => ({
  hero: { alignSelf: 'flex-start', marginHorizontal: space.margin + space.xs, marginBottom: space.md },
  greeting: { ...typo.title1, color: c.label, marginHorizontal: space.margin + space.xs },
}));
