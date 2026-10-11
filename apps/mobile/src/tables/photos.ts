/**
 * A photo for an attachment field — from the camera or the library, downscaled
 * like a chat image (≤1024px, src/api/upload.ts `prepareImage`), ready for a
 * multipart upload (`/api/forms/:id/uploads`, `/api/apps/:id/uploads`). The
 * camera asks once; after a "Don't Allow" the way back is Settings (the same
 * prompt as the chat composer). Null = cancelled or refused.
 */

import { Linking } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { prepareImage } from '../api/upload';
import type { UploadFile } from '../api/tables';
import { t } from '../lib/i18n';
import { confirmAction } from '../ui/dialogs';

export async function pickPhoto(from: 'camera' | 'library'): Promise<UploadFile | null> {
  let asset: ImagePicker.ImagePickerAsset | undefined;
  if (from === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      const go = await confirmAction({
        title: t('tables.forms.cameraDenied'),
        message: t('tables.forms.cameraDeniedHint'),
        confirmLabel: t('tables.forms.openSettings'),
      });
      if (go) void Linking.openSettings();
      return null;
    }
    const res = await ImagePicker.launchCameraAsync({ quality: 0.9 });
    asset = res.canceled ? undefined : res.assets[0];
  } else {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9 });
    asset = res.canceled ? undefined : res.assets[0];
  }
  if (!asset) return null;
  const uri = await prepareImage(asset.uri, asset.width);
  const resized = uri !== asset.uri;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return {
    uri,
    // a resized photo is a JPEG; an untouched one keeps its own type and name
    name: resized || !asset.fileName ? `photo-${stamp}.jpg` : asset.fileName,
    type: resized ? 'image/jpeg' : (asset.mimeType ?? 'image/jpeg'),
  };
}
