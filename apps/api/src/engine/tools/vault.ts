import { z } from 'zod';
import { BrowserRefusal, type BrowserService } from '../../modules/computers/browser.js';
import { signIn } from '../../modules/vault/fill.js';
import { hostOf } from '../../modules/vault/origin.js';
import type { VaultService } from '../../modules/vault/service.js';
import { computerAvailable } from './computer.js';
import { defineTool } from './define.js';

/** What a sign-in card holds: which login, on which site. Never a value. */
interface LoginCard {
  item_id: string;
  item_label: string;
  site: string;
  username_hint: string;
  submit: boolean;
}

/**
 * The member's saved logins, used without being seen: the server types them into the browser's
 * page. Only the member's own Agents (and only those a login names) use the vault; a public
 * Agent never gets it.
 */
export function vaultTool(vault: VaultService, browser: BrowserService) {
  const deps = { vault, browser };
  return defineTool({
    name: 'vault',
    description:
      "The member's saved logins, which you use without ever seeing them. `find` lists the logins for the site your browser shows (labels and masked user names only). `fill` signs in with one: Greenhouse types the user name, password and one-time code into the page itself, and with submit (the default) presses Enter and follows a next page that asks for the password or the code. Some logins need the member's approval first: a sign-in card is raised and your turn ends; you are told the outcome. When there is no login for the site, ask the member to sign in themselves with request_takeover.",
    input: z.discriminatedUnion('action', [
      z.object({ action: z.literal('find') }),
      z.object({
        action: z.literal('fill'),
        item_id: z.string().min(1).max(64).describe('The login id from find.'),
        submit: z.boolean().default(true),
      }),
    ]),
    risk: 'read',
    private: true,
    surfaces: ['turn'],
    available: async (ctx) => vault.available && (await computerAvailable(ctx)),
    async execute(args, ctx) {
      // Never someone else's Agent: the vault is the member's own.
      if (ctx.agent.ownerId !== ctx.memberId) return { error: 'The vault is not available to you.', code: 'forbidden' };
      if (args.action === 'find') {
        let site: string | null;
        try {
          site = await browser.withPage(
            ctx.memberId,
            ctx.agent.id,
            { signal: ctx.signal },
            async (page) => (await page.frame()).origin,
          );
        } catch (error) {
          if (error instanceof BrowserRefusal) return { error: error.message, code: error.code };
          throw error;
        }
        if (!site) return { site: null, logins: [], note: 'Open the site’s sign-in page in your browser first.' };
        const logins = await vault.matching(ctx.memberId, ctx.agent.id, site);
        return {
          site,
          logins,
          ...(logins.length
            ? {}
            : { note: 'There is no saved login for this site. Ask the member to sign in with request_takeover.' }),
        };
      }
      const outcome = await signIn(deps, {
        memberId: ctx.memberId,
        agentId: ctx.agent.id,
        conversationId: ctx.conversation?.id ?? null,
        itemId: args.item_id,
        submit: args.submit,
        signal: ctx.signal,
      });
      if (outcome.status === 'filled') {
        return {
          filled: outcome.fields,
          site: outcome.site,
          submitted: outcome.submitted,
          note: 'Filled. Take a snapshot to see where the sign-in led.',
        };
      }
      if (outcome.status === 'refused') return { error: outcome.message, code: outcome.code };
      const card: LoginCard = {
        item_id: outcome.item.id,
        item_label: outcome.item.label,
        site: outcome.site,
        username_hint: outcome.item.usernameHint,
        submit: args.submit,
      };
      const host = hostOf(outcome.site);
      const request = await ctx.raise({
        kind: 'login',
        subject: 'vault_fill',
        title:
          ctx.locale === 'zh'
            ? `${ctx.agent.name} 想用「${card.item_label}」登录 ${host}`
            : `${ctx.agent.name} wants to sign in to ${host} with "${card.item_label}"`,
        payload: { ...card },
        waits: true,
      });
      await vault.record({
        memberId: ctx.memberId,
        item: outcome.item,
        agentId: ctx.agent.id,
        conversationId: ctx.conversation?.id ?? null,
        origin: outcome.site,
        outcome: 'requested',
        approval: null,
      });
      return {
        status: 'needs_approval',
        request_id: request.id,
        note: 'The member sees a sign-in card. End your turn now; you are told the outcome.',
      };
    },
    async decide(request, ctx) {
      const zh = ctx.locale === 'zh';
      const card = request.payload as unknown as LoginCard;
      const label = String(card.item_label ?? '');
      const site = String(card.site ?? '');
      if (request.status === 'approved') {
        if (ctx.agent.ownerId !== ctx.memberId) {
          return { line: zh ? '无法代填登录' : 'The sign-in could not be done', note: null };
        }
        const outcome = await signIn(deps, {
          memberId: ctx.memberId,
          agentId: ctx.agent.id,
          conversationId: request.conversationId,
          itemId: String(card.item_id ?? ''),
          submit: card.submit !== false,
          approvedSite: site,
        });
        if (outcome.status === 'filled') {
          return {
            line: zh ? `已用「${label}」登录 ${hostOf(site)}` : `Signed in to ${hostOf(site)} with "${label}"`,
            note: `The member approved signing in to ${site} with "${label}". It was filled (${outcome.fields.join(', ')})${outcome.submitted ? ' and submitted' : ''}. Take a snapshot to see where you are before you go on.`,
          };
        }
        return {
          line: zh
            ? `「${label}」没能登录 ${hostOf(site)}`
            : `Signing in to ${hostOf(site)} with "${label}" did not work`,
          note: `The member approved signing in to ${site} with "${label}", but it could not be done: ${outcome.status === 'refused' ? outcome.message : 'the page asked again'}`,
        };
      }
      if (request.status === 'rejected') {
        const [item] = await vault.forAgent(ctx.memberId, ctx.agent.id, String(card.item_id ?? '')).then(
          (row) => [row],
          () => [null],
        );
        if (item) {
          await vault.record({
            memberId: ctx.memberId,
            item,
            agentId: ctx.agent.id,
            conversationId: request.conversationId,
            origin: site,
            outcome: 'declined',
            approval: null,
          });
        }
        const reason =
          typeof request.result?.reason === 'string' && request.result.reason
            ? ` and says: ${request.result.reason}`
            : '';
        return {
          line: zh ? `已拒绝用「${label}」登录` : `Declined signing in with "${label}"`,
          note: `The member declined signing you in to ${site} with "${label}"${reason}. Do not try again unless they ask.`,
        };
      }
      if (request.status === 'handed_back') {
        const note =
          typeof request.result?.note === 'string' && request.result.note ? ` and says: ${request.result.note}` : '';
        return {
          line: zh ? '已手动登录' : 'Signed in by hand',
          note: `The member signed in to ${site} on your computer themselves${note}. Take a snapshot to see where you are before you go on.`,
        };
      }
      return { line: zh ? '登录请求已过期' : 'Sign-in request expired', note: null };
    },
    summarize: (args, output, locale) => {
      const zh = locale === 'zh';
      const result = output as { error?: string; status?: string; filled?: string[] } | undefined;
      if (args.action === 'find') return zh ? '查了密码库' : 'Looked in the vault';
      if (result?.status === 'needs_approval') return zh ? '请你批准登录' : 'Asked you to approve a sign-in';
      if (result?.filled) return zh ? '用密码库登录了' : 'Signed in from the vault';
      return zh ? '没能用密码库登录' : 'Could not sign in from the vault';
    },
  });
}
