/** A Files file as a pushed page (`/file-preview?id=&name=`); the view is src/files/file-preview-view.tsx. */

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { FilePreviewPane } from '../src/files/file-preview-view';

export default function FilePreview() {
  const { id = '', name = '' } = useLocalSearchParams<{ id?: string; name?: string }>();
  return <FilePreviewPane id={id} name={name} />;
}
