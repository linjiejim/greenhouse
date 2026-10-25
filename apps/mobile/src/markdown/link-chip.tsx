/**
 * A link as a chip inside a line of text (rules in src/lib/link-chip.ts): an object's type icon
 * and title, a file's icon, name and size, or a site's domain. One line; long names are cut in
 * the middle so a file keeps its extension. Tapping opens the object as a sheet, the file in
 * Quick Look, the site in the in-app Safari view.
 */

import React from 'react';
import { formatBytes } from '../lib/format';
import { chipTarget, classifyLink, type LinkChip as LinkTarget, type ObjectType } from '../lib/link-chip';
import { useT, type TranslationKey } from '../lib/i18n';
import { openLink } from '../lib/links';
import { useOpenObject, useOpenTarget } from '../shell/open-object';
import { useLinkRef } from '../store/refs';
import { getApiBase } from '../store/stations';
import { useTheme } from '../theme';
import { Chip } from '../ui/chip';
import { Icon, type IconName } from '../ui/core';
import { FileIcon } from '../ui/file-icon';
import { isObjectId } from '../lib/object-id';

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
export type ChipLink = Exclude<LinkTarget, { kind: 'plain' }>;

export function chipFor(href: string, label: string | undefined): ChipLink | null {
  const chip = classifyLink(href, label, getApiBase());
  return chip.kind === 'plain' ? null : chip;
}

export function LinkChip({ chip }: { chip: ChipLink }) {
  const { colors: c, hex } = useTheme();
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
      chip.path.startsWith('/api/drive/') && isObjectId(chip.id)
        ? openObject({ kind: 'file', id: chip.id, name })
        : openObject({ kind: 'attachment', path: chip.path, name });
  } else {
    icon = <Icon name={TYPE_ICON[chip.type]} size={13} color={c.accentText} />;
    // a title the station gave, else the link's words; only the type when it is not mine to see
    text = info ? (info.title ?? t(TYPE_LABEL[chip.type])) : (chip.label ?? t(TYPE_LABEL[chip.type]));
    onPress = () => openTarget(chipTarget(chip.target, info));
  }

  return <Chip inline icon={icon} label={text} tail={tail} tone={chip.kind === 'object' ? 'accent' : 'neutral'} onPress={onPress} />;
}
