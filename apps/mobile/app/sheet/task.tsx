/** A task as an object sheet (`/sheet/task?project=&id=`); the view is src/projects/task-view.tsx. */

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { WidgetStationGate } from '../../src/widget/station-gate';
import { TaskView } from '../../src/projects/task-view';
import { objectId } from '../../src/lib/object-id';

export default function TaskScreen() {
  const params = useLocalSearchParams<{ project?: string; id?: string; station?: string }>();
  // a widget link names its station: the task opens only there (src/widget/station-gate.tsx)
  return (
    <WidgetStationGate station={params.station}>
      <TaskView projectId={objectId(params.project)} taskId={objectId(params.id)} />
    </WidgetStationGate>
  );
}
