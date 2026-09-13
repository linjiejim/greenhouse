/**
 * Drive upload policy — server-side gate on what may be uploaded.
 *
 * Deny-list approach: a cloud drive must accept arbitrary documents (pdf/office/
 * images/zip/cad/…), so we block executable + active-content extensions and MIME
 * declarations rather than allow-listing. Downloads are also forced to attachments
 * so uploaded bytes cannot become active content in the application's origin.
 */

export const MAX_DRIVE_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

const BLOCKED_EXTENSIONS = new Set([
  'exe',
  'msi',
  'app',
  'deb',
  'rpm',
  'dmg',
  'pkg',
  'bat',
  'cmd',
  'com',
  'scr',
  'ps1',
  'vbs',
  'wsf',
  'sh',
  'bash',
  'zsh',
  'jar',
  'dll',
  'so',
  'js',
  'mjs',
  'cjs',
  'html',
  'htm',
  'xhtml',
  'svg',
]);

const BLOCKED_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
  'application/ecmascript',
  'text/ecmascript',
]);

const SAFE_CONTENT_TYPES_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  txt: 'text/plain',
  csv: 'text/csv',
  pdf: 'application/pdf',
};

export interface DriveUploadCandidate {
  name: string;
  size: number;
  content_type?: string | null;
}

export type DriveUploadValidation = { ok: true } | { ok: false; error: string };

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function normalizeContentType(contentType: string | null | undefined): string {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

/** Derive storage/response metadata from the server-validated filename only. */
export function safeDriveContentType(name: string): string {
  return SAFE_CONTENT_TYPES_BY_EXTENSION[extensionOf(name)] ?? 'application/octet-stream';
}

export function validateDriveUpload(file: DriveUploadCandidate): DriveUploadValidation {
  const name = file.name?.trim() ?? '';
  if (!name) return { ok: false, error: '文件名不能为空' };
  if (name.length > 255) return { ok: false, error: '文件名过长' };
  if (name.includes('/') || name.includes('\\')) return { ok: false, error: '文件名不能包含路径分隔符' };

  if (!Number.isFinite(file.size) || file.size < 0) return { ok: false, error: '文件大小无效' };
  if (file.size > MAX_DRIVE_FILE_SIZE) {
    return { ok: false, error: `文件过大：上限 ${Math.round(MAX_DRIVE_FILE_SIZE / 1024 / 1024)}MB` };
  }

  if (BLOCKED_EXTENSIONS.has(extensionOf(name))) {
    return { ok: false, error: '出于安全考虑，不支持上传可执行文件或脚本' };
  }

  if (BLOCKED_CONTENT_TYPES.has(normalizeContentType(file.content_type))) {
    return { ok: false, error: '出于安全考虑，不支持上传活动内容' };
  }

  return { ok: true };
}
