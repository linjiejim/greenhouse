import { useCallback, useEffect } from 'react';
import { useIsFocused } from 'expo-router';
import { get } from '../api/client';
import type { OperationSwitches } from '../shared/contract';
import { useResource } from './use-resource';

/** Switches are workspace-wide; refresh while the member is looking at their effect. */
export function useOperations() {
  const focused = useIsFocused();
  const resource = useResource(useCallback(() => get<OperationSwitches>('/api/me/operations'), []));
  const refresh = resource.refresh;
  useEffect(() => {
    if (!focused) return;
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [focused, refresh]);
  return resource;
}
