/** The colour row of an Agent's look: the chosen plant in each colour (its own first), the pick ringed in the accent. */

import React from 'react';
import { Pressable, View } from 'react-native';
import { useT } from '../lib/i18n';
import { makeStyles, space, useTheme } from '../theme';
import { AgentAvatar } from '../ui/agent-avatar';
import { PLANT_TINTS, type PlantId, type PlantTint } from '../ui/plant-avatar/plant-ids';

/** A swatch's plant (pt); the ring around it adds 2 × (gap + width). */
const SWATCH = 32;

export function TintSwatches({
  plant,
  stableId,
  tint,
  onChange,
}: {
  plant: PlantId;
  stableId: string;
  tint: PlantTint;
  onChange: (tint: PlantTint) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  return (
    <View style={styles.swatches} accessibilityRole="radiogroup" accessibilityLabel={t('agents.tint')}>
      {PLANT_TINTS.map((id) => {
        const selected = id === tint;
        return (
          <Pressable
            key={id}
            onPress={() => onChange(id)}
            accessibilityRole="radio"
            accessibilityLabel={t(`agents.tintName.${id}`)}
            accessibilityState={{ selected }}
            hitSlop={4}
            style={({ pressed }) => [styles.swatch, selected && { borderColor: c.accent }, pressed && { opacity: 0.6 }]}
          >
            <AgentAvatar agent={{ id: stableId, avatar: { plant, tint: id }, template_key: null }} size={SWATCH} animate={false} />
          </Pressable>
        );
      })}
    </View>
  );
}

const useStyles = makeStyles(() => ({
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs + 2, paddingVertical: space.xs },
  swatch: { padding: 2, borderRadius: SWATCH, borderWidth: 2, borderColor: 'transparent' },
}));
