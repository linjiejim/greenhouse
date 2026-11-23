/**
 * What's new as its own sheet, opened from the notice after an update (src/release-notes): the
 * releases since `since`, the version this device had. Wide browsers show it as a centered dialog.
 */
import React from 'react';
import { WhatsNewScreen } from '../../src/release-notes/whats-new-screen';

export default function WhatsNewSheet() {
  return <WhatsNewScreen sheet />;
}
