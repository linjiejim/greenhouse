/**
 * A file's type as an icon (src/lib/file-kind.ts): PDF, document, spreadsheet, slides, image,
 * video, audio, archive, code, text or other. `tile` draws it on a tinted rounded square (list
 * rows, file cards); without it the bare glyph sits in a chip or a line of text.
 */

import React from 'react';
import { View, type ColorValue } from 'react-native';
import { fileKind, type FileKind } from '../lib/file-kind';
import { radius, squircle, useTheme, type ThemeColors } from '../theme';
import { Icon, type IconName } from './core';

const ICON: Record<FileKind, IconName> = {
  pdf: 'pdf',
  doc: 'file',
  sheet: 'sheet',
  slides: 'slides',
  image: 'image',
  video: 'video',
  audio: 'audio',
  archive: 'archive',
  code: 'code',
  text: 'text',
  other: 'fileOther',
};

/** The tint a kind is known by (red PDFs, green sheets, orange slides …); the accent otherwise. */
function tintOf(kind: FileKind, c: ThemeColors): ColorValue {
  switch (kind) {
    case 'pdf':
      return c.red;
    case 'sheet':
      return c.green;
    case 'slides':
      return c.orange;
    case 'doc':
    case 'text':
      return c.blue;
    case 'image':
    case 'video':
      return c.purple;
    default:
      return c.accent;
  }
}

export function fileIconName(name: string, contentType?: string | null): IconName {
  return ICON[fileKind(name, contentType)];
}

export function FileIcon({
  name = '',
  contentType,
  kind: known,
  size = 18,
  tile = false,
}: {
  name?: string;
  contentType?: string | null;
  /** A kind known without a file name (a knowledge document is a `doc`). */
  kind?: FileKind;
  /** The glyph size; a tile is this plus its padding. */
  size?: number;
  tile?: boolean;
}) {
  const { colors: c } = useTheme();
  const kind = known ?? fileKind(name, contentType);
  const glyph = <Icon name={ICON[kind]} size={size} color={tintOf(kind, c)} />;
  if (!tile) return glyph;
  const box = Math.round(size * 1.75);
  return (
    <View
      style={[
        squircle,
        {
          width: box,
          height: box,
          borderRadius: radius.sm,
          backgroundColor: c.tertiaryFill,
          alignItems: 'center',
          justifyContent: 'center',
        },
      ]}
    >
      {glyph}
    </View>
  );
}
