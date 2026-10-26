import type { IconName } from '../ui/core';
export interface NativeScreenEntry {
  screen: string;
  route?: string;
  icon: IconName;
  endpoint?: string;
  collection?: string;
}
