/** A table record as an object sheet (`/sheet/record?table=&id=`); the view is src/tables/record-view.tsx. */

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { RecordView } from '../../src/tables/record-view';
import { objectId } from '../../src/lib/object-id';

export default function RecordScreen() {
  const params = useLocalSearchParams<{ table?: string; id?: string }>();
  return <RecordView tableId={objectId(params.table)} recordId={objectId(params.id)} />;
}
