/**
 * A link as a chip inside a line of text (rules in src/lib/link-chip.ts): an object's type icon
 * and title, a file's icon, name and size, or a site's domain. One line; long names are cut in
 * the middle so a file keeps its extension. Tapping opens the object as a sheet, the file in
 * Quick Look, the site in the in-app Safari view.
 */

import React from 'react';
import { Text, View } from 'react-native';
import { formatBytes } from '../lib/format';
import { classifyLink, type LinkChip as Chip, type ObjectType } from '../lib/link-chip';
import { useT, type TranslationKey } from '../lib/i18n';
import { openLink } from '../lib/links';
import { useOpenObject, useOpenTarget } from '../shell/open-object';
import { useLinkRef } from '../store/refs';
import { getApiBase } from '../store/stations';
import { makeStyles, radius, space, typo, useTheme, weight } from '../theme';
import { Icon, Touchable, type IconName } from '../ui/core';
import { FileIcon } from '../ui/file-icon';

const TYPE_ICON: Record<ObjectType, IconName> = {
  doc: 'file',
  file: 'fileOther',
  folder: 'folder',
  project: 'checklist',
  task: 'checkCircle',
  record: 'table',
  table: 'table',
  chat: 'msg',
  page: 'globe',
};

const TYPE_LABEL: Record<ObjectType, TranslationKey> = {
  doc: 'links.doc',
  file: 'links.file',
  folder: 'links.folder',
  project: 'links.project',
  task: 'links.task',
  record: 'links.record',
  table: 'links.table',
  chat: 'links.chat',
  page: 'links.page',
};

/** The chip for a link, or null when it stays a plain text link. */
export type ChipLink = Exclude<Chip, { kind: 'plain' }>;

export function chipFor(href: string, label: string | undefined): ChipLink | null {
  const chip = classifyLink(href, label, getApiBase());
  return chip.kind === 'plain' ? null : chip;
}

export function LinkChip({ chip }: { chip: ChipLink }) {
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const openObject = useOpenObject();
  const openTarget = useOpenTarget();
  const info = useLinkRef(chip.kind === 'site' ? '' : chip.resolveUrl);

  let icon: React.ReactNode;
  let text: string;
  let tail = '';
  let onPress: () => void;
  if (chip.kind === 'site') {
    icon = <Icon name="globe" size={13} color={c.secondaryLabel} />;
    text = chip.label ? `${chip.domain} · ${chip.label}` : chip.domain;
    onPress = () => void openLink(chip.url, hex.accent);
  } else if (chip.kind === 'file') {
    const name = info?.title ?? chip.label ?? t('links.file');
    icon = <FileIcon name={name} contentType={info?.contentType} size={13} />;
    text = name;
    tail = info?.size != null ? formatBytes(info.size) : '';
    onPress = () =>
      chip.path.startsWith('/api/drive/')
        ? openObject({ kind: 'file', id: Number(chip.id), name })
        : openObject({ kind: 'attachment', path: chip.path, name });
  } else {
    icon = <Icon name={TYPE_ICON[chip.type]} size={13} color={c.accentText} />;
    // a title the station gave, else the link's words; only the type when it is not mine to see
    text = info ? (info.title ?? t(TYPE_LABEL[chip.type])) : (chip.label ?? t(TYPE_LABEL[chip.type]));
    onPress = () => openTarget(chip.target);
  }

  return (
    <View style={styles.wrap}>
      <Touchable
        onPress={onPress}
        style={[styles.chip, chip.kind === 'object' ? styles.object : styles.other]}
        accessibilityRole="link"
        accessibilityLabel={tail ? `${text}, ${tail}` : text}
      >
        {icon}
        <Text numberOfLines={1} ellipsizeMode="middle" style={[styles.text, chip.kind === 'object' && styles.objectText]}>
          {text}
        </Text>
        {tail ? <Text style={styles.tail}>{tail}</Text> : null}
      </Touchable>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  // sits on the text's baseline like a word; never wider than most of the column
  wrap: { maxWidth: 280, transform: [{ translateY: 4 }] },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: space.xxs,
    borderRadius: radius.sm,
  },
  object: { backgroundColor: c.accentFill },
  other: { backgroundColor: c.tertiaryFill },
  text: { ...typo.subheadline, color: c.label, flexShrink: 1 },
  objectText: { color: c.accentText, fontWeight: weight.semibold },
  tail: { ...typo.caption1, color: c.secondaryLabel },
}));
