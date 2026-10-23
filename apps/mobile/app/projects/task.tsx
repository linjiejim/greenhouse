/** A task as a pushed page (`/projects/task?project=&task=`); the view is src/projects/task-view.tsx. */

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { WidgetStationGate } from '../../src/widget/station-gate';
import { TaskView } from '../../src/projects/task-view';

const id = (raw: string | undefined) => (raw && /^[0-9]+$/.test(raw) ? Number(raw) : null);

export default function TaskScreen() {
  const params = useLocalSearchParams<{ project?: string; task?: string; station?: string }>();
  // a widget link names its station: the task opens only there (src/widget/station-gate.tsx)
  return (
    <WidgetStationGate station={params.station}>
      <TaskView projectId={id(params.project)} taskId={id(params.task)} />
    </WidgetStationGate>
  );
}
