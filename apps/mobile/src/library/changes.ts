/**
 * The knowledge base and 云盘 share one folder tree (drive scope `kb`). Any write to it —
 * a new folder or document, a rename, a move, a delete, an upload — bumps `version`, and every
 * list showing part of the tree reloads. React-free apart from zustand.
 */

import { create } from 'zustand';

export const useLibraryChanges = create<{ version: number }>(() => ({ version: 0 }));

export function libraryChanged(): void {
  useLibraryChanges.setState((state) => ({ version: state.version + 1 }));
}

/** What a move picks a new folder for (the move sheet, app/move.tsx). */
export type Movable =
  | { kind: 'doc'; id: string; name: string; shelf: 'team' | 'personal' }
  | { kind: 'file'; id: string; name: string; shelf: 'team' | 'personal' }
  | { kind: 'folder'; id: string; name: string; shelf: 'team' | 'personal' };
