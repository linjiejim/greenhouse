import React from 'react';
import { FileDrop } from '../ui/file-drop.web';
import { uploadsAsImage } from './composer-files';
import type { ConversationDropProps } from './file-drop';
export function ConversationDrop({ children, onFiles }: ConversationDropProps) {
  return (
    <FileDrop
      onFiles={
        onFiles
          ? (files) =>
              onFiles(
                files.map((file) => ({
                  uri: URL.createObjectURL(file),
                  name: file.name,
                  mimeType: file.type,
                  size: file.size,
                  kind: uploadsAsImage(file.type, file.name) ? 'image' : 'file',
                })),
              )
          : undefined
      }
    >
      {children}
    </FileDrop>
  );
}
