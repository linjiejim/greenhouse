import type { State } from './plant-motion';
/** Product facts mapped once, shared with native. A tool takes precedence over buffered text. */
export interface PlantWork {
  working?: boolean;
  streaming?: boolean;
  hasText?: boolean;
  toolRunning?: boolean;
  waiting?: boolean;
  failed?: boolean;
  completed?: boolean;
  greeting?: boolean;
  sleeping?: boolean;
}
export function stateForWork(work: PlantWork): State {
  if (work.waiting) return 'waiting';
  if (work.working || work.streaming) return work.toolRunning || !work.hasText ? 'thinking' : 'speaking';
  if (work.failed) return 'error';
  if (work.completed) return 'done';
  if (work.sleeping) return 'sleep';
  if (work.greeting) return 'hello';
  return 'idle';
}
