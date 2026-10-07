/**
 * Paths and file types on the member's computer, as the Bot tools name them.
 *
 * A zero-import leaf (node:path only): the `computer` tool, the browser's
 * `upload` (computer/browser-session.ts) and background tasks all resolve a
 * path the model wrote the same way, and browser-session.ts cannot import
 * tools/computer.ts (that imports browser-session.ts).
 */

import { posix } from 'node:path';

export const AGENT_HOME = '/home/agent';
export const AGENT_WORKDIR = '/home/agent/work';

/** Resolve a path the model gave: `~` is the agent's home, relative paths are in ~/work. */
export function resolveAgentPath(raw: string): string {
  const value = raw.trim();
  if (value === '~') return AGENT_HOME;
  if (value.startsWith('~/')) return posix.resolve(AGENT_HOME, value.slice(2));
  return posix.resolve(AGENT_WORKDIR, value);
}

export function isUnderAgentHome(path: string): boolean {
  return path === AGENT_HOME || path.startsWith(`${AGENT_HOME}/`);
}

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4',
};

/** A content type from the file name's extension (application/octet-stream when unknown). */
export function contentTypeFor(name: string): string {
  return CONTENT_TYPES[posix.extname(name).toLowerCase()] ?? 'application/octet-stream';
}
