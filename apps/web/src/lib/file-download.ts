import { authFetch } from './auth';

/**
 * Fetch an authenticated file endpoint as a Blob, for callers that render the
 * bytes themselves (preview) rather than saving them.
 */
export async function fetchAuthenticatedBlob(url: string): Promise<Blob> {
  const response = await authFetch(url);
  if (!response.ok) throw new Error('Download failed');
  return response.blob();
}

/** Download an authenticated file endpoint as a browser attachment. */
export async function downloadAuthenticatedFile(url: string, filename: string): Promise<void> {
  const response = await authFetch(url);
  if (!response.ok) throw new Error('Download failed');
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

/** Human-readable byte size shared by Drive, Tables, EditorJS and Chat files. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
