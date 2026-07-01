/**
 * GUARD + BEHAVIOR TEST — the email-connector fork extension point.
 *
 * Upstream has NO connectors (IMAP-only). Registering a connector for a provider
 * makes getEmailConnector resolve it — a fork adds Gmail/Outlook without editing
 * service.ts.
 */

import { describe, it, expect } from 'vitest';
import { getEmailConnector, registerEmailConnector, type EmailConnectorFactory } from './extensions.js';

describe('email connector extension seam', () => {
  it('has no fork connectors upstream (IMAP-only)', () => {
    expect(getEmailConnector('gmail')).toBeUndefined();
    expect(getEmailConnector('imap')).toBeUndefined();
  });

  it('resolves a registered connector by provider', () => {
    const factory: EmailConnectorFactory = async () => ({}) as never;
    registerEmailConnector('gmail', factory);
    expect(getEmailConnector('gmail')).toBe(factory);
    expect(getEmailConnector('outlook')).toBeUndefined();
  });
});
