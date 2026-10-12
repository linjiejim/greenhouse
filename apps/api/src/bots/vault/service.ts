/**
 * Vault service — the only code that turns member input into vault rows and
 * vault rows into views. Write-only for secrets: they go in through
 * `createVaultItem` / `updateVaultItem` (HTTP console only) and come out
 * solely through `revealVaultSecrets`, which only the fill path calls. Every
 * read surface (HTTP, the model's `vault list`, hints, login cards) gets
 * metadata: label, sites, a masked username hint.
 *
 * Design: docs/specs/20261005-personal-assistant-bots.md §8.
 */

import type { DatabaseProvider, VaultItemRow } from '@greenhouse/db';
import { newVaultItemId } from '@greenhouse/db';
import type { VaultAccessView, VaultItemView, VaultItemWrite } from '@greenhouse/types/bots';
import { safeJsonParse } from '@greenhouse/utils/json';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { VaultError, decryptVaultField, encryptVaultField, isVaultAvailable } from './crypto.js';
import { hostOfOrigin, normalizeOriginPatterns, originMatches } from './origin.js';
import { parseTotpSecret } from './totp.js';

export const VAULT_LABEL_MAX = 60;
const USERNAME_MAX = 320;
const PASSWORD_MAX = 1024;
const TOTP_MAX = 1024;

type VaultAccessInput = Parameters<DatabaseProvider['vault']['logAccess']>[0];

/** Masked username for display: `ji***@gmail.com`, `li***m`, `a***`. */
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

export function vaultItemOrigins(row: Pick<VaultItemRow, 'origins'>): string[] {
  const parsed = safeJsonParse(row.origins, []);
  return Array.isArray(parsed) ? parsed.filter((o): o is string => typeof o === 'string') : [];
}

export function vaultItemAlwaysOrigins(row: Pick<VaultItemRow, 'always_origins'>): string[] {
  const parsed = safeJsonParse(row.always_origins, []);
  return Array.isArray(parsed) ? parsed.filter((o): o is string => typeof o === 'string') : [];
}

/** The Agents an entry is limited to (`bot_ids`); null = every Agent of the member. */
export function vaultItemBotIds(row: Pick<VaultItemRow, 'bot_ids'>): string[] | null {
  if (row.bot_ids === null || row.bot_ids === undefined) return null;
  const parsed = safeJsonParse(row.bot_ids, null);
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
}

/** May this Agent use the entry (spec 20261011-agent-first-class P3c)? */
export function vaultItemAllowsBot(row: Pick<VaultItemRow, 'bot_ids'>, botId: string): boolean {
  const ids = vaultItemBotIds(row);
  return ids === null || ids.includes(botId);
}

/** A write's `bot_ids`: the member's own Bots, deduplicated; null = every Agent. */
async function validBotIds(
  db: DatabaseProvider,
  userId: string,
  raw: string[] | null | undefined,
): Promise<string[] | null | undefined> {
  if (raw === undefined || raw === null) return raw;
  const ids = [...new Set(raw)];
  if (ids.length > 50) throw new VaultError('invalid', 'Choose at most 50 Agents');
  const owned = new Set((await db.bots.listBots(userId, { includeArchived: true })).map((bot) => bot.id));
  if (ids.some((id) => !owned.has(id))) throw new VaultError('invalid', 'Unknown Agent');
  return ids;
}

export function toVaultItemView(row: VaultItemRow): VaultItemView {
  return {
    id: row.id,
    label: row.label,
    origins: vaultItemOrigins(row),
    username_hint: row.username_hint,
    has_password: !!row.password_enc,
    has_totp: !!row.totp_enc,
    policy: row.policy,
    always_origins: vaultItemAlwaysOrigins(row),
    bot_ids: vaultItemBotIds(row),
    last_used_at: row.last_used_at,
    created_at: row.created_at,
  };
}

function validLabel(raw: string | undefined): string {
  const label = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!label || [...label].length > VAULT_LABEL_MAX) {
    throw new VaultError('label_invalid', `Give the entry a name of 1–${VAULT_LABEL_MAX} characters`);
  }
  return label;
}

function boundedSecret(value: string, max: number, what: string): string {
  if (value.length > max) throw new VaultError('invalid', `The ${what} is too long`);
  if (/[\r\n]/.test(value)) throw new VaultError('invalid', `The ${what} cannot contain line breaks`);
  return value;
}

