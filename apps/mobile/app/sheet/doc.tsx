/** A knowledge document as an object sheet (`/sheet/doc?id=`, or `?slug=` for a link without an id); the view is src/knowledge/doc-view.tsx. */

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { WidgetStationGate } from '../../src/widget/station-gate';
import { DocView } from '../../src/knowledge/doc-view';
import { objectId } from '../../src/lib/object-id';

export default function KnowledgeDoc() {
  const { id: raw, slug, station } = useLocalSearchParams<{ id?: string; slug?: string; station?: string }>();
  // a widget link names its station: the document opens only there (src/widget/station-gate.tsx)
  return (
    <WidgetStationGate station={station}>
      <DocView id={objectId(raw)} slug={slug || null} />
    </WidgetStationGate>
  );
}
