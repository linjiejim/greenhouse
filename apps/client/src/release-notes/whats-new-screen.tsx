/**
 * What's new (jim-uiux 1.7.0 patterns/updates): this bundle's release notes, newest first. Opened
 * from the notice after an update as a sheet (app/sheets/whats-new.tsx, `since` = the version this
 * device had: only the releases after it; a centered `md` dialog on wide browsers), or from
 * Settings › About (app/me/whats-new.tsx: every release). Each release is a card: its version and
 * date, the one-line summary, then its groups, the heads-up one first in a warning notice. Links
 * read as their words; commit and PR references and release-please's scopes never show (./notes.ts).
 */
import React, { useMemo } from 'react';
import { FlatList, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { useLocalSearchParams } from 'expo-router';
import { useT } from '../lib/i18n';
import { calendarDateLabel } from '../lib/time-words';
import { PreviewContext } from '../markdown/context';
import { Inline } from '../markdown/inline';
import { makeStyles, space, typo, useTheme, weight } from '../theme';
import { EmptyState } from '../ui/empty';
import { Card } from '../ui/list';
import { Screen, SheetScreen } from '../ui/screen';
import { bundledReleases } from './bundled';
import type { Release, ReleaseGroup } from './changelog';
import { HeadsUp } from './heads-up';
import { shownText, shownGroups, shownReleases } from './notes';

export function WhatsNewScreen({ sheet = false }: { sheet?: boolean }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const { since } = useLocalSearchParams<{ since?: string }>();
  const releases = useMemo(() => shownReleases(bundledReleases(), since, Constants.expoConfig?.version), [since]);
  const title = t('whatsNew.title');
  return (
    <>
      {sheet ? <SheetScreen title={title} /> : <Screen title={title} />}
      {/* notes are read here, not followed: a link shows its words */}
      <PreviewContext.Provider value={true}>
        <FlatList
          testID="whats-new"
          style={styles.root}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.content}
          data={releases}
          keyExtractor={(release) => release.version}
          renderItem={({ item }) => <ReleaseCard release={item} />}
          ListEmptyComponent={<EmptyState icon="note" title={t('whatsNew.empty')} />}
        />
      </PreviewContext.Provider>
    </>
  );
}

function ReleaseCard({ release }: { release: Release }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <Card style={styles.card}>
      <View style={styles.heading} accessible accessibilityRole="header">
        <Text style={styles.version}>{release.version}</Text>
        {release.date ? <Text style={styles.date}>{calendarDateLabel(release.date)}</Text> : null}
      </View>
      {release.summary ? (
        <Text style={styles.summary}>
          <Inline text={shownText(release.summary)} />
        </Text>
      ) : null}
      {shownGroups(release).map((group, i) => (
        <Group key={i} group={group} />
      ))}
    </Card>
  );
}

function Group({ group }: { group: ReleaseGroup }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const title = group.kind === 'other' ? group.title : t(`whatsNew.kind.${group.kind}`);
  const items = group.items.map((item, i) => (
    <View key={i} style={styles.item}>
      <Text style={styles.bullet} aria-hidden>
        •
      </Text>
      <Text style={styles.itemText}>
        <Inline text={shownText(item)} />
      </Text>
    </View>
  ));
  if (group.kind === 'heads-up') return <HeadsUp title={title}>{items}</HeadsUp>;
  return (
    <View style={styles.group}>
      {title ? (
        <Text style={styles.groupTitle} accessibilityRole="header">
          {title}
        </Text>
      ) : null}
      {items}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingTop: space.lg, paddingBottom: space.xxxl * 2, gap: space.lg },
  card: { padding: space.lg, gap: space.md },
  heading: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  version: { ...typo.title3, color: c.label },
  date: { ...typo.footnote, color: c.secondaryLabel },
  summary: { ...typo.subheadline, color: c.secondaryLabel },
  group: { gap: space.xs },
  groupTitle: { ...typo.footnote, fontWeight: weight.semibold, color: c.secondaryLabel },
  item: { flexDirection: 'row', gap: space.sm },
  bullet: { ...typo.subheadline, color: c.tertiaryLabel },
  itemText: { ...typo.subheadline, color: c.label, flex: 1 },
}));