/** Validate a TOTP secret on write so a typo surfaces in the form, not at the first sign-in. */
function validTotp(value: string): string {
  const trimmed = boundedSecret(value.trim(), TOTP_MAX, 'authenticator secret');
  parseTotpSecret(trimmed);
  return trimmed;
}

/** The member's entries — or, given an Agent, only those it may use. */
export async function listVaultItems(db: DatabaseProvider, userId: string, botId?: string): Promise<VaultItemView[]> {
  const rows = await db.vault.list(userId);
  return (botId ? rows.filter((row) => vaultItemAllowsBot(row, botId)) : rows).map(toVaultItemView);
}

export async function createVaultItem(
  db: DatabaseProvider,
  userId: string,
  input: VaultItemWrite,
): Promise<VaultItemView> {
  if (!isVaultAvailable()) {
    throw new VaultError('vault_unavailable', 'The password vault is not configured on this deployment.');
  }
  const label = validLabel(input.label);
  const origins = normalizeOriginPatterns(input.origins ?? []);
  const id = newVaultItemId();
  const username = boundedSecret((input.username ?? '').trim(), USERNAME_MAX, 'user name');
  const password = input.password ? boundedSecret(input.password, PASSWORD_MAX, 'password') : '';
  const totp = input.totp ? validTotp(input.totp) : '';
  const botIds = await validBotIds(db, userId, input.bot_ids);
  const row = await db.vault.create({
    id,
    user_id: userId,
    label,
    origins,
    username_enc: username ? encryptVaultField(userId, id, 'username', username) : null,
    username_hint: maskUsername(username),
    password_enc: password ? encryptVaultField(userId, id, 'password', password) : null,
    totp_enc: totp ? encryptVaultField(userId, id, 'totp', totp) : null,
    policy: input.policy ?? 'ask',
    bot_ids: botIds ?? null,
  });
  return toVaultItemView(row);
}

/**
 * Patch an entry. Omitted secrets stay as they are; an empty string clears
 * them. Changing the sites also drops "always allow" grants for sites the
 * entry no longer covers, so a grant can never outlive the binding it was
 * given for.
 */
export async function updateVaultItem(
  db: DatabaseProvider,
  userId: string,
  itemId: string,
  input: VaultItemWrite,
): Promise<VaultItemView> {
  const existing = await db.vault.get(userId, itemId);
  if (!existing) throw new VaultError('not_found', 'Vault entry not found');
  const touchesSecrets = input.username !== undefined || input.password !== undefined || input.totp !== undefined;
  if (touchesSecrets && !isVaultAvailable()) {
    throw new VaultError('vault_unavailable', 'The password vault is not configured on this deployment.');
  }

  const patch: Parameters<DatabaseProvider['vault']['update']>[2] = {};
  if (input.label !== undefined) patch.label = validLabel(input.label);
  if (input.origins !== undefined) {
    const origins = normalizeOriginPatterns(input.origins);
    patch.origins = origins;
    patch.always_origins = vaultItemAlwaysOrigins(existing).filter((origin) => originMatches(origins, origin));
  }
  if (input.policy !== undefined) patch.policy = input.policy;
  if (input.bot_ids !== undefined) patch.bot_ids = (await validBotIds(db, userId, input.bot_ids)) ?? null;
  if (input.always_origins !== undefined) {
    // Narrowing only: anything not already granted is refused, so this path
    // can revoke "always allow" grants but never invent one.
    const current = patch.always_origins ?? vaultItemAlwaysOrigins(existing);
    if (input.always_origins.some((origin) => !current.includes(origin))) {
      throw new VaultError(
        'origin_invalid',
        'Only existing "always allow" sites can be kept; new ones are granted from an approval card.',
      );
    }
    patch.always_origins = current.filter((origin) => input.always_origins!.includes(origin));
  }
  if (input.username !== undefined) {
    const username = boundedSecret(input.username.trim(), USERNAME_MAX, 'user name');
    patch.username_enc = username ? encryptVaultField(userId, itemId, 'username', username) : null;
    patch.username_hint = maskUsername(username);
  }
  if (input.password !== undefined) {
    patch.password_enc = input.password
      ? encryptVaultField(userId, itemId, 'password', boundedSecret(input.password, PASSWORD_MAX, 'password'))
      : null;
  }
  if (input.totp !== undefined) {
    patch.totp_enc = input.totp ? encryptVaultField(userId, itemId, 'totp', validTotp(input.totp)) : null;
  }
  const row = await db.vault.update(userId, itemId, patch);
  if (!row) throw new VaultError('not_found', 'Vault entry not found');
  return toVaultItemView(row);
}

