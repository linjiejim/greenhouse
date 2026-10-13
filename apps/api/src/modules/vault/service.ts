/**
 * The password vault: logins a member keeps for their own Agents. Values are write-only: they
 * come in through create and update and leave only through `reveal`, which the fill alone calls
 * to type them into a page. Every read (the member's pages, an Agent's `find`, a sign-in card)
 * gets the label, the sites and a masked user name. Admins have no way in; the access log is the
 * member's own.
 */

import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { CreateVaultItemInput, Page, UpdateVaultItemInput, VaultAccess, VaultItem } from '@greenhouse/contract';
import {
  agents,
  getDb,
  newId,
  vaultAccessLog,
  vaultItems,
  type VaultApproval,
  type VaultItem as VaultItemRow,
  type VaultOutcome,
} from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import type { AppConfig } from '../../config/index.js';
import { invalidInput, notFound } from '../../http/errors.js';
import { decodeCursor, encodeCursor, toPage } from '../../http/pagination.js';
import type { Hub } from '../../realtime/hub.js';
import { createVaultCrypto, vaultUnavailable, type VaultColumn } from './crypto.js';
import { normalizeSite, normalizeSites, originMatches, type OriginPolicy } from './origin.js';
import { parseTotp, totpSecretText } from './totp.js';

/** What a model or a card may know about a login. */
export interface VaultMatch {
  id: string;
  label: string;
  username_hint: string;
  has_password: boolean;
  has_totp: boolean;
}

export interface VaultSecrets {
  username?: string;
  password?: string;
  totp?: string;
}

/** `ji***@example.com`, `li***m`, `a***`: enough to tell logins apart, not to use one. */
export function maskUsername(username: string): string {
  const value = username.trim();
  if (!value) return '';
  const at = value.indexOf('@');
  if (at > 0) {
    const local = value.slice(0, at);
    return `${local.slice(0, Math.min(2, Math.max(1, local.length - 1)))}***${value.slice(at)}`;
  }
  const chars = [...value];
  if (chars.length <= 3) return `${chars[0]}***`;
  return `${chars.slice(0, 2).join('')}***${chars[chars.length - 1]}`;
}

const toItem = (row: VaultItemRow): VaultItem => ({
  id: row.id,
  label: row.label,
  origins: row.origins,
  username_hint: row.usernameHint,
  has_username: !!row.usernameEnc,
  has_password: !!row.passwordEnc,
  has_totp: !!row.totpEnc,
  policy: row.policy,
  always_origins: row.alwaysOrigins,
  agent_ids: row.agentIds,
  last_used_at: row.lastUsedAt,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
});

const toAccess = (row: typeof vaultAccessLog.$inferSelect): VaultAccess => ({
  id: String(row.id),
  item_id: row.itemId,
  item_label: row.itemLabel,
  agent_id: row.agentId,
  conversation_id: row.conversationId,
  origin: row.origin,
  action: row.action,
  outcome: row.outcome,
  approval: row.approval,
  created_at: row.createdAt,
});

/** One line, as typed: a value with a line break would submit a form half-way. */
function oneLine(value: string, what: string): string {
  if (/[\r\n]/.test(value)) throw invalidInput(`The ${what} cannot contain a line break.`);
  return value;
}

