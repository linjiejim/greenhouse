/** A knowledge document as a pushed page (`/knowledge/doc?id=`); the view is src/knowledge/doc-view.tsx. */

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { DocView } from '../../src/knowledge/doc-view';

export default function KnowledgeDoc() {
  const { id: raw } = useLocalSearchParams<{ id?: string }>();
  return <DocView id={raw && /^[0-9]+$/.test(raw) ? Number(raw) : null} />;
}
