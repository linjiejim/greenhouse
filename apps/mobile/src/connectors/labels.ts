/** How a connector's state and credential read — Settings → 连接器 and the Bot form's picks. */

import type { Connector, ConnectorStatus } from '../api/connectors';
import type { TranslationKey } from '../lib/i18n';

export const CONNECTOR_STATUS_LABEL: Record<ConnectorStatus, TranslationKey> = {
  connected: 'connectors.statusConnected',
  not_connected: 'connectors.statusNotConnected',
  expired: 'connectors.statusExpired',
  not_needed: 'connectors.statusReady',
};

export const CONNECTOR_AUTH_LABEL: Record<Connector['auth_mode'], TranslationKey> = {
  oauth: 'connectors.authOauth',
  per_user: 'connectors.authPerUser',
  shared: 'connectors.authShared',
  none: 'connectors.authNone',
};
