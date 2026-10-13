/**
 * Channels are provider instances (docs/product/providers.md §2): email is `mail` over `smtp`,
 * Feishu and WeCom are `im` (`feishu`, `wecom`), push is `push` over `expo`. A channel is served
 * by the first instance of its kind in the capability's workspace order: env settings until an
 * admin saves their own, which then take the first place. No fallback to a second instance: a
 * channel turned off is off.
 *
 * Admin settings are snake_case here and camelCase in the adapter config; this file translates.
 */

import type { ChannelInput, ChannelStatus, DeliveryChannel } from '@greenhouse/contract';
import { getAdapter, type Capability } from '@greenhouse/providers';
import { invalidInput } from '../../http/errors.js';
import type { Arrangement } from '../../providers/service.js';
import { smtpPort, type SmtpConfig } from './smtp.js';

export const CHANNEL_PROVIDER: Readonly<
  Record<DeliveryChannel, { capability: Extract<Capability, 'mail' | 'im' | 'push'>; kind: string; name: string }>
> = {
  email: { capability: 'mail', kind: 'smtp', name: 'SMTP' },
  feishu: { capability: 'im', kind: 'feishu', name: '飞书' },
  wecom: { capability: 'im', kind: 'wecom', name: '企业微信' },
  push: { capability: 'push', kind: 'expo', name: 'Expo' },
};

/** The write-only field of each channel, as the admin API names it and as the adapter does. */
const SECRET: Readonly<Record<DeliveryChannel, { field: string; key: string }>> = {
  email: { field: 'password', key: 'password' },
  feishu: { field: 'app_secret', key: 'appSecret' },
  wecom: { field: 'secret', key: 'secret' },
  push: { field: 'access_token', key: 'accessToken' },
};

/** Adapter config keys by API field. */
const FIELDS: Readonly<Record<DeliveryChannel, Readonly<Record<string, string>>>> = {
  email: {
    host: 'host',
    port: 'port',
    security: 'security',
    username: 'username',
    from_address: 'fromAddress',
    from_name: 'fromName',
  },
  feishu: { base_url: 'baseUrl', app_id: 'appId' },
  wecom: { base_url: 'baseUrl', corp_id: 'corpId', agent_id: 'agentId' },
  push: { base_url: 'baseUrl' },
};

export type ChannelInstance = Arrangement['instances'][number];

/** The instance serving a channel (or, when none is in the order, the workspace one an admin left out of it). */
export function channelInstance(
  arranged: Record<Capability, Arrangement>,
  channel: DeliveryChannel,
): { instance: ChannelInstance; inOrder: boolean } | null {
  const { capability, kind } = CHANNEL_PROVIDER[channel];
  const { order, instances } = arranged[capability];
  const ofKind = instances.filter((instance) => instance.kind === kind);
  const serving = order.map((id) => ofKind.find((instance) => instance.id === id)).find(Boolean);
  if (serving) return { instance: serving, inOrder: true };
  const leftOut = ofKind.find((instance) => instance.source === 'workspace');
  return leftOut ? { instance: leftOut, inOrder: false } : null;
}

/** It can deliver now. */
export const configured = (found: ReturnType<typeof channelInstance>) => !!found?.inOrder && found.instance.usable;

/** The adapter's view of a stored config: defaults filled, strings from env read as numbers. */
function parsed(channel: DeliveryChannel, config: Record<string, unknown>): Record<string, unknown> | null {
  const { capability, kind } = CHANNEL_PROVIDER[channel];
  const result = getAdapter(capability, kind)?.configSchema.safeParse(config);
  return result?.success ? (result.data as Record<string, unknown>) : null;
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown) => (typeof value === 'string' && value ? value : null);

/** The settings an admin sees; null when nothing is set up or the stored settings no longer parse. */
export function channelSettings(
  channel: DeliveryChannel,
  config: Record<string, unknown> | undefined,
): ChannelStatus['settings'] {
  const value = config && parsed(channel, config);
  if (!value) return null;
  switch (channel) {
    case 'email':
      return {
        host: text(value.host),
        port: smtpPort(value as SmtpConfig),
        security: (value as SmtpConfig).security,
        username: textOrNull(value.username),
        from_address: text(value.fromAddress),
        from_name: textOrNull(value.fromName),
      };
    case 'feishu':
      return { base_url: text(value.baseUrl), app_id: text(value.appId) };
    case 'wecom':
      return { base_url: text(value.baseUrl), corp_id: text(value.corpId), agent_id: Number(value.agentId) };
    case 'push':
      return { base_url: text(value.baseUrl) };
  }
}

/**
 * An admin's change as a provider update: the merged config (only when a setting changed), the
 * write-only field ('' clears it) and the switch. The merged config must satisfy the adapter;
 * its complaints name the API's fields.
 */
export function providerChange<C extends DeliveryChannel>(
  channel: C,
  input: ChannelInput[C],
  stored: Record<string, unknown> | undefined,
): { config?: Record<string, unknown>; secrets?: Record<string, string>; enabled?: boolean } {
  const fields = FIELDS[channel];
  const given = input as Record<string, unknown>;
  const touched = Object.keys(fields).filter((field) => given[field] !== undefined);
  let config: Record<string, unknown> | undefined;
  if (touched.length || !stored) {
    config = { ...stored };
    for (const field of touched) {
      const value = given[field];
      // null means "not set" (the default port, no username, no display name).
      if (value === null) delete config[fields[field]!];
      else config[fields[field]!] = value;
    }
    const { capability, kind } = CHANNEL_PROVIDER[channel];
    const check = getAdapter(capability, kind)?.configSchema.safeParse(config);
    if (check && !check.success) {
      const byKey = Object.fromEntries(Object.entries(fields).map(([field, key]) => [key, field]));
      throw invalidInput(
        'The settings are incomplete or invalid.',
        check.error.issues.map((issue) => ({
          path: issue.path.map((part) => byKey[String(part)] ?? String(part)).join('.'),
          message: issue.message,
        })),
      );
    }
  }
  const secret = given[SECRET[channel].field];
  return {
    ...(config ? { config } : {}),
    ...(typeof secret === 'string' ? { secrets: { [SECRET[channel].key]: secret } } : {}),
    ...(typeof given.enabled === 'boolean' ? { enabled: given.enabled } : {}),
  };
}

/** The API's names for the write-only fields an instance holds. */
export const secretsSet = (channel: DeliveryChannel, keys: readonly string[]) =>
  keys.includes(SECRET[channel].key) ? [SECRET[channel].field] : [];
