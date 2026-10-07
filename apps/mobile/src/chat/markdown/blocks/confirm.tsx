/**
 * ```confirm fenced block — the agent asks before acting ({ text, actions:
 * [{ label, value, variant? }] }). Each action is a native button (primary →
 * prominent, destructive → red); a tap sends its `value` as the user's next
 * message, once. Answered (now, or — after a reload — when the message that
 * followed this reply is one of the values), the buttons settle into static
 * capsules with the pick checked. Inert outside a conversation you own (read-
 * only shares, knowledge pages). Web parity: ConfirmBlock.
 */
import { useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ConfirmData } from '../../../shared/rich-output';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../../theme';
import { NativeButton } from '../../../ui/button';
import { Icon } from '../../../ui/core';
import { useRich } from '../context';
import { richSegment } from '../rich';
import { CodeBlock } from './code';

export function ConfirmBlock({ raw }: { raw: string }) {
  const seg = useMemo(() => richSegment('confirm', raw), [raw]);
  if (seg?.type !== 'confirm') return <CodeBlock lang="confirm" code={raw} />;
  return <Confirm data={seg.data} />;
}

function Confirm({ data }: { data: ConfirmData }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const { reply, followUp } = useRich();
  const [picked, setPicked] = useState<string | null>(null);
  const sending = useRef(false);
  const persisted = data.actions.some((a) => a.value === followUp?.trim()) ? followUp!.trim() : null;
  const chosen = persisted ?? picked;

  const choose = async (value: string) => {
    if (!reply || chosen || sending.current) return;
    sending.current = true;
    const ok = await reply(value);
    sending.current = false;
    if (ok) setPicked(value);
  };

  return (
    <View style={[styles.card, chosen ? styles.cardDone : styles.cardOpen]}>
      <Text style={[styles.text, chosen ? styles.textDone : null]} selectable>
        {data.text}
      </Text>
      <View style={styles.actions}>
        {data.actions.map((a) =>
          chosen ? (
            <View key={a.value} style={[styles.chip, a.value === chosen ? styles.chipOn : styles.chipOff]}>
              {a.value === chosen ? <Icon name="check" size={12} weight="semibold" color={c.accentText} /> : null}
              <Text style={[styles.chipText, a.value === chosen ? styles.chipTextOn : styles.chipTextOff]}>{a.label}</Text>
            </View>
          ) : (
            <NativeButton
              key={a.value}
              label={a.label}
              size="small"
              variant={a.variant === 'primary' ? 'prominent' : 'tinted'}
              destructive={a.variant === 'destructive'}
              disabled={!reply}
              onPress={() => void choose(a.value)}
            />
          ),
        )}
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  card: {
    marginVertical: space.sm + 2,
    padding: space.md + 2,
    gap: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    ...squircle,
  },
  cardOpen: { borderColor: c.accent },
  cardDone: { borderColor: c.separator },
  text: { ...typo.body, color: c.label },
  textDone: { color: c.secondaryLabel },
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