export function createVaultService(deps: { config: AppConfig; hub: Hub; forbiddenOrigins: readonly string[] }) {
  const crypto = createVaultCrypto(deps.config.vaultEncryptionKey);
  const policy: OriginPolicy = { nodeEnv: deps.config.NODE_ENV, forbidden: deps.forbiddenOrigins };

  const announce = (memberId: string, itemId: string | null) =>
    deps.hub.publish([memberId], { type: 'vault.updated', data: { item_id: itemId } });

  function ready() {
    if (!crypto.available) throw vaultUnavailable();
  }

  async function own(memberId: string, id: string): Promise<VaultItemRow> {
    const [row] = await getDb()
      .select()
      .from(vaultItems)
      .where(and(eq(vaultItems.id, id), eq(vaultItems.memberId, memberId)));
    if (!row) throw notFound('Login');
    return row;
  }

  /** The member's own Agents only; empty means all of them. */
  async function ownAgents(memberId: string, ids: readonly string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    const found = await getDb()
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.ownerId, memberId), inArray(agents.id, unique)));
    if (found.length !== unique.length) throw invalidInput('Choose among your own Agents.');
    return unique;
  }

  /** Exact sites within the login's own: "always allowed" never widens where it is filled. */
  function alwaysWithin(origins: readonly string[], always: readonly string[]): string[] {
    const out = new Set<string>();
    for (const raw of always) {
      const site = normalizeSite(raw, policy);
      if (site.startsWith('*.') || !originMatches(origins, site)) {
        throw invalidInput(`"${raw.slice(0, 100)}" is not one of this login's sites.`);
      }
      out.add(site);
    }
    return [...out];
  }

  function sealed(memberId: string, itemId: string, column: VaultColumn, value: string): string | null {
    return value ? crypto.seal(memberId, itemId, column, value) : null;
  }

  const service = {
    get available() {
      return crypto.available;
    },

    async list(memberId: string, query: { cursor?: string; limit: number }): Promise<Page<VaultItem>> {
      ready();
      const before = decodeCursor(query.cursor);
      const rows = await getDb()
        .select()
        .from(vaultItems)
        .where(and(eq(vaultItems.memberId, memberId), before ? lt(vaultItems.id, before) : undefined))
        .orderBy(desc(vaultItems.id))
        .limit(query.limit + 1);
      return toPage(rows, query.limit, toItem);
    },

    async get(memberId: string, id: string): Promise<VaultItem> {
      ready();
      return toItem(await own(memberId, id));
    },

    async create(memberId: string, input: CreateVaultItemInput): Promise<VaultItem> {
      ready();
      const username = oneLine((input.username ?? '').trim(), 'user name');
      const password = oneLine(input.password ?? '', 'password');
      const totp = (input.totp ?? '').trim();
      if (!username && !password && !totp)
        throw invalidInput('Add a user name, a password or an authenticator secret.');
      if (totp) parseTotp(totp);
      const origins = normalizeSites(input.origins, policy);
      const id = newId('vaultItem');
      const [row] = await getDb()
        .insert(vaultItems)
        .values({
          id,
          memberId,
          label: input.label.trim(),
          origins,
          usernameEnc: sealed(memberId, id, 'username_enc', username),
          passwordEnc: sealed(memberId, id, 'password_enc', password),
          totpEnc: sealed(memberId, id, 'totp_enc', totp),
          usernameHint: maskUsername(username),
          policy: input.policy ?? 'ask',
          alwaysOrigins: alwaysWithin(origins, input.always_origins ?? []),
          agentIds: await ownAgents(memberId, input.agent_ids ?? []),
        })
        .returning();
      announce(memberId, id);
      return toItem(row!);
    },

    /** A value left out stays as it is; an empty one is removed. */
    async update(memberId: string, id: string, input: UpdateVaultItemInput): Promise<VaultItem> {
      ready();
      const current = await own(memberId, id);
      const set: Partial<typeof vaultItems.$inferInsert> = { updatedAt: new Date().toISOString() };
      if (input.label !== undefined) set.label = input.label.trim();
      const origins = input.origins !== undefined ? normalizeSites(input.origins, policy) : current.origins;
      if (input.origins !== undefined) set.origins = origins;
      if (input.always_origins !== undefined) set.alwaysOrigins = alwaysWithin(origins, input.always_origins);
      // Narrowed sites take their "always allowed" with them.
      else if (input.origins !== undefined)
        set.alwaysOrigins = current.alwaysOrigins.filter((site) => originMatches(origins, site));
      if (input.policy !== undefined) set.policy = input.policy;
      if (input.agent_ids !== undefined) set.agentIds = await ownAgents(memberId, input.agent_ids);
      if (input.username !== undefined) {
        const username = oneLine(input.username.trim(), 'user name');
        set.usernameEnc = sealed(memberId, id, 'username_enc', username);
        set.usernameHint = maskUsername(username);
      }
      if (input.password !== undefined)
        set.passwordEnc = sealed(memberId, id, 'password_enc', oneLine(input.password, 'password'));
      if (input.totp !== undefined) {
        const totp = input.totp.trim();
        if (totp) parseTotp(totp);
        set.totpEnc = sealed(memberId, id, 'totp_enc', totp);
      }
      const next = { ...current, ...set };
      if (!next.usernameEnc && !next.passwordEnc && !next.totpEnc) {
        throw invalidInput('A login needs a user name, a password or an authenticator secret.');
      }
      const [row] = await getDb()
        .update(vaultItems)
        .set(set)
        .where(and(eq(vaultItems.id, id), eq(vaultItems.memberId, memberId)))
        .returning();
      if (!row) throw notFound('Login');
      announce(memberId, id);
      return toItem(row);
    },

    async remove(memberId: string, id: string): Promise<void> {
      ready();
      const [row] = await getDb()
        .delete(vaultItems)
        .where(and(eq(vaultItems.id, id), eq(vaultItems.memberId, memberId)))
        .returning({ id: vaultItems.id });
      if (!row) throw notFound('Login');
      announce(memberId, id);
    },

    /** What the member's Agents did with the vault, newest first. Only theirs. */
    async log(memberId: string, query: { cursor?: string; limit: number }): Promise<Page<VaultAccess>> {
      ready();
      const before = decodeCursor(query.cursor);
      const beforeId = before && /^\d{1,18}$/.test(before) ? Number(before) : null;
      if (before && beforeId === null) throw invalidInput('The cursor is invalid.');
      const rows = await getDb()
        .select()
        .from(vaultAccessLog)
        .where(
          and(eq(vaultAccessLog.memberId, memberId), beforeId !== null ? lt(vaultAccessLog.id, beforeId) : undefined),
        )
        .orderBy(desc(vaultAccessLog.id))
        .limit(query.limit + 1);
      const more = rows.length > query.limit;
      const items = more ? rows.slice(0, query.limit) : rows;
      return {
        items: items.map(toAccess),
        next_cursor: more ? encodeCursor(String(items[items.length - 1]!.id)) : null,
      };
    },

    /** A login this Agent of the member may use; anything else is not found. */
    async forAgent(memberId: string, agentId: string, itemId: string): Promise<VaultItemRow> {
      ready();
      const row = await own(memberId, itemId);
      if (row.agentIds.length && !row.agentIds.includes(agentId)) throw notFound('Login');
      return row;
    },

    /** The logins this Agent may use on a page of this origin: never a value. */
    async matching(memberId: string, agentId: string, origin: string): Promise<VaultMatch[]> {
      ready();
      const rows = await getDb()
        .select()
        .from(vaultItems)
        .where(eq(vaultItems.memberId, memberId))
        .orderBy(vaultItems.label);
      return rows
        .filter((row) => (!row.agentIds.length || row.agentIds.includes(agentId)) && originMatches(row.origins, origin))
        .map((row) => ({
          id: row.id,
          label: row.label,
          username_hint: row.usernameHint,
          has_password: !!row.passwordEnc,
          has_totp: !!row.totpEnc,
        }));
    },

    /** Opens a login to type it. The fill is the only caller; nothing it returns is logged or shown. */
    reveal(row: VaultItemRow): VaultSecrets {
      const open = (column: VaultColumn, value: string | null) =>
        value ? crypto.open(row.memberId, row.id, column, value) : undefined;
      return {
        username: open('username_enc', row.usernameEnc),
        password: open('password_enc', row.passwordEnc),
        totp: open('totp_enc', row.totpEnc),
      };
    },

    /** One access-log row (never a value). A lost row never fails the fill it describes. */
    async record(entry: {
      memberId: string;
      item: Pick<VaultItemRow, 'id' | 'label'>;
      agentId: string;
      conversationId: string | null;
      origin: string;
      outcome: VaultOutcome;
      approval: VaultApproval | null;
    }): Promise<void> {
      try {
        await getDb().insert(vaultAccessLog).values({
          memberId: entry.memberId,
          itemId: entry.item.id,
          itemLabel: entry.item.label,
          agentId: entry.agentId,
          conversationId: entry.conversationId,
          origin: entry.origin,
          action: 'fill',
          outcome: entry.outcome,
          approval: entry.approval,
        });
        if (entry.outcome === 'filled') {
          await getDb()
            .update(vaultItems)
            .set({ lastUsedAt: new Date().toISOString() })
            .where(eq(vaultItems.id, entry.item.id));
        }
        announce(entry.memberId, entry.item.id);
      } catch (error) {
        logger.warn('[vault] could not write the access log', { outcome: entry.outcome, error: toErrorMessage(error) });
      }
    },

    /**
     * Every value of the member's vault, for redacting what an Agent reads from a page: a login
     * shown in plain text (a "show password" toggle, a profile page) never reaches a model.
     */
    async secretsOf(memberId: string): Promise<string[]> {
      if (!crypto.available) return [];
      const rows = await getDb().select().from(vaultItems).where(eq(vaultItems.memberId, memberId));
      const values: string[] = [];
      for (const row of rows) {
        try {
          const secrets = service.reveal(row);
          for (const value of [secrets.username, secrets.password, secrets.totp]) if (value) values.push(value);
          if (secrets.totp) values.push(totpSecretText(secrets.totp));
        } catch {
          // A login that no longer opens cannot be typed either.
        }
      }
      return values;
    },
  };
  return service;
}

export type VaultService = ReturnType<typeof createVaultService>;
