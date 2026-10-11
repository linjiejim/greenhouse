/**
 * An attachment shown as an image — gallery covers, app gallery / kanban
 * covers, record attachments. Attachment values are file ids only, so the image
 * is loaded from the station's authenticated content route (`/api/drive/files/
 * :id/content`, or an app's `/api/apps/:id/files/:fileId?…` for app viewers)
 * with `expo-image` and the bearer token as a header — the token only ever goes
 * to the active station's own origin. A file that is not an image (or that I
 * may not read) fails to decode: the placeholder stays.
 */

import React, { useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { getAccessToken } from '../api/token-storage';
import { getApiBase } from '../store/stations';
import { useTheme } from '../theme';
import { Icon } from '../ui/core';

export function AuthImage({
  path,
  style,
  fit = 'cover',
  accessibilityLabel,
}: {
  /** A station-relative path (`/api/...`); null = no file. */
  path: string | null;
  style?: StyleProp<ViewStyle>;
  fit?: 'cover' | 'contain';
  accessibilityLabel?: string;
}) {
  const { colors: c } = useTheme();
  const [failed, setFailed] = useState<string | null>(null);
  const token = getAccessToken();
  const show = !!path && failed !== path;
  return (
    <View
      style={[
        { backgroundColor: c.tertiaryFill, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
        style,
      ]}
    >
      {show ? (
        <Image
          source={{ uri: `${getApiBase()}${path}`, headers: token ? { Authorization: `Bearer ${token}` } : undefined }}
          contentFit={fit}
          transition={120}
          cachePolicy="memory-disk"
          recyclingKey={path}
          onError={() => setFailed(path)}
          accessibilityLabel={accessibilityLabel}
          style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
        />
      ) : (
        <Icon name="image" size={22} color={c.tertiaryLabel} />
      )}
    </View>
  );
}
