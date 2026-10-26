import { api } from '../api/client';
import { getTokenStationId } from '../api/token-storage';
import { fileNameFrom } from './file-download';
import type { CachedFile } from './share-file';
export function fileStem(name: string | undefined, fallback: string) {
  return (name || fallback).replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 100);
}
export async function shareTextFile(name: string, text: string, type: string): Promise<boolean> {
  try {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

/** Each preview owns its Blob URL; no credentials enter the sandboxed viewer. */
export async function downloadFile(path: string, fallbackName = 'download', signal?: AbortSignal): Promise<CachedFile> {
  const station = getTokenStationId();
  const response = await api(path, { signal });
  if (!response.ok) throw Object.assign(new Error('download_failed'), { status: response.status });
  const blob = await response.blob();
  if (signal?.aborted || station !== getTokenStationId()) throw new Error('download_cancelled');
  const name = fileNameFrom(response.headers.get('content-disposition'), fallbackName).replace(/[\\/]/g, '_');
  const text =
    /\.(txt|md|csv|tsv|json|log|yaml|yml|js|ts|css|py|sh)$/i.test(name) || blob.type.startsWith('text/plain')
      ? await blob.text()
      : undefined;
  if (signal?.aborted || station !== getTokenStationId()) throw new Error('download_cancelled');
  const uri = URL.createObjectURL(blob);
  return {
    uri,
    name,
    mimeType: blob.type,
    previewText: text?.slice(0, 50000),
    previewTruncated: text !== undefined && text.length > 50000,
    dispose: () => URL.revokeObjectURL(uri),
  };
}

/** Browser counterpart of the native share sheet: download the already authenticated Blob. */
export async function shareCachedFile(file: CachedFile): Promise<void> {
  const link = document.createElement('a');
  link.href = file.uri;
  link.download = file.name;
  link.click();
}
