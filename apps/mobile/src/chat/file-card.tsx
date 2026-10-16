/**
 * Files in a conversation — everything that downloads through an
 * authenticated endpoint (a plain link would carry no bearer token):
 *
 *  - `FileCard` — a deliverable in a reply: an export (`export_data` /
 *    `export_table` tool result), a Cloud Agent artifact (```mission-artifacts).
 *    Icon by type, name, a detail line (size · rows / its path), tap to get it.
 *  - `AttachmentChip` — a file the user attached to a turn (the ```attachments
 *    fence in a user message): a lighter capsule, same tap.
 *  - `saveFile(path, name)` opens /file-preview: authenticated cache download,
 *    native Quick Look on iOS, with explicit share/save and unsupported fallback.
 *    Markdown links and computer files share this entry point.
 */
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { formatBytes } from '../lib/format';

import { useFontScaleKey } from '../ui/font-scale';
import { HIT, makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { Icon, type IconName, Touchable } from '../ui/core';

/** Both chat and computer files use the same authenticated preview route. */
export function saveFile(path: string, name: string): void {
  router.push({ pathname: '/file-preview', params: { path, name: name.trim() || 'download' } });
}

const ext = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';

export function fileIcon(name: string): IconName {
  const e = ext(name);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'avif', 'svg'].includes(e)) return 'image';
  if (['csv', 'tsv', 'xls', 'xlsx', 'numbers'].includes(e)) return 'table';
  if (['html', 'htm', 'js', 'ts', 'json', 'py', 'css', 'sh'].includes(e)) return 'code';
  if (['zip', 'tar', 'gz'].includes(e)) return 'archive';
  return 'file';
}

/** "12.1 KB · 30 行" — whatever is known. */
export function fileDetail(size?: number, extra?: string): string | undefined {
  const parts = [size != null ? formatBytes(size) : null, extra ?? null].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

export function FileCard({ name, detail, path }: { name: string; detail?: string; path: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const fontKey = useFontScaleKey();
  const large = Number(fontKey) >= 1.5;
  return (
    <Touchable
      onPress={() => saveFile(path, name)}
      style={styles.card}
      accessibilityRole="button"
      accessibilityLabel={`${name}${detail ? `, ${detail}` : ''}`}
    >
      <View style={styles.tile}>
        <Icon name={fileIcon(name)} size={18} color={c.accent} />
      </View>
      <View key={fontKey} style={styles.texts}>
        <Text numberOfLines={large ? 0 : 1} ellipsizeMode="middle" style={styles.name}>
          {name}
        </Text>
        {detail ? (
          <Text numberOfLines={large ? 0 : 1} ellipsizeMode="middle" style={styles.detail}>
            {detail}
          </Text>
        ) : null}
      </View>
      <Icon name="chevR" size={17} weight="medium" color={c.accent} />
    </Touchable>
  );
}

export function AttachmentChip({ name, size, path }: { name: string; size?: number; path: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const fontKey = useFontScaleKey();
  const large = Number(fontKey) >= 1.5;
  return (
    <Touchable
      onPress={() => saveFile(path, name)}
      style={[styles.chip, large && { flexWrap: 'wrap' }]}
      accessibilityRole="button"
      accessibilityLabel={name}
    >
      <Icon name={fileIcon(name) === 'image' ? 'image' : 'attach'} size={13} color={c.secondaryLabel} />
      <Text key={fontKey} numberOfLines={large ? 0 : 1} ellipsizeMode="middle" style={styles.chipName}>
        {name}
      </Text>
      {size != null ? <Text style={styles.chipSize}>{formatBytes(size)}</Text> : null}
    </Touchable>
  );
}

const useStyles = makeStyles((c) => ({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm + 2,
    paddingLeft: space.sm + 2,
    paddingRight: space.md + 2,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.separator,
    ...squircle,
  },
  tile: {
    width: 38,
    height: 38,
    borderRadius: radius.sm + 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentFill,
    ...squircle,
  },
  texts: { flex: 1, minWidth: 0 },
  name: { ...typo.subheadline, fontWeight: weight.semibold, color: c.label },
  detail: { ...typo.footnote, color: c.secondaryLabel, marginTop: 1 },
  chip: {
    minHeight: HIT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 1,
    maxWidth: '100%',
    paddingVertical: space.xs + 1,
    paddingHorizontal: space.sm + 2,
    borderRadius: radius.full,
    backgroundColor: c.tertiaryFill,
  },
  chipName: { ...typo.footnote, color: c.label, flexShrink: 1 },
  chipSize: { ...typo.caption1, color: c.secondaryLabel },
}));
