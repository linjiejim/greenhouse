/**
 * Mail over SMTP, as the `mail` capability's `smtp` adapter: it only sends (an SMTP server cannot
 * tell us about mail it received). It lives in the API because it needs nodemailer (MIME
 * encoding, STARTTLS, the auth methods servers really use), which the provider package does not
 * carry; it registers itself like an extension adapter.
 *
 * - `security`: `tls` connects over TLS (465), `starttls` must upgrade (587), `none` stays plain
 *   (a local relay; never offered an upgrade it could be tricked out of).
 * - The address it may reach is `smtp://host:port`: moving the instance there drops the stored
 *   password, as moving a base URL drops a key.
 * - A recipient or message the server refuses for good (a 5xx on the envelope or the data) is
 *   UndeliverableError; everything else may pass on a retry.
 */

import { createTransport } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import { z } from 'zod';
import { MAIL_SECURITY } from '@greenhouse/contract';
import {
  getAdapter,
  registerAdapter,
  UndeliverableError,
  type MailAddress,
  type MailClient,
  type ProviderAdapter,
} from '@greenhouse/providers';

const DEFAULT_PORT = { tls: 465, starttls: 587, none: 25 } as const;

/** A host name or an IPv4 address: what nodemailer and the `smtp://` address both take as is. */
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/;

const configSchema = z.object({
  host: z.string().trim().regex(HOST, { message: 'Use a host name or an IPv4 address.' }),
  port: z.coerce.number().int().min(1).max(65_535).optional(),
  security: z.enum(MAIL_SECURITY).default('starttls'),
  /** Absent for a relay that takes mail without signing in. */
  username: z.string().trim().min(1).max(255).optional(),
  fromAddress: z.string().trim().email(),
  fromName: z.string().trim().min(1).max(100).optional(),
});
export type SmtpConfig = z.infer<typeof configSchema>;

/** nodemailer encodes a name itself (RFC 2047); a line break in it would be a header of its own. */
const party = (entry: MailAddress) =>
  entry.name ? { name: entry.name.replace(/[\r\n]+/g, ' ').trim(), address: entry.address } : entry.address;

export const smtpPort = (config: Pick<SmtpConfig, 'port' | 'security'>) => config.port ?? DEFAULT_PORT[config.security];

/** What a failure says, without the password, and whether a retry could help. */
function failure(error: unknown, password: string | undefined): Error {
  const { message, code, responseCode } = (error ?? {}) as {
    message?: unknown;
    code?: unknown;
    responseCode?: unknown;
  };
  let text = typeof message === 'string' && message ? message : String(error);
  if (password && password.length >= 4) text = text.split(password).join('***');
  text = `SMTP: ${text}`.slice(0, 300);
  const refused =
    typeof responseCode === 'number' && responseCode >= 500 && (code === 'EENVELOPE' || code === 'EMESSAGE');
  return refused ? new UndeliverableError(text) : new Error(text);
}

export const smtpAdapter: ProviderAdapter<'mail', SmtpConfig> = {
  capability: 'mail',
  kind: 'smtp',
  label: 'SMTP',
  configSchema: configSchema as z.ZodType<SmtpConfig>,
  secretKeys: ['password'],
  endpoints: (config) => [`smtp://${config.host}:${smtpPort(config)}`],
  create: ({ config, secrets }) => {
    const options: SMTPTransport.Options = {
      host: config.host,
      port: smtpPort(config),
      secure: config.security === 'tls',
      requireTLS: config.security === 'starttls',
      ignoreTLS: config.security === 'none',
      ...(config.username ? { auth: { user: config.username, pass: secrets.password ?? '' } } : {}),
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
      // Messages are composed here: never read a file or a URL into one.
      disableFileAccess: true,
      disableUrlAccess: true,
    };
    const sender = { address: config.fromAddress, ...(config.fromName ? { name: config.fromName } : {}) };

    async function withTransport<T>(work: (transport: ReturnType<typeof createTransport>) => Promise<T>) {
      const transport = createTransport(options);
      try {
        return await work(transport);
      } catch (error) {
        throw failure(error, secrets.password);
      } finally {
        transport.close();
      }
    }

    const client: MailClient = {
      send: (mail) =>
        withTransport(async (transport) => {
          const info = (await transport.sendMail({
            from: party(mail.from ?? sender),
            to: mail.to.map(party),
            ...(mail.cc?.length ? { cc: mail.cc.map(party) } : {}),
            ...(mail.replyTo ? { replyTo: party(mail.replyTo) } : {}),
            subject: mail.subject.replace(/[\r\n]+/g, ' '),
            text: mail.text,
            ...(mail.html ? { html: mail.html } : {}),
            ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
            ...(mail.references?.length ? { references: mail.references } : {}),
          })) as { messageId?: string };
          const id = typeof info.messageId === 'string' ? info.messageId : null;
          return { providerId: id, messageId: id };
        }),
      verify: () =>
        withTransport(async (transport) => {
          await transport.verify();
        }),
    };
    return client;
  },
  test: (client) => client.verify(),
};

// Registered once per process, before the providers service reads the registry.
if (!getAdapter('mail', 'smtp')) registerAdapter(smtpAdapter);
