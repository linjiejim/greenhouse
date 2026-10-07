/**
 * An image-only paragraph (`![alt](src)`, one or several, optionally linked)
 * as thumbnails — web parity with its chat image rows. One image shows at
 * reading width (up to 260 pt, its own aspect ratio); several make a wrapping
 * row of squares. Tap → the image (or the link wrapping it) in the in-app
 * Safari view — pinch to zoom, share, save. Uploads (`/api/upload/…`, e.g. a
 * generate_image result) resolve against the station like the bubbles'
 * attachments. An image that fails to load keeps a quiet placeholder.
 */
import { useState } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { uploadUrl } from '../../../api/upload';
import { useT } from '../../../lib/i18n';
import { openLink } from '../../../lib/links';
import { makeStyles, radius, space, squircle, useTheme } from '../../../theme';
import { Icon, Touchable } from '../../../ui/core';
import type { MdImage } from '../parse';

const SINGLE_W = 260;
const TILE = 112;

const resolve = (src: string) => (src.startsWith('/') ? uploadUrl(src) : src);

export function ImageRow({ images }: { images: MdImage[] }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={styles.row}>
      {images.map((im, i) => (
        <Thumb key={`${i}-${im.src}`} image={im} single={images.length === 1} />
      ))}
    </View>
  );
}

export function Thumb({ image, single }: { image: MdImage; single: boolean }) {
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const [ratio, setRatio] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const uri = resolve(image.src);
  const target = image.href ? resolve(image.href) : uri;
  const size = single
    ? { width: SINGLE_W, maxWidth: '100%' as const, aspectRatio: ratio ?? 4 / 3 }
    : { width: TILE, height: TILE };
  return (
    <Touchable
      onPress={() => {
        if (/^https?:\/\//i.test(target)) void openLink(target, hex.accent).catch(() => {});
      }}
      accessibilityRole="imagebutton"
      accessibilityLabel={image.alt || t('chat.image')}
      style={[styles.thumb, size]}
    >
      {failed ? (
        <View style={styles.broken}>
          <Icon name="image" size={22} color={c.tertiaryLabel} />
        </View>
      ) : (
        <Image
          source={{ uri }}
          style={styles.fill}
          contentFit="cover"
          transition={150}
          onLoad={(e) => {
            const { width, height } = e.source;
            if (single && width > 0 && height > 0) setRatio(Math.max(0.5, Math.min(2.4, width / height)));
          }}
          onError={() => setFailed(true)}
        />
      )}
    </Touchable>
  );
}

const useStyles = makeStyles((c) => ({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs + 2, marginVertical: space.sm },
  thumb: { borderRadius: radius.md, overflow: 'hidden', backgroundColor: c.tertiaryFill, ...squircle },
  fill: { width: '100%', height: '100%' },
  broken: { flex: 1, alignItems: 'center', justifyContent: 'center' },
}));