export async function deleteVaultItem(db: DatabaseProvider, userId: string, itemId: string): Promise<boolean> {
  return db.vault.delete(userId, itemId);
}

export async function listVaultAccess(db: DatabaseProvider, userId: string, limit = 100): Promise<VaultAccessView[]> {
  return (await db.vault.listAccess(userId, limit)).map((row) => ({
    id: row.id,
    item_label: row.item_label,
    bot_id: row.bot_id,
    origin: row.origin,
    action: row.action,
    outcome: row.outcome,
    approval: row.approval,
    created_at: row.created_at,
  }));
}

/** Entries whose sites cover a page origin — metadata only (hints, login cards, `vault list`). */
export async function vaultMatchesForOrigin(
  db: DatabaseProvider,
  userId: string,
  origin: string | null,
  /** Only the entries this Agent may use (P3c); omitted = every entry (the member's own screens). */
  botId?: string,
): Promise<Array<{ id: string; label: string; username_hint: string; has_password: boolean; has_totp: boolean }>> {
  if (!origin) return [];
  const rows = await db.vault.list(userId);
  return rows
    .filter((row) => originMatches(vaultItemOrigins(row), origin) && (!botId || vaultItemAllowsBot(row, botId)))
    .map((row) => ({
      id: row.id,
      label: row.label,
      username_hint: row.username_hint,
      has_password: !!row.password_enc,
      has_totp: !!row.totp_enc,
    }));
}

/**
 * Decrypt the secrets of one entry for an immediate fill. The ONLY reader of
 * ciphertext; callers must never log, return or emit what it yields.
 */
export function revealVaultSecrets(
  userId: string,
  row: VaultItemRow,
  fields: ReadonlyArray<'username' | 'password' | 'totp'>,
): { username?: string; password?: string; totp?: string } {
  const out: { username?: string; password?: string; totp?: string } = {};
  for (const field of fields) {
    const ciphertext = field === 'username' ? row.username_enc : field === 'password' ? row.password_enc : row.totp_enc;
    if (ciphertext) out[field] = decryptVaultField(userId, row.id, field, ciphertext);
  }
  return out;
}

/** "Always allow on this site" — appended per (entry, exact origin). */
export async function addAlwaysOrigin(
  db: DatabaseProvider,
  userId: string,
  row: VaultItemRow,
  origin: string,
): Promise<void> {
  const current = vaultItemAlwaysOrigins(row);
  if (current.includes(origin)) return;
  await db.vault.update(userId, row.id, { always_origins: [...current, origin] });
}

/**
 * Save what the member typed into a secure sign-in card. Updates the entry
 * bound to exactly this origin with the same user name when there is one
 * (a changed password should not leave a stale twin), otherwise creates a
 * new entry labelled with the host.
 */
export async function saveSecureLogin(
  db: DatabaseProvider,
  userId: string,
  origin: string,
  values: { username?: string; password?: string; otp?: string },
): Promise<VaultItemView | null> {
  const username = values.username?.trim() ?? '';
  if (!username && !values.password) return null;
  for (const row of await db.vault.list(userId)) {
    if (!vaultItemOrigins(row).includes(origin)) continue;
    const stored = row.username_enc ? revealVaultSecrets(userId, row, ['username']).username : '';
    if ((stored ?? '') !== username) continue;
    return values.password ? updateVaultItem(db, userId, row.id, { password: values.password }) : toVaultItemView(row);
  }
  return createVaultItem(db, userId, {
    label: hostOfOrigin(origin).slice(0, VAULT_LABEL_MAX),
    origins: [origin],
    username,
    password: values.password,
  });
}

/** Append one metadata-only access-log row; never throws into the fill path. */
export async function recordVaultAccess(db: DatabaseProvider, input: VaultAccessInput): Promise<void> {
  try {
    await db.vault.logAccess(input);
  } catch (err) {
    // The fill already happened (or was refused); a lost audit row must not
    // turn into a second, confusing failure for the member.
    logger.warn('[bots/vault] access log write failed', {
      userId: input.user_id,
      action: input.action,
      error: toErrorMessage(err),
    });
  }
}
