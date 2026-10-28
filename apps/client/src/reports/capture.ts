/**
 * Catching errors on a phone: the JS runtime's last-chance handler (ErrorUtils; fatal ones are
 * written before the default handler aborts the app), unhandled promise rejections (Hermes'
 * tracker; React Native installs it only in development, where LogBox shows them), and in release
 * builds the session mark, which turns a launch that ended in the foreground without either (a
 * native crash, a worklet error on the UI thread, a watchdog kill) into a report on the next
 * launch. Development reloads would look like such an end, so the mark is release only.
 * Browser: ./capture.web.ts.
 */

import { AppState } from 'react-native';
import type { Reporter } from './reporter';

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;

interface RuntimeGlobals {
  ErrorUtils?: { getGlobalHandler(): GlobalHandler; setGlobalHandler(handler: GlobalHandler): void };
  HermesInternal?: {
    enablePromiseRejectionTracker?: (options: {
      allRejections: boolean;
      onUnhandled: (id: number, rejection: unknown) => void;
      onHandled: (id: number) => void;
    }) => void;
  };
}

export function installCapture(reporter: Reporter): void {
  const runtime = globalThis as RuntimeGlobals;
  const errorUtils = runtime.ErrorUtils;
  if (errorUtils) {
    const previous = errorUtils.getGlobalHandler();
    errorUtils.setGlobalHandler((error, isFatal) => {
      reporter.record(error, { fatal: !!isFatal, source: 'global' });
      previous(error, isFatal);
    });
  }
  if (__DEV__) return;
  runtime.HermesInternal?.enablePromiseRejectionTracker?.({
    allRejections: true,
    onUnhandled: (_id, rejection) => void reporter.record(rejection, { fatal: false, source: 'promise' }),
    onHandled: () => undefined,
  });
  reporter.beginSession(AppState.currentState === 'active');
}
