import React, { useState } from 'react';
import { useTheme } from '../theme';
export function FileDrop({ children, onFiles }: { children: React.ReactNode; onFiles?: (files: File[]) => void }) {
  const [over, setOver] = useState(false);
  const { hex: c } = useTheme();
  return (
    <div
      data-testid="file-drop-zone"
      style={{ display: 'flex', flex: 1, minHeight: 0, outline: over ? `2px solid ${c.accent}` : undefined }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(!!onFiles);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        onFiles?.(Array.from(e.dataTransfer.files));
      }}
    >
      {children}
    </div>
  );
}
export function pickFile({ accept, multiple = true }: { accept?: string; multiple?: boolean } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept ?? '';
    input.multiple = multiple;
    input.onchange = () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    };
    input.oncancel = () => {
      resolve([]);
      input.remove();
    };
    input.click();
  });
}
