/**
 * ```confirm fenced block — the agent asks before acting ({ text, actions:
 * [{ label, value, variant? }] }). The buttons are the shared BlockActions
 * (./block-actions): a tap sends its `value` as the user's next message, once;
 * once answered the card mutes. Web parity: ConfirmBlock.
 */
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ConfirmData } from '../../../shared/rich-output';
import { makeStyles, radius, space, squircle, typo, useTheme } from '../../../theme';
import { richSegment } from '../rich';
import { BlockActionsView, useBlockChoice } from './block-actions';
import { CodeBlock } from './code';

export function ConfirmBlock({ raw }: { raw: string }) {
  const seg = useMemo(() => richSegment('confirm', raw), [raw]);
  if (seg?.type !== 'confirm') return <CodeBlock lang="confirm" code={raw} />;
  return <Confirm data={seg.data} />;
}

function Confirm({ data }: { data: ConfirmData }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const choice = useBlockChoice(data.actions);

  return (
    <View style={[styles.card, choice.chosen ? styles.cardDone : styles.cardOpen]}>
      <Text style={[styles.text, choice.chosen ? styles.textDone : null]} selectable>
        {data.text}
      </Text>
      <BlockActionsView actions={data.actions} {...choice} />
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
}));
