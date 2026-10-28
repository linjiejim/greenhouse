import React from 'react';
import type { ComposerFile } from './composer-files';
export interface ConversationDropProps {
  children: React.ReactNode;
  onFiles?: (files: Omit<ComposerFile, 'id' | 'status' | 'remote'>[]) => void;
}
export function ConversationDrop({ children }: ConversationDropProps) {
  return <>{children}</>;
}
