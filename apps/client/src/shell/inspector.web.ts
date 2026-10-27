import { create } from 'zustand';
import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';
interface InspectorState {
  last: { pathname: string; params: Record<string, string> } | null;
  close: (() => void) | null;
}
export const useInspector = create<InspectorState>(() => ({ last: null, close: null }));
let owner = '';
function follow() {
  const next = `${useStations.getState().activeId}:${useAuth.getState().user?.id}`;
  if (next === owner) return;
  owner = next;
  useInspector.setState({ last: null, close: null });
}
useAuth.subscribe(follow);
useStations.subscribe(follow);
