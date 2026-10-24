/** A record as a pushed page (`/tables/record?table=&id=`); the view is src/tables/record-view.tsx. */

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { RecordView } from '../../src/tables/record-view';

const num = (raw: string | undefined) => (raw && /^[0-9]+$/.test(raw) ? Number(raw) : null);

export default function RecordScreen() {
  const params = useLocalSearchParams<{ table?: string; id?: string }>();
  return <RecordView tableId={num(params.table)} recordId={num(params.id)} />;
}
