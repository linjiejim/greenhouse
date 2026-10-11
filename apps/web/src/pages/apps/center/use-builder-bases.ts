/**
 * The Bases where the caller may build an app (owner or builder) — the
 * choices of "new app" and "ask a Bot". Read from the Tables module (creating
 * an app means building on a Base, which takes Tables access).
 */

import { useEffect, useState } from 'react';
import { tableRoleAtLeast } from '@greenhouse/types/table-access';
import { listTableBases, type TableBaseWithRole } from '../../../lib/api/tables';

export type BuilderBasesState =
  | { kind: 'loading' }
  | { kind: 'ready'; bases: TableBaseWithRole[] }
  | { kind: 'failed' };

export function useBuilderBases(enabled: boolean): BuilderBasesState {
  const [state, setState] = useState<BuilderBasesState>({ kind: 'loading' });
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setState({ kind: 'loading' });
    listTableBases()
      .then((bases) => {
        if (!alive) return;
        setState({
          kind: 'ready',
          bases: bases.filter((base) => !base.archived_at && tableRoleAtLeast(base.role, 'builder')),
        });
      })
      .catch(() => alive && setState({ kind: 'failed' }));
    return () => {
      alive = false;
    };
  }, [enabled]);
  return state;
}
