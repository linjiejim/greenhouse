/**
 * Connecting a connector from the phone — 「我」 → 连接 and the chat's
 * "Connect X" card share these:
 *
 *  - `connectConnector` — key: a secure prompt, kept only if the server's
 *    trial call works (a refusal is worded here, the service's answer behind
 *    详情); OAuth: the provider's sign-in (./sign-in.ts: the system auth
 *    session on the phone, a popup returning to /connectors/oauth-finish in the
 *    browser), finished as this member (the server refuses a sign-in someone
 *    else started);
 *  - `testConnection` — "N tools", or why not;
 *  - `disconnect` — confirmed; the key or sign-in is forgotten (an OAuth
 *    grant is revoked too);
 *  - `refreshOwnConnector` / `deleteOwnConnector` — my personal connectors:
 *    list their tools again; delete (confirmed) with my connection to it.
 *
 * Each resolves true when something changed and the caller should re-read.
 */

import {
  deletePersonalConnector,
  disconnectConnector,
  refreshPersonalConnector,
  saveConnectorKey,
  testConnector,
  type ConnectorAuthKind,
} from '../api/connectors';
import { captureIdentity } from '../data/identity';
import { t } from '../lib/i18n';
import { alertError, confirmAction, promptText } from '../ui/dialogs';
import { notifySuccess } from '../ui/haptics';
import { toast } from '../ui/toast';
import { signInToConnector } from './sign-in';

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
  const outcome = await signInToConnector(connector.id, current);
  if (outcome.kind === 'quiet') return false;
  if (outcome.kind === 'failed') {
    alertError(t('connectors.signInFailed'), outcome.message, outcome.detail);
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

export async function refreshOwnConnector(connector: Pick<ConnectTarget, 'id' | 'name'>): Promise<boolean> {
  const current = captureIdentity();
  const result = await refreshPersonalConnector(connector.id);
  if (!current()) return false;
  if (!result.ok) {
    alertError(t('connectors.refreshFailed'), result.message || undefined);
    return false;
  }
  if (result.data.ok) toast(t('connectors.refreshed', { n: result.data.connector.tools.length }), 'check');
  else alertError(t('connectors.refreshFailed'), undefined, result.data.error ?? undefined);
  return true;
}

export async function deleteOwnConnector(connector: Pick<ConnectTarget, 'id' | 'name'>): Promise<boolean> {
  const ok = await confirmAction({
    title: t('connectors.deleteTitle', { name: connector.name }),
    message: t('connectors.deleteMessage'),
    confirmLabel: t('connectors.delete'),
    destructive: true,
  });
  if (!ok) return false;
  const current = captureIdentity();
  const result = await deletePersonalConnector(connector.id);
  if (!current()) return false;
  if (!result.ok) {
    alertError(t('connectors.deleteFailed'), result.message || undefined);
    return false;
  }
  toast(t('connectors.deleted', { name: connector.name }), 'check');
  return true;
}
