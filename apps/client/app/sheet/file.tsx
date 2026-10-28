/** A 云盘 file as an object sheet (`/sheet/file?id=&name=`); the view is src/files/file-preview-view.tsx. */

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { FilePreviewPane } from '../../src/files/file-preview-view';

export default function FilePreview() {
  const { id = '', path = '', name = '' } = useLocalSearchParams<{ id?: string; path?: string; name?: string }>();
  return <FilePreviewPane id={id} path={path} name={name} />;
}
