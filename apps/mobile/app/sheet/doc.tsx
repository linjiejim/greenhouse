/** A knowledge document as an object sheet (`/sheet/doc?id=`); the view is src/knowledge/doc-view.tsx. */

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { WidgetStationGate } from '../../src/widget/station-gate';
import { DocView } from '../../src/knowledge/doc-view';

export default function KnowledgeDoc() {
  const { id: raw, station } = useLocalSearchParams<{ id?: string; station?: string }>();
  // a widget link names its station: the document opens only there (src/widget/station-gate.tsx)
  return (
    <WidgetStationGate station={station}>
      <DocView id={raw && /^[0-9]+$/.test(raw) ? Number(raw) : null} />
    </WidgetStationGate>
  );
}
