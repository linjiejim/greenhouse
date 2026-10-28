/**
 * Client error reports: errors this app catches go to the active station
 * (`POST /api/client-reports`), where supers read them in Admin › Client errors.
 *
 * Importing this module installs the capture (./capture.ts, ./capture.web.ts), so the root layouts
 * import it first. Reports wait on the device (./storage.ts) until a signed-in member's station
 * takes them: on launch, when the app comes to the foreground and after sign-in. They carry the
 * error and where in the app it happened, never what the member reads or writes (redaction:
 * ../shared/client-reports.ts). React error boundaries report through `reportError`.
 */

import { useEffect } from 'react';
import { AppState } from 'react-native';
import { usePathname } from 'expo-router';
import { post } from '../api/client';
import type { ClientReportAccepted, ClientReportSource } from '../shared/client-reports';
import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';
import { appFacts } from './app-facts';
import { installCapture } from './capture';
import { createReporter } from './reporter';
import { reportStorage } from './storage';

let route: string | null = null;
let facts: ReturnType<typeof appFacts> | null = null;

export const clientReports = createReporter({
  storage: reportStorage,
  context: () => {
    facts ??= appFacts();
    return {
      ...facts,
      route,
      station: useStations.getState().activeId ?? null,
      api_level: useAuth.getState().station?.mobile_api ?? null,
    };
  },
  send: async (reports, station) => {
    // a batch read for one station never goes to the next one
    if ((useStations.getState().activeId ?? null) !== station) return 0;
    const result = await post<ClientReportAccepted>('/api/client-reports', { reports });
    return result.ok ? 202 : result.status;
  },
});

installCapture(clientReports);

/** A caught error worth reporting (a React error boundary's). Never throws. */
export function reportError(error: unknown, source: ClientReportSource = 'boundary'): void {
  clientReports.record(error, { fatal: false, source });
}

/** Root layout: keep the session mark on the route on screen and send what waits once signed in. */
export function useClientReports(): void {
  const path = usePathname();
  const member = useAuth((s) => s.user?.id);
  const loading = useAuth((s) => s.loading);
  const station = useStations((s) => s.activeId ?? null);

  useEffect(() => {
    route = path;
    clientReports.markSession({ route: path });
  }, [path]);

  useEffect(() => {
    clientReports.markSession({ station });
  }, [station]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => clientReports.markSession({ active: state === 'active' }));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!member || loading) return;
    // only for the identity this effect started on: a late answer never moves another station's queue
    const flush = () => {
      if (useAuth.getState().user?.id === member && (useStations.getState().activeId ?? null) === station) {
        void clientReports.flush(station);
      }
    };
    flush();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') flush();
    });
    return () => sub.remove();
  }, [member, loading, station]);
}
