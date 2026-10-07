/**
 * `vault` — the member's saved logins, usable without being seen.
 *
 * `list` returns metadata only (label, sites, masked user name, whether a
 * password / authenticator is saved, and which entries match the page the Bot
 * is on). `fill_login` / `fill_totp` hand off to vault/fill.ts, where the
 * origin binding, approval and per-field checks live. Built only for
 * foreground turns on deployments where the vault is configured.
 */

import { tool, type Tool } from 'ai';
import { z } from 'zod';
import type { BotTurnContext } from '../engine/context.js';
import { defaultComputerDeps, failure, findLeasePage, type ComputerDeps } from '../computer/browser-session.js';
import { fillLogin, fillTotp, type FillTurn } from '../vault/fill.js';
import { originMatches, originOfUrl } from '../vault/origin.js';
import { listVaultItems } from '../vault/service.js';
import { foreignTurnReads } from '../vault/turn-observations.js';
import { BOT_TOOL_METAS } from './meta.js';
import { implicitTakeoverFor } from './takeover.js';

const meta = BOT_TOOL_METAS.find((m) => m.id === 'vault')!;

const schema = z.object({
  action: z.enum(['list', 'fill_login', 'fill_totp']),
  item_id: z.string().max(40).optional().describe('fill_login/fill_totp: the entry id from list.'),
  submit: z.boolean().optional().describe('Press Enter after filling (default false).'),
});

export function fillTurnFrom(ctx: BotTurnContext, deps: ComputerDeps = defaultComputerDeps): FillTurn {
  const implicitTakeover = implicitTakeoverFor(ctx, deps);
  return {
    db: ctx.db,
    userId: ctx.userId,
    botId: ctx.bot.id,
    botName: ctx.bot.name,
    sessionId: ctx.sessionId,
    locale: ctx.locale,
    background: ctx.background,
    userTriggered: ctx.userTriggered,
    observedForeign: (patterns) => foreignTurnReads(ctx, patterns, ctx.isTainted()),
    signal: ctx.signal,
    requestApproval: (payload, opts) => ctx.requestApproval(payload, opts),
    ...(implicitTakeover ? { implicitTakeover } : {}),
  };
}

export async function runVaultAction(
  ctx: BotTurnContext,
  input: z.infer<typeof schema>,
  deps: ComputerDeps = defaultComputerDeps,
): Promise<Record<string, unknown>> {
  if (input.action === 'list') {
    const items = await listVaultItems(ctx.db, ctx.userId);
    const found = await findLeasePage(ctx.userId, ctx.bot.id, ctx.sessionId, deps).catch(() => null);
    const currentSite = originOfUrl(found?.page.url());
    return {
      current_site: currentSite,
      entries: items.map((item) => ({
        id: item.id,
        label: item.label,
        sites: item.origins,
        username_hint: item.username_hint,
        has_password: item.has_password,
        has_totp: item.has_totp,
        ...(currentSite ? { matches_current_page: originMatches(item.origins, currentSite) } : {}),
      })),
      ...(items.length === 0
        ? { note: 'The vault is empty. For a sign-in, call request_takeover with kind "login".' }
        : {}),
    };
  }
  if (!input.item_id) return { ...failure('invalid', `${input.action} needs an item_id from vault list.`) };
  const turn = fillTurnFrom(ctx, deps);
  const args = { item_id: input.item_id, submit: input.submit };
  const result = input.action === 'fill_login' ? await fillLogin(turn, args, deps) : await fillTotp(turn, args, deps);
  return { ...result };
}

export function createVaultTool(ctx: BotTurnContext, deps: ComputerDeps = defaultComputerDeps): Tool {
  return tool({
    description: meta.description,
    inputSchema: schema,
    execute: (input) => runVaultAction(ctx, input, deps),
  });
}
