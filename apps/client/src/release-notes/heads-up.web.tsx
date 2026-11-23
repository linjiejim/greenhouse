/** A release's heads-up group in the browser: the shared warning Callout (DESIGN.md Components, Notes). */
import React from 'react';
import { Text } from 'react-native';
import { typo, useTheme, weight } from '../theme';
import { Callout } from '../ui/callout.web';

export function HeadsUp({ title, children }: { title: string; children: React.ReactNode }) {
  const { colors: c } = useTheme();
  return (
    <Callout tone="warning">
      <Text style={{ ...typo.subheadline, fontWeight: weight.semibold, color: c.label }} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </Callout>
  );
}
