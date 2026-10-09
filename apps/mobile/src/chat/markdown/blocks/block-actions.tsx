/**
 * The buttons under a Rich Output block — ```confirm, ```stats, ```cards,
 * ```steps share them (web parity: @greenhouse/ui BlockActions). Each action is
 * a native button (primary → prominent, destructive → red); a tap sends its
 * `value` as the user's next message, once. Answered (now, or — after a reload
 * — when the message that followed this reply is one of the values), the
 * buttons settle into static capsules with the pick checked. Inert outside a
 * conversation you own (read-only shares, knowledge pages).
 */
import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { resolveBlockAction, type BlockAction } from '../../../shared/rich-output';
import { makeStyles, radius, space, typo, useTheme, weight } from '../../../theme';
import { NativeButton } from '../../../ui/button';
import { Icon } from '../../../ui/core';
import { useRich } from '../context';

/** Which value was chosen (persisted follow-up first, then this session's tap). */
export function useBlockChoice(actions: readonly BlockAction[]) {
  const { reply, followUp } = useRich();
  const [picked, setPicked] = useState<string | null>(null);
  const sending = useRef(false);
  const persisted = resolveBlockAction(actions, followUp);
  const chosen = persisted ?? picked;

  const choose = async (value: string) => {
    if (!reply || chosen || sending.current) return;
    sending.current = true;
    const ok = await reply(value);
    sending.current = false;
    if (ok) setPicked(value);
  };

  return { chosen, choose, live: Boolean(reply) };
}

export function BlockActions({ actions }: { actions: readonly BlockAction[] }) {
  const choice = useBlockChoice(actions);
  return <BlockActionsView actions={actions} {...choice} />;
}

/** The row itself, for blocks (confirm) that also restyle around the choice. */
export function BlockActionsView({
  actions,
  chosen,
  choose,
  live,
}: {
  actions: readonly BlockAction[];
  chosen: string | null;
  choose: (value: string) => Promise<void>;
  live: boolean;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={styles.actions}>
      {actions.map((a) =>
        chosen ? (
          <View key={a.value} style={[styles.chip, a.value === chosen ? styles.chipOn : styles.chipOff]}>
            {a.value === chosen ? <Icon name="check" size={12} weight="semibold" color={c.accentText} /> : null}
            <Text style={[styles.chipText, a.value === chosen ? styles.chipTextOn : styles.chipTextOff]}>
              {a.label}
            </Text>
          </View>
        ) : (
          <NativeButton
            key={a.value}
            label={a.label}
            size="small"
            variant={a.variant === 'primary' ? 'prominent' : 'tinted'}
            destructive={a.variant === 'destructive'}
            disabled={!live}
            onPress={() => void choose(a.value)}
          />
        ),
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    borderRadius: radius.full,
  },
  chipOn: { backgroundColor: c.accentFill },
  chipOff: { backgroundColor: c.quaternaryFill },
  chipText: { ...typo.footnote, fontWeight: weight.semibold },
  chipTextOn: { color: c.accentText },
  chipTextOff: { color: c.tertiaryLabel },
}));
