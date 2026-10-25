/** A member's standing with a connector, as a small tag. */

import React from 'react';
import type { ConnectorConnectionStatus } from '@greenhouse/types/connectors';
import { Tag } from '../ui';
import { useT } from '../../lib/i18n';

const TONE = {
  not_needed: 'neutral',
  not_connected: 'neutral',
  connected: 'success',
  needs_reauth: 'warning',
  error: 'danger',
} as const;

export function ConnectorStatusTag({ status }: { status: ConnectorConnectionStatus }) {
  const t = useT();
  if (status === 'not_needed') return null;
  return <Tag tone={TONE[status]}>{t(`connectors.status.${status}`)}</Tag>;
}
