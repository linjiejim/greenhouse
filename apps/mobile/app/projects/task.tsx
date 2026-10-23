/** A task as a pushed page (`/projects/task?project=&task=`); the view is src/projects/task-view.tsx. */

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { TaskView } from '../../src/projects/task-view';

const id = (raw: string | undefined) => (raw && /^[0-9]+$/.test(raw) ? Number(raw) : null);

export default function TaskScreen() {
  const params = useLocalSearchParams<{ project?: string; task?: string }>();
  return <TaskView projectId={id(params.project)} taskId={id(params.task)} />;
}
