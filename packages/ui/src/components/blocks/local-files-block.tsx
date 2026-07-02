/**
 * LocalFilesBlock — renders local paths emitted by agents as read-only file cards.
 *
 * The web app shows the title/path only; opening/revealing files was a
 * desktop-shell capability and is no longer available.
 */

import React, { useMemo } from 'react';
import type { LocalFileItem, LocalFilesData, LocalFileKind } from './index';
import { FileText, FolderOpen, Image, Code, FileSearch } from '../../lib/icons';

interface LocalFilesBlockProps {
  data: LocalFilesData;
}

export function LocalFilesBlock({ data }: LocalFilesBlockProps) {
  if (!data.files.length) return null;

  return (
    <div className="my-3 space-y-2">
      {data.title && <div className="text-xs font-medium text-fg-muted">{data.title}</div>}
      <div className="space-y-2">
        {data.files.map((file) => (
          <LocalFileCard key={`${file.path}:${file.label ?? ''}`} file={file} />
        ))}
      </div>
    </div>
  );
}

function LocalFileCard({ file }: { file: LocalFileItem }) {
  const name = useMemo(() => basename(file.path), [file.path]);
  const Icon = iconForKind(file.kind);

  return (
    <div
      className="group rounded-lg border border-edge bg-surface-raised p-3 transition-colors hover:border-edge-strong"
      title={file.path}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-surface-muted text-primary-600">
          <Icon size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate text-sm font-medium text-fg" title={file.label || name}>
              {file.label || name}
            </div>
          </div>
          <div className="mt-1 truncate font-mono text-xs text-fg-muted" title={file.path}>
            {file.path}
          </div>
        </div>
      </div>
    </div>
  );
}

function iconForKind(kind?: LocalFileKind): typeof FileText {
  switch (kind) {
    case 'directory':
      return FolderOpen;
    case 'html':
    case 'markdown':
      return Code;
    case 'image':
      return Image;
    case 'pdf':
      return FileSearch;
    default:
      return FileText;
  }
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  const name = normalized.split('/').pop();
  return name || path;
}
