import { api, networkMiss, toResult, type ApiResult } from './client';
export type { UploadedImage, ChatFile } from './chat-files';
import type { UploadedImage, ChatFile } from './chat-files';
/** File picker object URLs are read as bytes by the browser, never native URI descriptors. */
export async function prepareImage(
  uri: string,
  _width?: number,
  _height?: number,
): Promise<{ uri: string; scaled: boolean }> {
  try {
    const image = new Image();
    image.src = uri;
    await image.decode();
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    const context = canvas.getContext('2d');
    if (!context) return { uri, scaled: false };
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return blob ? { uri: URL.createObjectURL(blob), scaled: true } : { uri, scaled: false };
  } catch {
    return { uri, scaled: false };
  }
}
async function upload<T>(path: string, uri: string, session?: string, name?: string): Promise<ApiResult<T>> {
  try {
    const response = await fetch(uri);
    const blob = await response.blob();
    const form = new FormData();
    form.append('file', blob, name ?? 'attachment' + (blob.type.startsWith('image/') ? '.jpg' : ''));
    if (session) form.append('session_id', session);
    return await toResult<T>(await api(path, { method: 'POST', body: form }));
  } catch (error) {
    return networkMiss(error);
  }
}
export const uploadImage = (uri: string) => upload<UploadedImage>('/api/upload', uri);
export async function uploadChatFile(session: string, uri: string, name?: string): Promise<ApiResult<ChatFile>> {
  const result = await upload<{ file: ChatFile }>('/api/chat-files/upload', uri, session, name);
  return result.ok ? { ok: true, data: result.data.file } : result;
}
