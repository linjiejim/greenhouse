/** Browser previews use the same opaque-origin frame as rich HTML. */
import React from 'react';
import type { ViewProps } from 'react-native';
import { WebFrame } from '../../src/ui/web-frame';
export const hasFilePreview = true;
export function FilePreviewView({ uri, style }: ViewProps & { uri: string; onUnsupported: () => void }) {
  return <WebFrame source={{ uri }} style={style} />;
}
