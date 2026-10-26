/** The Tauri global exists only in bundled, capability-scoped webviews. */
export interface NativeApi {
  core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
  event: { listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> };
}
declare global {
  interface Window {
    __TAURI__?: NativeApi;
    __GREENHOUSE_WINDOW__?: 'main' | 'quick-ask' | 'settings';
  }
}
export const nativeApi = (): NativeApi => {
  if (!window.__TAURI__) throw new Error('Native desktop bridge is unavailable');
  return window.__TAURI__;
};
export const invoke = <T = void>(command: string, args?: Record<string, unknown>) =>
  nativeApi().core.invoke<T>(command, args);

/** Cleanup also covers an unmount before the asynchronous native registration resolves. */
export function listenNative<T>(api: NativeApi, event: string, handler: (value: T) => void): () => void {
  let disposed = false;
  let stop: (() => void) | undefined;
  void api.event
    .listen<T>(event, (e) => {
      if (!disposed) handler(e.payload);
    })
    .then((unsubscribe) => {
      if (disposed) unsubscribe();
      else stop = unsubscribe;
    })
    .catch(reportNativeError);
  return () => {
    disposed = true;
    stop?.();
  };
}
export function reportNativeError(error: unknown) {
  window.dispatchEvent(
    new CustomEvent('desktop:error', { detail: error instanceof Error ? error.message : String(error) }),
  );
}
