/**
 * What kind of file a name (and its content type) is, for its icon. React-free
 * (./file-kind.test.ts).
 */

export type FileKind = 'pdf' | 'doc' | 'sheet' | 'slides' | 'image' | 'video' | 'audio' | 'archive' | 'code' | 'text' | 'other';

const BY_EXT: Record<string, FileKind> = {};
const add = (kind: FileKind, exts: string) => exts.split(' ').forEach((ext) => (BY_EXT[ext] = kind));
add('pdf', 'pdf');
add('doc', 'doc docx pages rtf odt');
add('sheet', 'xls xlsx csv tsv numbers ods');
add('slides', 'ppt pptx key odp');
add('image', 'png jpg jpeg gif webp heic heif bmp avif svg tif tiff');
add('video', 'mp4 mov m4v avi mkv webm');
add('audio', 'mp3 m4a wav aac flac ogg opus');
add('archive', 'zip rar 7z tar gz tgz bz2 xz');
add('code', 'js ts tsx jsx json py rb go rs java kt swift c h cpp cs php sh sql html htm css xml yaml yml');
add('text', 'txt md markdown log');

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

export function fileKind(name: string, contentType?: string | null): FileKind {
  const byExt = BY_EXT[extensionOf(name)];
  if (byExt) return byExt;
  const type = (contentType ?? '').toLowerCase();
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('text/')) return 'text';
  if (/zip|compressed|tar/.test(type)) return 'archive';
  if (/spreadsheet|excel|csv/.test(type)) return 'sheet';
  if (/presentation|powerpoint/.test(type)) return 'slides';
  if (/word|document/.test(type)) return 'doc';
  return 'other';
}
