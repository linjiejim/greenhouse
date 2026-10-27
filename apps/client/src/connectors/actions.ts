/**
 * Connecting a connector from the phone — 「我」 → 连接 and the chat's
 * "Connect X" card share these:
 *
 *  - `connectConnector` — key: a secure prompt, kept only if the server's
 *    trial call works (a refusal is worded here, the service's answer behind
 *    详情); OAuth: the provider's sign-in in the system auth session, which
 *    returns to `greenhouse://connectors/oauth-finish`, then the finish call
 *    as this member (the server refuses a sign-in someone else started);
 *  - `testConnection` — "N tools", or why not;
 *  - `disconnect` — confirmed; the key or sign-in is forgotten (an OAuth
 *    grant is revoked too).
 *
 * Each resolves true when something changed and the caller should re-read.
 */

import * as WebBrowser from 'expo-web-browser';
import {
  disconnectConnector,
  finishConnectorSignIn,
  saveConnectorKey,
  startConnectorSignIn,
  testConnector,
  type ConnectorAuthKind,
} from '../api/connectors';
import { captureIdentity } from '../data/identity';
import { t } from '../lib/i18n';
import { alertError, confirmAction, promptText } from '../ui/dialogs';
import { notifySuccess } from '../ui/haptics';
import { toast } from '../ui/toast';
import { CONNECTOR_APP_REDIRECT, parseConnectorReturn } from './model';

export interface ConnectTarget {
  id: string;
  name: string;
  auth_kind: ConnectorAuthKind | null;
}

export async function connectConnector(connector: ConnectTarget): Promise<boolean> {
  const current = captureIdentity();
  if (connector.auth_kind !== 'oauth') {
    const key = await promptText({
      title: t('connectors.keyTitle', { name: connector.name }),
      message: t('connectors.keyHint'),
      confirmLabel: t('common.save'),
      secure: true,
    });
    if (!key || !current()) return false;
    const saved = await saveConnectorKey(connector.id, key);
    if (!current()) return false;
    if (!saved.ok) {
      alertError(t('connectors.keyFailed'), saved.message || undefined);
      return false;
    }
    if (saved.data.ok) {
      notifySuccess();
      toast(t('connectors.connectedToast', { name: connector.name }), 'check');
    } else {
      alertError(t('connectors.keyFailed'), t('connectors.keyRejected', { name: connector.name }), saved.data.error ?? undefined);
    }
    return true;
  }
  const started = await startConnectorSignIn(connector.id);
  if (!current()) return false;
  if (!started.ok) {
    alertError(t('connectors.signInFailed'), started.message || undefined);
    return false;
  }
  const session = await WebBrowser.openAuthSessionAsync(started.data.authorize_url, CONNECTOR_APP_REDIRECT);
  const back = parseConnectorReturn(session.type === 'success' ? session.url : null);
  if (back.kind === 'cancel' || !current()) return false;
  if (back.kind === 'error') {
    alertError(t('connectors.signInFailed'), undefined, back.reason);
    return false;
  }
  const finished = await finishConnectorSignIn(back.code, back.state);
  if (!current()) return false;
  if (!finished.ok) {
    alertError(t('connectors.signInFailed'), finished.message || undefined);
    return false;
  }
  notifySuccess();
  toast(t('connectors.connectedToast', { name: connector.name }), 'check');
  return true;
}

export async function testConnection(connector: Pick<ConnectTarget, 'id' | 'name'>): Promise<boolean> {
  const current = captureIdentity();
  const result = await testConnector(connector.id);
  if (!current()) return false;
  if (!result.ok) {
    alertError(t('connectors.testFailed', { name: connector.name }), result.message || undefined);
    return false;
  }
  if (result.data.ok) toast(t('connectors.testOk', { n: result.data.tool_count }), 'check');
  else {
    alertError(
      t('connectors.testFailed', { name: connector.name }),
      t('connectors.testRefused', { name: connector.name }),
      result.data.error ?? undefined,
    );
  }
  return true;
}

export async function disconnect(connector: Pick<ConnectTarget, 'id' | 'name'>): Promise<boolean> {
  const ok = await confirmAction({
    title: t('connectors.disconnectTitle', { name: connector.name }),
    message: t('connectors.disconnectMessage'),
    confirmLabel: t('connectors.disconnect'),
    destructive: true,
  });
  if (!ok) return false;
  const current = captureIdentity();
  const result = await disconnectConnector(connector.id);
  if (!current()) return false;
  if (!result.ok) {
    alertError(t('connectors.disconnectFailed'), result.message || undefined);
    return false;
  }
  return true;
}
