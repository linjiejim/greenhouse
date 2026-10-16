import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';

/** A late action belongs only to the identity that started it. */
export function captureIdentity(): () => boolean {
  const station = useStations.getState().activeId;
  const member = useAuth.getState().user?.id;
  return () => station === useStations.getState().activeId && member === useAuth.getState().user?.id;
}
