import type { NativeScreenEntry } from '../native-types';
export const screen: NativeScreenEntry = {
  screen: 'skills',
  icon: 'sparkle',
  endpoint: '/api/skills',
  wideNote: 'skillHub.wideNote',
  collection: 'skills',
  statuses: { active: null, archived: 'skillHub.archived' },
};
