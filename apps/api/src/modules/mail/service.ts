/**
 * Mail (PRV-16, AGNT-30; providers.md §6 邮箱): system mail and every Agent's own mailbox through
 * the `mail` capability.
 *
 * - System mail (invites, resets, the admin's test; notification emails go through modules/channels)
 *   tries each instance in the capability's order until one sends.
 * - Agent mailboxes exist while a receiving instance is first in the order and the Agent domain is
 *   set. An address is `<local part>@<domain>`; public Agents get none in v2.0.
 * - Received mail: the vendor's notice is verified, then the mail is fetched from the vendor
 *   (never read from the notice), normalised, its HTML and attachments stored as files of the
 *   Agent's owner, and kept once per vendor id. Mail to an Agent lands in its thread (the main
 *   Agent's in the main thread) as a card, and wakes the Agent only when its sender may wake it
 *   (the owner, members when allowed, or someone let in) and is verified (aligned SPF, DKIM or
 *   DMARC). Other mail is screened: the owner lets its sender in, which delivers what waited.
 * - The Agent reads its mailbox with the mail tool; sending goes out only as a call the owner
 *   approved on a card, from the Agent's address, with In-Reply-To and References for replies.
 */

import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, ilike, inArray, lt, ne, or, sql } from 'drizzle-orm';
import type {
  AdminMail,
  Mailbox,
  MailDetail,
  MailItem,
  MailRelease,
  MailTest,
  Page,
  UpdateAdminMailInput,
  UpdateMailboxInput,
} from '@greenhouse/contract';
import {
  agentMailboxes,
  agents,
  authLinks,
  getDb,
  idempotencyKeys,
  mailMessages,
  mailSenders,
  members,
  newId,
  transaction,
  workspace,
  type Agent as AgentRow,
  type AgentMailbox,
  type Member,
  type MailMessageRow,
  type StoredMailAddress,
  type StoredMailAttachment,
} from '@greenhouse/db';
import {
  cutText,
  getAdapter,
  isAddress,
  MailSignatureError,
  UndeliverableError,
  type InboundMail,
  type MailAddress,
  type OutgoingMail,
  type SentMail,
} from '@greenhouse/providers';
import { isUniqueViolation, toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { audit } from '../../audit.js';
import { LINK_TTL_SECONDS } from '../../auth/tokens.js';
import type { AppConfig } from '../../config/index.js';
import type { Engine } from '../../engine/engine.js';
import { ApiError, conflict, notFound } from '../../http/errors.js';
import { containing } from '../../http/like.js';
import { decodeCursor, toPage } from '../../http/pagination.js';
import type { ProvidersService } from '../../providers/service.js';
import type { AgentsService } from '../agents/service.js';
import { toMessage, type ConversationsService } from '../conversations/service.js';
import type { FilesService } from '../files/service.js';
import {
  domainOf,
  localPartFor,
  localPartOf,
  replySubject,
  RESERVED_LOCAL_PARTS,
  senderVerified,
} from './addresses.js';
// Registers the smtp adapter before any mail instance is resolved.
import './smtp.js';
import { inviteMail, resetMail, testMail, type Locale, type SystemMail } from './templates.js';
import { wakeForMail } from './wake.js';

/** Mail that wakes one Agent in a day; past it, mail still lands in the thread but waits for a look. */
export const MAIL_WAKES_PER_DAY = 50;
/** Mail one Agent may send in a day, each approved by its owner. */
export const MAIL_SENDS_PER_DAY = 50;
/** Recipients of one mail an Agent sends, To and Cc together. */
export const MAIL_RECIPIENTS_MAX = 10;
export const MAIL_BODY_MAX = 20_000;
export const MAIL_SUBJECT_MAX = 300;
/** Text the mail tool hands the model from one mail; the rest stays in the mailbox. */
const READ_TEXT_MAX = 8_000;
const PREVIEW_MAX = 160;
const NOTICE_SCOPE = 'mail_notice';

export type LinkDelivery = 'emailed' | 'failed' | 'shown';

interface Receiver {
  id: string;
  kind: string;
  name: string;
  receives: boolean;
  fromAddress: string | null;
}

interface MailState {
  /** Usable instances in the capability's order. */
  order: Receiver[];
  canSend: boolean;
  domain: string | null;
  domainSource: 'env' | 'workspace' | null;
  /** MAIL_AGENT_DOMAIN: what clearing the saved domain goes back to. */
  envDomain: string | null;
  /** A receiving instance is first and the domain is set. */
  mailboxes: boolean;
}

/** What the mail tool and the routes need of a mailbox: the row, its Agent and its address. */
export interface OwnBox {
  box: AgentMailbox;
  agent: AgentRow;
  address: string;
}

export interface MailDraft {
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
  /** The received mail this answers. */
  replyOf?: string;
}

const addressView = (entry: StoredMailAddress) => ({ address: entry.address, name: entry.name ?? null });
const stored = (entry: MailAddress): StoredMailAddress =>
  entry.name ? { address: entry.address, name: cutText(entry.name, 200) } : { address: entry.address };
const preview = (text: string) => cutText(text.replace(/\s+/g, ' ').trim(), PREVIEW_MAX);
const localeOf = (value: string | null | undefined): Locale => (value === 'en' ? 'en' : 'zh');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export function createMailService(deps: {
  config: AppConfig;
  providers: ProvidersService;
  files: FilesService;
  agents: AgentsService;
  conversations: ConversationsService;
  /** Made after this service: the engine that wakes an Agent (wake.ts). */
  engine: () => Pick<Engine, 'deliver'>;
}) {
  const publicUrl = deps.config.PUBLIC_URL.replace(/\/+$/, '');
  const inboundUrl = (instanceId: string) => `${publicUrl}/api/mail/inbound/${encodeURIComponent(instanceId)}`;

  async function state(): Promise<MailState> {
    const arranged = (await deps.providers.arrangement()).mail;
    const byId = new Map(arranged.instances.map((instance) => [instance.id, instance]));
    const order = arranged.order
      .map((id) => byId.get(id))
      .filter((instance): instance is NonNullable<typeof instance> => !!instance?.usable)
      .map((instance): Receiver => {
        const adapter = getAdapter('mail', instance.kind);
        return {
          id: instance.id,
          kind: instance.kind,
          name: instance.name,
          receives: !!adapter?.receiveSecret && instance.secrets_set.includes(adapter.receiveSecret),
          fromAddress:
            typeof instance.config.fromAddress === 'string' ? instance.config.fromAddress.toLowerCase() : null,
        };
      });
    const { saved, env } = await deps.providers.defaultsBySource('mail');
    const savedDomain = typeof saved?.agent_domain === 'string' ? saved.agent_domain : null;
    const envDomain = typeof env.agent_domain === 'string' ? env.agent_domain : null;
    const domain = savedDomain ?? envDomain;
    return {
      order,
      canSend: order.length > 0,
      domain,
      domainSource: savedDomain ? 'workspace' : envDomain ? 'env' : null,
      envDomain,
      mailboxes: !!domain && !!order[0]?.receives,
    };
  }

  async function workspaceName(): Promise<string> {
    const [row] = await getDb().select({ name: workspace.name }).from(workspace);
    return row?.name ?? 'Greenhouse';
  }

  /** Sends through the first instance that takes it; null when none is set up. */
  async function sendThrough(
    mail: OutgoingMail,
    ctx: { memberId?: string; agentId?: string } = {},
  ): Promise<{ instance: { id: string; name: string }; sent: SentMail } | null> {
    const chain = await deps.providers.chain('mail', { ...ctx, personal: false });
    if (!chain.length) return null;
    let last: unknown = null;
    let refusedEverywhere = true;
    for (const entry of chain) {
      try {
        return { instance: { id: entry.instance.id, name: entry.instance.name }, sent: await entry.client.send(mail) };
      } catch (error) {
        last = error;
        if (!(error instanceof UndeliverableError)) refusedEverywhere = false;
        logger.warn('[mail] an instance could not send', { instance: entry.instance.id, error: toErrorMessage(error) });
      }
    }
    if (refusedEverywhere && last instanceof UndeliverableError) throw last;
    throw last instanceof Error ? last : new Error(String(last));
  }

  // ─── mailboxes ──────────────────────────────────────────

  const addressOf = (box: Pick<AgentMailbox, 'localPart'>, domain: string) => `${box.localPart}@${domain}`;

  async function mailboxOf(agentId: string): Promise<AgentMailbox | null> {
    const [row] = await getDb().select().from(agentMailboxes).where(eq(agentMailboxes.agentId, agentId));
    return row ?? null;
  }

  /** The Agent's mailbox, made with `name-xxxx` the first time. */
  async function ensureMailbox(agent: AgentRow): Promise<AgentMailbox> {
    const existing = await mailboxOf(agent.id);
    if (existing) return existing;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const [row] = await transaction(async (db) =>
          db
            .insert(agentMailboxes)
            .values({ id: newId('mailbox'), agentId: agent.id, localPart: localPartFor(agent.name) })
            .onConflictDoNothing({ target: agentMailboxes.agentId })
            .returning(),
        );
        if (row) return row;
        const raced = await mailboxOf(agent.id);
        if (raced) return raced;
      } catch (error) {
        // The random part met an address in use: draw again.
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new ApiError(500, 'internal', 'Could not give the Agent an address.');
  }

  /** Why an Agent has no mailbox now, or null when it has one. */
  function unavailable(current: MailState, agent: AgentRow): 'not_configured' | 'public_agent' | 'archived' | null {
    if (!current.mailboxes) return 'not_configured';
    if (agent.visibility === 'public') return 'public_agent';
    if (agent.archivedAt) return 'archived';
    return null;
  }

  /** The owner's own Agent and its mailbox; anyone else's is not found. */
  async function ownBox(memberId: string, idOrHandle: string): Promise<OwnBox & { current: MailState }> {
    const agent = await deps.agents.findOwn(memberId, idOrHandle);
    if (!agent) throw notFound('Agent');
    const current = await state();
    const why = unavailable(current, agent);
    if (why) throw new ApiError(409, 'mailbox_unavailable', 'This Agent has no mailbox now.', { reason: why });
    const box = await ensureMailbox(agent);
    return { box, agent, address: addressOf(box, current.domain!), current };
  }

  async function screenedCount(agentId: string): Promise<number> {
    const [row] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(mailMessages)
      .where(and(eq(mailMessages.agentId, agentId), eq(mailMessages.status, 'screened')));
    return row?.n ?? 0;
  }

  async function mailboxView(own: OwnBox & { current: MailState }): Promise<Mailbox> {
    const senders = await getDb()
      .select()
      .from(mailSenders)
      .where(eq(mailSenders.agentId, own.agent.id))
      .orderBy(asc(mailSenders.createdAt), asc(mailSenders.address));
    return {
      available: true,
      address: own.address,
      local_part: own.box.localPart,
      domain: own.current.domain!,
      allow_members: own.box.allowMembers,
      senders: senders.map((row) => ({ address: row.address, created_at: row.createdAt })),
      screened_count: await screenedCount(own.agent.id),
    };
  }

  /** Whether mail from this address may wake the Agent: its owner, a member (when allowed), or one let in. */
  async function senderAllowed(box: AgentMailbox, agent: AgentRow, address: string): Promise<boolean> {
    const [person] = await getDb()
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.email, address), eq(members.status, 'active')));
    if (person && (person.id === agent.ownerId || box.allowMembers)) return true;
    const [listed] = await getDb()
      .select({ address: mailSenders.address })
      .from(mailSenders)
      .where(and(eq(mailSenders.agentId, agent.id), eq(mailSenders.address, address)));
    return !!listed;
  }

  // ─── received mail ──────────────────────────────────────

  async function noticeSeen(key: string): Promise<boolean> {
    const [row] = await getDb()
      .select({ key: idempotencyKeys.key })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.scope, NOTICE_SCOPE),
          eq(idempotencyKeys.key, key),
          gt(idempotencyKeys.expiresAt, sql`now()`),
        ),
      );
    return !!row;
  }

  /** A vendor's nonce is acted on once; old ones are dropped as new ones come. */
  async function rememberNotice(key: string, ttlSeconds: number): Promise<void> {
    await getDb()
      .delete(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, NOTICE_SCOPE), lt(idempotencyKeys.expiresAt, sql`now()`)));
    await getDb()
      .insert(idempotencyKeys)
      .values({
        scope: NOTICE_SCOPE,
        key,
        requestHash: key,
        status: 'done',
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      })
      .onConflictDoUpdate({
        target: [idempotencyKeys.scope, idempotencyKeys.key],
        set: { expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() },
      });
  }

  /** The HTML body and the attachments as files of the Agent's owner. */
  async function storeParts(ownerId: string, agentId: string, mail: InboundMail) {
    const ids: string[] = [];
    const meta = { agent_id: agentId };
    let htmlFileId: string | null = null;
    if (mail.html) {
      const file = await deps.files.store(ownerId, {
        name: 'message.html',
        contentType: 'text/html',
        bytes: new TextEncoder().encode(mail.html),
        purpose: 'mail',
        meta,
      });
      htmlFileId = file.id;
      ids.push(file.id);
    }
    const attachments: StoredMailAttachment[] = [];
    for (const part of mail.attachments) {
      let fileId: string | null = null;
      if (part.content) {
        const file = await deps.files.store(ownerId, {
          name: part.filename,
          contentType: part.contentType,
          bytes: part.content,
          purpose: 'mail',
          meta,
        });
        fileId = file.id;
        ids.push(file.id);
      }
      attachments.push({
        fileId,
        name: part.filename,
        contentType: part.contentType,
        size: part.size,
        inline: part.inline,
        ...(part.contentId ? { contentId: part.contentId } : {}),
        ...(part.skipped ? { skipped: part.skipped } : {}),
      });
    }
    return { htmlFileId, attachments, ids };
  }

  async function screenOf(
    box: AgentMailbox,
    agent: AgentRow,
    mail: InboundMail,
  ): Promise<{ status: 'delivered' | 'screened'; reason: MailMessageRow['screenReason']; verified: boolean }> {
    const verified = senderVerified(mail);
    if (agent.archivedAt) return { status: 'screened', reason: 'archived', verified };
    if (agent.visibility === 'public') return { status: 'screened', reason: 'public_agent', verified };
    if (!(await senderAllowed(box, agent, mail.from.address)))
      return { status: 'screened', reason: 'sender', verified };
    if (!verified) return { status: 'screened', reason: 'unverified', verified };
    return { status: 'delivered', reason: null, verified };
  }

  /** The line in the transcript: who sent it and the mail's id, never what the sender wrote. */
  function cardLine(locale: Locale, row: MailMessageRow): string {
    const from = isAddress(row.fromAddress) ? row.fromAddress : '?';
    if (row.direction === 'out') {
      const to = row.to.map((entry) => entry.address).join(', ');
      return locale === 'zh' ? `已发出邮件给 ${to}（${row.id}）` : `Sent mail to ${to} (${row.id})`;
    }
    return locale === 'zh' ? `收到 ${from} 的邮件（${row.id}）` : `Mail from ${from} (${row.id})`;
  }

  /** Puts a mail's card in its Agent's thread (the main thread for the main Agent). */
  async function placeCard(row: MailMessageRow, agent: AgentRow, conversationId?: string | null): Promise<string> {
    const target = conversationId ?? (await deps.conversations.ensureDirect(agent.ownerId, agent.id)).id;
    const [owner] = await getDb().select({ locale: members.locale }).from(members).where(eq(members.id, agent.ownerId));
    const line = await deps.conversations.append(target, {
      role: 'event',
      agentId: agent.id,
      content: cardLine(localeOf(owner?.locale), row),
      event: {
        type: 'mail',
        mail_id: row.id,
        direction: row.direction,
        from: addressView({ address: row.fromAddress, ...(row.fromName ? { name: row.fromName } : {}) }),
        to: row.to.map(addressView),
        subject: row.subject,
        attachment_count: row.attachments.length,
        verified: row.verified,
      },
    });
    await getDb()
      .update(mailMessages)
      .set({ conversationId: target, updatedAt: sql`now()` })
      .where(eq(mailMessages.id, row.id));
    await deps.conversations.publish(target, { type: 'message.created', data: { message: toMessage(line) } });
    return target;
  }

  /** Wakes the Agent once for these mails, unless it was woken by mail too often today. */
  async function wake(agent: AgentRow, conversationId: string, rows: MailMessageRow[], released: boolean) {
    const [{ n }] = (await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(mailMessages)
      .where(and(eq(mailMessages.agentId, agent.id), gt(mailMessages.wokeAt, sql`now() - interval '1 day'`)))) as [
      { n: number },
    ];
    if (n >= MAIL_WAKES_PER_DAY) {
      logger.warn('[mail] an Agent reached its daily mail wake-ups; mail waits in its thread', { agent: agent.id });
      return;
    }
    await getDb()
      .update(mailMessages)
      .set({ wokeAt: sql`now()` })
      .where(
        inArray(
          mailMessages.id,
          rows.map((row) => row.id),
        ),
      );
    await wakeForMail(deps.engine(), {
      conversationId,
      agentId: agent.id,
      memberId: agent.ownerId,
      mails: rows.map((row) => ({ id: row.id, from: row.fromAddress, subject: row.subject })),
      released,
    });
  }

  /** One received mail for one Agent: kept once, then delivered with a wake or screened. */
  async function accept(
    box: AgentMailbox,
    agent: AgentRow,
    instanceId: string,
    mail: InboundMail,
  ): Promise<'delivered' | 'screened' | 'duplicate'> {
    const [already] = await getDb()
      .select({ id: mailMessages.id })
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.agentId, agent.id),
          eq(mailMessages.providerId, instanceId),
          eq(mailMessages.providerMessageId, mail.providerMessageId),
          eq(mailMessages.direction, 'in'),
        ),
      );
    if (already) return 'duplicate';
    const decision = await screenOf(box, agent, mail);
    const parts = await storeParts(agent.ownerId, agent.id, mail);
    const [row] = await getDb()
      .insert(mailMessages)
      .values({
        id: newId('mail'),
        agentId: agent.id,
        ownerId: agent.ownerId,
        direction: 'in',
        status: decision.status,
        screenReason: decision.reason,
        providerId: instanceId,
        providerMessageId: mail.providerMessageId,
        messageId: mail.messageId,
        inReplyTo: mail.inReplyTo,
        references: mail.references,
        fromAddress: mail.from.address,
        fromName: mail.from.name ? cutText(mail.from.name, 200) : null,
        to: mail.to.map(stored),
        cc: mail.cc.map(stored),
        replyTo: mail.replyTo.map(stored),
        subject: mail.subject,
        text: mail.text,
        htmlFileId: parts.htmlFileId,
        attachments: parts.attachments,
        auth: mail.auth,
        verified: decision.verified,
        at: mail.receivedAt,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      // The same mail arrived twice at once; the other copy keeps it.
      for (const id of parts.ids) await deps.files.discard(id);
      return 'duplicate';
    }
    if (row.status === 'delivered') {
      const conversationId = await placeCard(row, agent);
      await wake(agent, conversationId, [row], false);
    }
    logger.info('[mail] received', { agent: agent.id, mail: row.id, status: row.status, reason: row.screenReason });
    return row.status === 'delivered' ? 'delivered' : 'screened';
  }

  async function readOwned(
    memberId: string,
    agentIdOrHandle: string,
    mailId: string,
  ): Promise<{ row: MailMessageRow; agent: AgentRow }> {
    const agent = await deps.agents.findOwn(memberId, agentIdOrHandle);
    if (!agent) throw notFound('Agent');
    const [row] = await getDb()
      .select()
      .from(mailMessages)
      .where(and(eq(mailMessages.id, mailId), eq(mailMessages.agentId, agent.id)));
    if (!row) throw notFound('Mail');
    return { row, agent };
  }

  const itemOf = (row: MailMessageRow): MailItem => ({
    id: row.id,
    agent_id: row.agentId,
    direction: row.direction,
    status: row.status,
    screen_reason: row.screenReason,
    from: addressView({ address: row.fromAddress, ...(row.fromName ? { name: row.fromName } : {}) }),
    to: row.to.map(addressView),
    cc: row.cc.map(addressView),
    subject: row.subject,
    preview: preview(row.text),
    attachment_count: row.attachments.length,
    verified: row.verified,
    conversation_id: row.conversationId,
    at: row.at,
  });

  async function detailOf(row: MailMessageRow, readerId: string): Promise<MailDetail> {
    let html: string | null = null;
    if (row.htmlFileId) {
      try {
        html = new TextDecoder().decode((await deps.files.bytes(readerId, row.htmlFileId)).bytes);
      } catch (error) {
        logger.warn('[mail] the HTML of a mail could not be read', { mail: row.id, error: toErrorMessage(error) });
      }
    }
    return {
      ...itemOf(row),
      reply_to: row.replyTo.map(addressView),
      text: row.text,
      html,
      attachments: row.attachments.map((part) => ({
        name: part.name,
        content_type: part.contentType,
        size_bytes: part.size,
        content_id: part.contentId ?? null,
        inline: part.inline,
        url: part.fileId ? deps.files.signedUrl(part.fileId, readerId).url : null,
        skipped: part.skipped ?? null,
      })),
      message_id: row.messageId,
      in_reply_to: row.inReplyTo,
      auth: row.auth,
      error: row.error,
    };
  }

  // ─── the Agent's own reading and sending (the mail tool) ─────────

  /** The Agent's mailbox in a turn: its owner's own Agent, mailboxes on, not public or archived. */
  async function boxForTool(memberId: string, agent: AgentRow): Promise<OwnBox> {
    if (agent.ownerId !== memberId) throw new Error('Only the Agent working for its owner uses its mailbox.');
    const current = await state();
    const why = unavailable(current, agent);
    if (why) throw new Error('This Agent has no mailbox now.');
    const box = await ensureMailbox(agent);
    return { box, agent, address: addressOf(box, current.domain!) };
  }

  const readable = or(eq(mailMessages.status, 'delivered'), eq(mailMessages.direction, 'out'));

  const service = {
    state,
    inboundUrl,

    /** Whether Agent mailboxes exist now (the mail tool and the profile tab follow it). */
    async mailboxesOn(): Promise<boolean> {
      return (await state()).mailboxes;
    },

    // ─── system mail ────────────────────────────────────

    /** One system mail to one person; how it went, for the link the admin still sees. */
    async sendSystem(to: MailAddress, content: SystemMail): Promise<LinkDelivery> {
      try {
        const result = await sendThrough({
          to: [to],
          subject: content.subject,
          text: content.text,
          html: content.html,
        });
        return result ? 'emailed' : 'shown';
      } catch (error) {
        logger.warn('[mail] system mail failed', { error: toErrorMessage(error) });
        return 'failed';
      }
    },

    /**
     * Mails a one-time link to its member (an invitation or a reset) and records how it went on
     * the link. The link stays for the admin to copy either way.
     */
    async sendLink(
      member: Pick<Member, 'id' | 'email' | 'name' | 'locale'>,
      purpose: 'activate' | 'reset',
      url: string,
      inviterName: string,
    ): Promise<LinkDelivery> {
      const locale = localeOf(member.locale);
      const days = Math.round(LINK_TTL_SECONDS / 86_400);
      const name = await workspaceName();
      const content =
        purpose === 'activate'
          ? inviteMail({ locale, workspace: name, inviter: inviterName, name: member.name, url, days })
          : resetMail({ locale, workspace: name, name: member.name, url, days });
      const delivery = await service.sendSystem({ address: member.email, name: member.name }, content);
      if (delivery !== 'shown') {
        await getDb()
          .update(authLinks)
          .set({ deliveryStatus: delivery })
          .where(
            and(
              eq(authLinks.memberId, member.id),
              sql`${authLinks.consumedAt} is null`,
              sql`${authLinks.revokedAt} is null`,
            ),
          );
      }
      return delivery;
    },

    // ─── 管理 → 服务 → 邮箱 ──────────────────────────────

    async adminView(): Promise<AdminMail> {
      const current = await state();
      return {
        can_send: current.canSend,
        agent_domain: current.domain,
        agent_domain_source: current.domainSource,
        agent_domain_env: current.envDomain,
        mailboxes: current.mailboxes,
        receivers: current.order
          .filter((instance) => instance.receives)
          .map((instance) => ({
            instance_id: instance.id,
            name: instance.name,
            kind: instance.kind,
            inbound_url: inboundUrl(instance.id),
            primary: current.order[0]?.id === instance.id,
          })),
      };
    },

    async saveAdmin(actorId: string, input: UpdateAdminMailInput): Promise<AdminMail> {
      await transaction(async () => {
        const defaults = { ...(await deps.providers.defaultsBySource('mail')).saved };
        if (input.agent_domain === null) delete defaults.agent_domain;
        else defaults.agent_domain = input.agent_domain;
        await deps.providers.setDefaults(actorId, 'mail', defaults);
        await audit({
          actorId,
          action: 'mail.domain',
          resourceType: 'provider_binding',
          resourceId: 'mail',
          summary: input.agent_domain === null ? 'agent_domain cleared' : 'agent_domain',
        });
      });
      return service.adminView();
    },

    /** A test mail to the admin, through the first instance that sends. */
    async test(actorId: string): Promise<MailTest> {
      const started = Date.now();
      const [member] = await getDb().select().from(members).where(eq(members.id, actorId));
      if (!member) throw notFound('Member');
      const current = await state();
      if (!current.canSend) throw new ApiError(409, 'mail_not_configured', 'Set up a mail service first.');
      try {
        const content = testMail({
          locale: localeOf(member.locale),
          workspace: await workspaceName(),
          instance: current.order[0]!.name,
        });
        const result = await sendThrough({
          to: [{ address: member.email, name: member.name }],
          subject: content.subject,
          text: content.text,
          html: content.html,
        });
        return { ok: true, instance: result?.instance.name ?? null, latency_ms: Date.now() - started, error: null };
      } catch (error) {
        return {
          ok: false,
          instance: null,
          latency_ms: Date.now() - started,
          error: toErrorMessage(error).slice(0, 300),
        };
      }
    },

    // ─── an Agent's mailbox (its owner) ─────────────────

    async mailbox(memberId: string, idOrHandle: string): Promise<Mailbox> {
      const agent = await deps.agents.findOwn(memberId, idOrHandle);
      if (!agent) throw notFound('Agent');
      const current = await state();
      const why = unavailable(current, agent);
      if (why) return { available: false, reason: why };
      const box = await ensureMailbox(agent);
      return mailboxView({ box, agent, address: addressOf(box, current.domain!), current });
    },

    async updateMailbox(memberId: string, idOrHandle: string, input: UpdateMailboxInput): Promise<Mailbox> {
      const own = await ownBox(memberId, idOrHandle);
      if (input.local_part !== undefined && input.local_part !== own.box.localPart) {
        const reserved =
          RESERVED_LOCAL_PARTS.has(input.local_part) ||
          own.current.order.some(
            (instance) =>
              instance.fromAddress &&
              domainOf(instance.fromAddress) === own.current.domain &&
              localPartOf(instance.fromAddress) === input.local_part,
          );
        if (reserved) throw conflict('mailbox_reserved', 'This address is reserved. Pick another.');
      }
      try {
        // In its own savepoint: a taken address fails this statement only.
        const [row] = await transaction((db) =>
          db
            .update(agentMailboxes)
            .set({
              ...(input.local_part !== undefined ? { localPart: input.local_part } : {}),
              ...(input.allow_members !== undefined ? { allowMembers: input.allow_members } : {}),
              updatedAt: sql`now()`,
            })
            .where(eq(agentMailboxes.id, own.box.id))
            .returning(),
        );
        own.box = row!;
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict('mailbox_taken', 'Another Agent already has this address.');
        throw error;
      }
      return mailboxView({ ...own, address: addressOf(own.box, own.current.domain!) });
    },

    async addSender(memberId: string, idOrHandle: string, address: string): Promise<Mailbox> {
      const own = await ownBox(memberId, idOrHandle);
      await getDb()
        .insert(mailSenders)
        .values({ agentId: own.agent.id, address: address.toLowerCase(), addedBy: memberId })
        .onConflictDoNothing();
      return mailboxView(own);
    },

    async removeSender(memberId: string, idOrHandle: string, address: string): Promise<Mailbox> {
      const own = await ownBox(memberId, idOrHandle);
      await getDb()
        .delete(mailSenders)
        .where(and(eq(mailSenders.agentId, own.agent.id), eq(mailSenders.address, address.toLowerCase())));
      return mailboxView(own);
    },

    async list(
      memberId: string,
      idOrHandle: string,
      query: { status?: MailItem['status']; cursor?: string; limit: number },
    ): Promise<Page<MailItem>> {
      const agent = await deps.agents.findOwn(memberId, idOrHandle);
      if (!agent) throw notFound('Agent');
      const before = decodeCursor(query.cursor);
      const rows = await getDb()
        .select()
        .from(mailMessages)
        .where(
          and(
            eq(mailMessages.agentId, agent.id),
            query.status ? eq(mailMessages.status, query.status) : undefined,
            before ? lt(mailMessages.id, before) : undefined,
          ),
        )
        .orderBy(desc(mailMessages.id))
        .limit(query.limit + 1);
      return toPage(rows, query.limit, itemOf);
    },

    async get(memberId: string, idOrHandle: string, mailId: string): Promise<MailDetail> {
      const { row } = await readOwned(memberId, idOrHandle, mailId);
      return detailOf(row, memberId);
    },

    /**
     * Lets a screened mail's sender in: they join the sender list (unless they could already wake
     * the Agent and only failed verification), every mail of theirs that waited goes into the
     * thread, and the Agent is woken once: the owner decided.
     */
    async release(memberId: string, idOrHandle: string, mailId: string): Promise<MailRelease> {
      const { row, agent } = await readOwned(memberId, idOrHandle, mailId);
      if (row.status !== 'screened') throw conflict('mail_not_screened', 'This mail is not waiting to be let in.');
      const current = await state();
      const why = unavailable(current, agent);
      if (why) throw new ApiError(409, 'mailbox_unavailable', 'This Agent has no mailbox now.', { reason: why });
      const box = await ensureMailbox(agent);
      const sender = row.fromAddress;
      if (!(await senderAllowed(box, agent, sender))) {
        await getDb()
          .insert(mailSenders)
          .values({ agentId: agent.id, address: sender, addedBy: memberId })
          .onConflictDoNothing();
      }
      const released = await getDb()
        .update(mailMessages)
        .set({ status: 'delivered', screenReason: null, updatedAt: sql`now()` })
        .where(
          and(
            eq(mailMessages.agentId, agent.id),
            eq(mailMessages.status, 'screened'),
            or(eq(mailMessages.id, row.id), eq(mailMessages.fromAddress, sender)),
          ),
        )
        .returning();
      released.sort((a, b) => a.id.localeCompare(b.id));
      let conversationId: string | null = null;
      for (const mail of released) conversationId = await placeCard(mail, agent, conversationId);
      if (conversationId && released.length) await wake(agent, conversationId, released, true);
      return { delivered: released.length, sender };
    },

    // ─── the inbound route ──────────────────────────────

    /**
     * A vendor's notice at /api/mail/inbound/:instance. The signature is checked first; the mail
     * is then fetched from the vendor and kept for every Agent mailbox among its recipients.
     */
    async receive(
      instanceId: string,
      request: { headers: Headers; body: Uint8Array },
    ): Promise<{ status: 'ok' | 'ignored' | 'duplicate'; delivered: number; screened: number }> {
      const current = await state();
      if (!current.order.some((instance) => instance.id === instanceId && instance.receives)) {
        throw notFound('Mail receiver');
      }
      const receiver = (await deps.providers.byId('mail', instanceId, {}))?.client.receive;
      if (!receiver) throw notFound('Mail receiver');
      if (request.body.byteLength > receiver.maxNoticeBytes) {
        throw new ApiError(413, 'too_large', 'The notice is too large.');
      }
      let notice;
      try {
        notice = await receiver.verify({ headers: request.headers, body: request.body });
      } catch (error) {
        if (error instanceof MailSignatureError) {
          logger.warn('[mail] refused a notice', { instance: instanceId, error: error.message });
          throw new ApiError(401, 'invalid_signature', error.message);
        }
        throw error;
      }
      if (!notice) return { status: 'ignored', delivered: 0, screened: 0 };
      const key = hash(`${instanceId}\n${notice.nonce}`);
      if (await noticeSeen(key)) return { status: 'duplicate', delivered: 0, screened: 0 };
      if (!current.mailboxes || !current.domain) {
        logger.warn('[mail] a notice arrived while Agent mailboxes are off; dropped', { instance: instanceId });
        await rememberNotice(key, notice.nonceTtlSeconds);
        return { status: 'ignored', delivered: 0, screened: 0 };
      }
      let mail: InboundMail;
      try {
        mail = await receiver.fetch(notice);
      } catch (error) {
        // The vendor retries the notice; nothing was kept.
        logger.warn('[mail] could not fetch a received mail', { instance: instanceId, error: toErrorMessage(error) });
        throw new ApiError(502, 'mail_fetch_failed', 'The mail could not be fetched from the mail service.');
      }
      const domain = current.domain;
      const addressed = [
        ...new Set([
          ...mail.recipients,
          ...mail.to.map((entry) => entry.address),
          ...mail.cc.map((entry) => entry.address),
        ]),
      ].filter((address) => domainOf(address) === domain);
      const boxes = addressed.length
        ? await getDb()
            .select({ box: agentMailboxes, agent: agents })
            .from(agentMailboxes)
            .innerJoin(agents, eq(agents.id, agentMailboxes.agentId))
            .where(inArray(agentMailboxes.localPart, addressed.map(localPartOf)))
        : [];
      let delivered = 0;
      let screened = 0;
      let duplicate = boxes.length > 0;
      for (const { box, agent } of boxes) {
        const outcome = await accept(box, agent, instanceId, mail);
        if (outcome !== 'duplicate') duplicate = false;
        if (outcome === 'delivered') delivered++;
        if (outcome === 'screened') screened++;
      }
      if (!boxes.length) logger.info('[mail] a mail named no Agent mailbox', { instance: instanceId });
      await rememberNotice(key, notice.nonceTtlSeconds);
      return { status: duplicate ? 'duplicate' : 'ok', delivered, screened };
    },

    // ─── the mail tool ──────────────────────────────────

    boxForTool,

    async toolList(
      memberId: string,
      agent: AgentRow,
      input: { folder: 'inbox' | 'sent'; limit: number; before?: string | undefined },
    ) {
      const own = await boxForTool(memberId, agent);
      const rows = await getDb()
        .select()
        .from(mailMessages)
        .where(
          and(
            eq(mailMessages.agentId, agent.id),
            input.folder === 'inbox'
              ? and(eq(mailMessages.direction, 'in'), eq(mailMessages.status, 'delivered'))
              : eq(mailMessages.direction, 'out'),
            input.before ? lt(mailMessages.id, input.before) : undefined,
          ),
        )
        .orderBy(desc(mailMessages.id))
        .limit(input.limit + 1);
      return { address: own.address, rows: rows.slice(0, input.limit), more: rows.length > input.limit };
    },

    async toolSearch(memberId: string, agent: AgentRow, query: string, limit: number) {
      const own = await boxForTool(memberId, agent);
      const pattern = containing(query);
      const rows = await getDb()
        .select()
        .from(mailMessages)
        .where(
          and(
            eq(mailMessages.agentId, agent.id),
            readable,
            or(
              ilike(mailMessages.subject, pattern),
              ilike(mailMessages.fromAddress, pattern),
              ilike(mailMessages.fromName, pattern),
              ilike(mailMessages.text, pattern),
            ),
          ),
        )
        .orderBy(desc(mailMessages.id))
        .limit(limit);
      return { address: own.address, rows };
    },

    /** One mail the Agent may read: delivered or sent, never one still screened. */
    async toolRead(memberId: string, agent: AgentRow, mailId: string) {
      await boxForTool(memberId, agent);
      const [row] = await getDb()
        .select()
        .from(mailMessages)
        .where(and(eq(mailMessages.id, mailId), eq(mailMessages.agentId, agent.id), readable));
      if (!row) throw new Error(`There is no mail ${mailId} in your mailbox.`);
      return { row, text: cutText(row.text, READ_TEXT_MAX), cut: row.text.length > READ_TEXT_MAX };
    },

    /**
     * The mail a send or reply call would write: recipients, subject and threading worked out from
     * what it answers. The card shows this and the approved call sends exactly this.
     */
    async draftOf(
      memberId: string,
      agent: AgentRow,
      input:
        | { action: 'send'; to: string[]; cc: string[]; subject: string; body: string }
        | { action: 'reply'; id: string; body: string; reply_all: boolean },
    ): Promise<MailDraft & { from: string }> {
      const own = await boxForTool(memberId, agent);
      const self = own.address;
      const clean = (list: string[]) => [
        ...new Set(list.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry && entry !== self)),
      ];
      let draft: MailDraft;
      if (input.action === 'send') {
        draft = {
          to: clean(input.to).map((address) => ({ address })),
          cc: clean(input.cc).map((address) => ({ address })),
          subject: input.subject.replace(/\s+/g, ' ').trim(),
          text: input.body,
        };
      } else {
        const [original] = await getDb()
          .select()
          .from(mailMessages)
          .where(and(eq(mailMessages.id, input.id), eq(mailMessages.agentId, agent.id), readable));
        if (!original) throw new Error(`There is no mail ${input.id} in your mailbox to reply to.`);
        const back =
          original.direction === 'in'
            ? original.replyTo.length
              ? original.replyTo
              : [{ address: original.fromAddress }]
            : original.to;
        const others = input.reply_all ? [...original.to, ...original.cc].map((entry) => entry.address) : [];
        const to = clean(back.map((entry) => entry.address));
        draft = {
          to: to.map((address) => ({ address })),
          cc: clean(others)
            .filter((address) => !to.includes(address))
            .map((address) => ({ address })),
          subject: replySubject(original.subject),
          text: input.body,
          ...(original.messageId ? { inReplyTo: original.messageId } : {}),
          references: [...original.references, ...(original.messageId ? [original.messageId] : [])].slice(-50),
          replyOf: original.id,
        };
      }
      const all = [...draft.to, ...draft.cc];
      if (!draft.to.length) throw new Error('Name at least one recipient.');
      if (all.length > MAIL_RECIPIENTS_MAX) throw new Error(`At most ${MAIL_RECIPIENTS_MAX} recipients per mail.`);
      const bad = all.find((entry) => !isAddress(entry.address));
      if (bad) throw new Error(`"${bad.address}" is not an email address.`);
      if (!draft.subject) throw new Error('Write a subject.');
      return { ...draft, from: self };
    },

    /** Sends a mail the owner approved, from the Agent's address; its card goes into the thread. */
    async sendAsAgent(
      memberId: string,
      agent: AgentRow,
      draft: MailDraft,
      context: { conversationId: string | null; runId: string | null },
    ): Promise<{ id: string; status: 'sent' | 'failed'; to: string[]; error?: string }> {
      const own = await boxForTool(memberId, agent);
      const [{ n }] = (await getDb()
        .select({ n: sql<number>`count(*)::int` })
        .from(mailMessages)
        .where(
          and(
            eq(mailMessages.agentId, agent.id),
            eq(mailMessages.direction, 'out'),
            ne(mailMessages.status, 'failed'),
            gt(mailMessages.at, sql`now() - interval '1 day'`),
          ),
        )) as [{ n: number }];
      if (n >= MAIL_SENDS_PER_DAY) throw new Error(`This Agent already sent ${MAIL_SENDS_PER_DAY} mails today.`);
      const [row] = await getDb()
        .insert(mailMessages)
        .values({
          id: newId('mail'),
          agentId: agent.id,
          ownerId: agent.ownerId,
          direction: 'out',
          status: 'sending',
          inReplyTo: draft.inReplyTo ?? null,
          references: draft.references ?? [],
          fromAddress: own.address,
          fromName: agent.name,
          to: draft.to.map(stored),
          cc: draft.cc.map(stored),
          subject: draft.subject,
          text: draft.text,
          runId: context.runId,
          verified: true,
        })
        .returning();
      let result: Awaited<ReturnType<typeof sendThrough>>;
      try {
        result = await sendThrough(
          {
            from: { address: own.address, name: agent.name },
            to: draft.to,
            cc: draft.cc,
            subject: draft.subject,
            text: draft.text,
            ...(draft.inReplyTo ? { inReplyTo: draft.inReplyTo } : {}),
            ...(draft.references?.length ? { references: draft.references } : {}),
            idempotencyKey: row!.id,
          },
          { memberId, agentId: agent.id },
        );
        if (!result) throw new Error('No mail service can send now.');
      } catch (error) {
        const message = toErrorMessage(error).slice(0, 500);
        await getDb()
          .update(mailMessages)
          .set({ status: 'failed', error: message, updatedAt: sql`now()` })
          .where(eq(mailMessages.id, row!.id));
        return { id: row!.id, status: 'failed', to: draft.to.map((entry) => entry.address), error: message };
      }
      const [sent] = await getDb()
        .update(mailMessages)
        .set({
          status: 'sent',
          providerId: result.instance.id,
          providerMessageId: result.sent.providerId,
          messageId: result.sent.messageId,
          at: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(mailMessages.id, row!.id))
        .returning();
      await placeCard(sent!, agent, context.conversationId).catch((error: unknown) =>
        logger.warn('[mail] could not show a sent mail in its thread', { mail: row!.id, error: toErrorMessage(error) }),
      );
      return { id: row!.id, status: 'sent', to: draft.to.map((entry) => entry.address) };
    },
  };
  return service;
}

export type MailService = ReturnType<typeof createMailService>;
