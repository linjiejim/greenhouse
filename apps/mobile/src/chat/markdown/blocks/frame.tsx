/**
 * Shared frames for the custom fence blocks:
 *  - `BlockBoundary` — blocks render model-authored data; one that throws
 *    shows its source as code instead of taking the conversation down (web
 *    parity: RichMarkdown's per-block boundary).
 *  - `PendingBlock` — a rich fence whose closing ``` hasn't streamed in yet:
 *    a quiet placeholder card instead of half-written JSON / HTML.
 */
import { Component, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useT, type TranslationKey } from '../../../lib/i18n';
import { makeStyles, radius, space, squircle, typo, useTheme } from '../../../theme';
import { Spinner } from '../../../ui/core';

export class BlockBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const PENDING_LABEL: Record<string, TranslationKey> = {
  chart: 'chat.pendingChart',
  datatable: 'chat.pendingTable',
  stats: 'chat.pendingStats',
  cards: 'chat.pendingCards',
  steps: 'chat.pendingSteps',
  mermaid: 'chat.pendingDiagram',
  'html-preview': 'chat.pendingPage',
};

export function PendingBlock({ lang }: { lang: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  return (
    <View style={styles.wrap} accessible accessibilityRole="progressbar">
      <Spinner />
      <Text style={styles.label}>{t(PENDING_LABEL[lang] ?? 'chat.pendingBlock')}</Text>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 64,
    marginVertical: space.sm + 2,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.separator,
    ...squircle,
  },
  label: { ...typo.subheadline, color: c.secondaryLabel },
}));
