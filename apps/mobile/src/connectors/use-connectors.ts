/**
 * Connectors as the app shows them — Settings → 连接器 (app/settings/connectors.tsx)
 * and the chat's "Connect X" card (./connect-card.tsx) share this:
 *
 *  - `useConnectors()` — the list (`GET /api/connectors`), re-read whenever
 *    the app comes back to the front (a sign-in finished in the browser on
 *    Android, a key added on the web) and after every change made here;
 *  - `connect(connector)` — oauth: the provider's sign-in in an in-app browser
 *    sheet (the server's page says "connected — close this window"; the
 *    browser can't tell the app, so the list is read again once it closes);
 *    per_user: a secure prompt for the key (the admin's hint as its message),
 *    kept only if the server's trial call works — a refusal is worded here,
 *    the provider's raw answer behind 详情 (the same for a failed 测试).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import {
  disconnectConnector,
  listConnectors,
  saveConnectorKey,
  startConnectorSignIn,
  testConnector,
  type Connector,
} from '../api/connectors';
import { t } from '../lib/i18n';
import { alertError, confirmAction, promptText } from '../ui/dialogs';
import { toast } from '../ui/toast';

export type ConnectorsLoad = { enabled: boolean; connectors: Connector[] } | 'loading' | 'error';

export function useConnectors() {
  const [load, setLoad] = useState<ConnectorsLoad>('loading');
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    const result = await listConnectors();
    if (mine !== seq.current) return;
    // a failed refresh keeps what is on screen
    setLoad((current) => (result ? result : typeof current === 'object' ? current : 'error'));
  }, []);

  useEffect(() => {
    void reload();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void reload();
    });
    return () => sub.remove();
  }, [reload]);

  return { load, reload };
}

/** Connect one connector (its sign-in or key). Resolves once there is something new to read. */
export async function connect(connector: Pick<Connector, 'id' | 'name' | 'auth_mode' | 'credential_help'>): Promise<void> {
  if (connector.auth_mode === 'per_user') {
    const key = await promptText({
      title: t('connectors.keyTitle', { name: connector.name }),
      message: connector.credential_help || t('connectors.keyHint'),
      placeholder: t('connectors.keyPlaceholder'),
      confirmLabel: t('connectors.save'),
      secure: true,
    });
    if (!key) return;
    const saved = await saveConnectorKey(connector.id, key);
    if (saved.ok) toast(t('connectors.connectedToast', { name: connector.name }), 'check');
    else if (saved.code === 'key_rejected') {
      // the provider's own answer (often raw JSON) waits behind 详情
      alertError(t('connectors.keyFailed'), t('connectors.keyRejected', { name: connector.name }), saved.detail);
    } else alertError(t('connectors.keyFailed'), saved.message);
    return;
  }
  const started = await startConnectorSignIn(connector.id);
  if (!started.ok) {
    alertError(t('connectors.signInFailed'), started.message);
    return;
  }
  await WebBrowser.openBrowserAsync(started.value, {
    dismissButtonStyle: 'done',
    presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
    readerMode: false,
  });
  // (Android's custom tab answers at once: the AppState listener re-reads on the way back)
}

/** Try the connection: "N tools" or why not (in a sentence; the server's reason behind 详情). */
export async function test(connector: Pick<Connector, 'id' | 'name'>): Promise<void> {
  const result = await testConnector(connector.id);
  if (result.ok) {
    toast(t('connectors.testOk', { n: result.value }), 'check');
    return;
  }
  const title = t('connectors.testFailed', { name: connector.name });
  if (result.code === 'expired') alertError(title, t('connectors.testExpired', { name: connector.name }), result.detail);
  else if (result.code === 'error') alertError(title, t('connectors.testUnreachable', { name: connector.name }), result.detail);
  else alertError(title, result.message || undefined);
}

/** Disconnect (confirmed): the key or sign-in is forgotten — an OAuth grant is revoked too. */
export async function disconnect(connector: Pick<Connector, 'id' | 'name'>): Promise<boolean> {
  const ok = await confirmAction({
    title: t('connectors.disconnectTitle', { name: connector.name }),
    message: t('connectors.disconnectMessage'),
    confirmLabel: t('connectors.disconnect'),
    destructive: true,
  });
  if (!ok) return false;
  const result = await disconnectConnector(connector.id);
  if (!result.ok) {
    alertError(t('connectors.disconnectFailed'), result.message);
    return false;
  }
  return true;
}
