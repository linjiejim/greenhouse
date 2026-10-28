/** Active delivery adapters. Registration stays separate from the extension import graph. */
import type {
  DatabaseProvider,
  NotificationRow,
  NotificationDeliveryAttemptRow,
  ScheduledTaskRow,
} from '@greenhouse/db';

export interface DeliveryResult {
  ok: boolean;
  error?: string;
}
export interface SystemMailContext {
  db: DatabaseProvider;
  recipient: { address: string; name?: string };
  message: { subject: string; body_text: string; body_html: string };
  actorId: string;
}
export interface NotificationTransport {
  id: string;
  title: string;
  deliver(ctx: {
    db: DatabaseProvider;
    notification: NotificationRow;
    attempt: NotificationDeliveryAttemptRow;
  }): Promise<DeliveryResult>;
  /** Legacy preference keys and recipient envelopes remain owned by their adapter. */
  automationRecipients?(task: ScheduledTaskRow): Array<{ recipient: string; resultKey: string }>;
  automationResultKeys?: string[];
  acceptsWebhook?(url: URL): boolean;
  sendWebhook?(url: string, markdown: string): Promise<DeliveryResult & { status?: number }>;
  bindingSettings?: { preference: string; label: string };
  /** Immediate, audited account setup/reset delivery; never exposed to agents. */
  accountLinks?: {
    available(): boolean;
    send(ctx: SystemMailContext): Promise<{ ok: true; messageId: string } | { ok: false; error: string }>;
  };
}
let transports: readonly NotificationTransport[] = [];
export function registerNotificationTransports(items: readonly NotificationTransport[]): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id) || ['desktop', 'mobile_push'].includes(item.id))
      throw new Error(`Duplicate notification transport: ${item.id}`);
    ids.add(item.id);
  }
  transports = [...items];
}
export function notificationTransports(): readonly NotificationTransport[] {
  return transports;
}
export function accountLinkTransport() {
  return transports.find((t) => t.accountLinks?.available())?.accountLinks;
}

export function notificationWebhookTransport(raw: string) {
  try {
    const url = new URL(raw);
    return transports.find((t) => t.acceptsWebhook?.(url));
  } catch {
    return undefined;
  }
}
