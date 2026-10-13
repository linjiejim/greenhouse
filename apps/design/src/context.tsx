import { createContext, useContext, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import type { Capability, ModuleId, RecordItem } from './data';
export interface DesignContextValue {
  module: ModuleId;
  records: RecordItem[];
  setRecords: Dispatch<SetStateAction<RecordItem[]>>;
  navigate: (module: ModuleId, selection?: string) => void;
  /** The active item in the module column (see shell.tsx for each module's keys). */
  selection: string;
  select: (selection: string) => void;
  /** Knowledge scope switch: 团队 · 个人 · 分享给我. */
  scope: string;
  setScope: (scope: string) => void;
  openRecord: (record: RecordItem) => void;
  openDocument: (id: string) => void;
  openAgent: (id: string, tab?: string) => void;
  openRun: (id: string) => void;
  openProvider: (capability: Capability, personal?: boolean) => void;
  openPanel: (title: string, content: ReactNode, center?: boolean) => void;
  notify: (text: string, action?: { label: string; onClick: () => void }) => void;
  theme: 'light' | 'dark' | 'system';
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  density: '舒适' | '紧凑';
  setDensity: (density: '舒适' | '紧凑') => void;
  mobile: boolean;
  /** Collapsed module column or mobile: the page header carries the controls to bring it back. */
  headerLead: ReactNode;
  needsYou: number;
  reset: () => void;
  newItem: () => void;
  /** Row state the right-click menus change, keyed agent:<id> · room:<id> · chat:<title>. */
  marks: Marks;
  mark: (kind: keyof Marks, key: string, on?: boolean) => void;
}
export interface Marks {
  pinned: string[];
  muted: string[];
  read: string[];
  /** Deleted, archived or left; undo puts them back. */
  hidden: string[];
}
export const DesignContext = createContext<DesignContextValue | null>(null);
export function useDesign() {
  const context = useContext(DesignContext);
  if (!context) throw new Error('DesignContext missing');
  return context;
}
