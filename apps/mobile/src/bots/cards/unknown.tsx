/**
 * A card kind this app version does not know (a newer server): never a silent
 * gap where the thread is waiting on the member — one line saying a Bot needs
 * them and where to look. (A card the API no longer returns at all — settled
 * long ago, past the conversation's recent window — is the thread's to render:
 * its transcript row's own text.)
 */

import React from 'react';
import { useT } from '../../lib/i18n';
import { CardNote } from './card-frame';

export function UnknownBody() {
  const t = useT();
  return <CardNote text={t('bots.card.unknownHint')} />;
}
