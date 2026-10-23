/**
 * Upload to Files from the phone: pick from the photo library, take a photo, or pick from Files,
 * then send through the three-step drive upload (../api/drive.ts `uploadFile`). Bytes stream from
 * disk with the native uploader; the access token rides only to the active station.
 */

import * as DocumentPicker from 'expo-document-picker';
import { File, UploadType } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { uploadFile, type FilesShelf, type UploadSource } from '../api/drive';
import { getAccessToken } from '../api/token-storage';

export type UploadFrom = 'photos' | 'camera' | 'files';

async function putBytes(url: string, uri: string, headers: Record<string, string>): Promise<number> {
  const result = await new File(uri).upload(url, { httpMethod: 'PUT', uploadType: UploadType.BINARY_CONTENT, headers });
  return result.status;
}

function nameOf(uri: string, fallback: string): string {
  const last = decodeURIComponent(uri.split('/').pop() ?? '').split('?')[0];
  return last && last.includes('.') ? last : fallback;
}

/** What the member picked, as upload sources; empty when they cancelled. */
export async function pick(from: UploadFrom): Promise<UploadSource[]> {
  if (from === 'files') {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (result.canceled) return [];
    return result.assets.map((asset) => ({
      uri: asset.uri,
      name: asset.name,
      size: asset.size ?? new File(asset.uri).size ?? 0,
      type: asset.mimeType ?? null,
    }));
  }
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images', 'videos'], quality: 1, allowsMultipleSelection: from === 'photos' };
  if (from === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new Error('camera_denied');
  }
  const result = from === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  if (result.canceled) return [];
  return result.assets.map((asset, index) => ({
    uri: asset.uri,
    name: asset.fileName || nameOf(asset.uri, `photo-${Date.now()}-${index}.jpg`),
    size: asset.fileSize ?? new File(asset.uri).size ?? 0,
    type: asset.mimeType ?? null,
  }));
}

/** Upload each source; the number that made it and the first failure's words. */
export async function uploadAll(
  target: { shelf: FilesShelf; folderId: number | null },
  sources: UploadSource[],
): Promise<{ done: number; failed: number; error: string }> {
  let done = 0;
  let failed = 0;
  let error = '';
  for (const source of sources) {
    const result = await uploadFile(target, source, putBytes, () => {
      const token = getAccessToken();
      return token ? `Bearer ${token}` : null;
    });
    if (result.ok) done += 1;
    else {
      failed += 1;
      error ||= result.message;
    }
  }
  return { done, failed, error };
}
