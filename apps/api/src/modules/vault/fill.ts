/**
 * Signing in with a vault login: the server types the user name, the password and a fresh
 * one-time code into the page through DevTools (`Input.insertText`), so no value ever passes
 * through a model, a transcript, a tool result, a log line or an error.
 *
 * Order of checks:
 * 1. The login exists, is the member's, and this Agent may use it.
 * 2. The page's origin, as the browser reports it, is one of the login's sites.
 * 3. Approval: `auto` fills; `ask` fills on a site the member always allows, and otherwise
 *    waits for the member's sign-in card. An approved card fills only on the site it named.
 * 4. Right before each field: the member has not taken the screen, the page is still the same
 *    document on the login's site, and the field is one our script found in the main frame (a
 *    password only ever goes into a password field).
 * 5. With `submit`, Enter follows; a sign-in that asks for the password or the code on a next
 *    page (same site) is followed for up to three pages.
 * Every attempt writes one access-log row.
 */

import type { VaultItem as VaultItemRow } from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { ApiError } from '../../http/errors.js';
import { BrowserRefusal, pressKey, TAKEN_OVER, type BrowserService, type Page } from '../computers/browser.js';
import { originMatches } from './origin.js';
import type { VaultSecrets, VaultService } from './service.js';
import { currentTotp } from './totp.js';

export type Field = 'username' | 'password' | 'otp';

export type SignInOutcome =
  | { status: 'filled'; site: string; fields: Field[]; submitted: boolean }
  | { status: 'needs_card'; site: string; item: VaultItemRow }
  | { status: 'refused'; code: string; message: string };

/** A fill stopped before or while typing; the code is the access log's outcome. */
class FillStop extends Error {
  constructor(
    readonly outcome: 'origin_mismatch' | 'no_fields' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

/**
 * The page script that finds sign-in fields in the main document. It runs in the isolated world
 * and never sees a value: it reports, focuses and measures; the browser types.
 */
const FINDER = `function (op) {
  const kind = (el) => (el.getAttribute('type') || 'text').toLowerCase();
  const hints = (el) => [el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('aria-label'), el.getAttribute('placeholder')]
    .filter(Boolean).join(' ').toLowerCase();
  const shown = (el) => {
    if (el.disabled || el.readOnly) return false;
    const box = el.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0.05;
  };
  const textual = (el) => ['text', 'email', 'tel', ''].includes(kind(el));
  const inputs = Array.from(document.querySelectorAll('input')).filter(shown);
  const passwords = inputs.filter((el) => kind(el) === 'password');
  const password = passwords.find((el) => !/new-password/.test(hints(el))) || passwords[0] || null;
  let username =
    inputs.find((el) => textual(el) && /(^|\\s)(username|email)(\\s|$)/.test((el.getAttribute('autocomplete') || '').toLowerCase())) ||
    inputs.find((el) => kind(el) === 'email') ||
    inputs.find((el) => textual(el) && /user|e-?mail|login|account|phone|mobile|账号|帳號|用户|用戶|邮箱|手机/.test(hints(el)) && !/search|otp|code|captcha|验证码/.test(hints(el))) ||
    null;
  if (!username && password) {
    const before = inputs.filter((el) => textual(el) && (el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING));
    username = before[before.length - 1] || null;
  }
  const boxes = inputs.filter((el) => el.maxLength === 1 && (textual(el) || kind(el) === 'number'));
  let otp = boxes.length >= 4 && boxes.length <= 8 ? boxes : null;
  if (!otp) {
    const single =
      inputs.find((el) => /one-time-code/.test((el.getAttribute('autocomplete') || '').toLowerCase())) ||
      inputs.find((el) => (textual(el) || kind(el) === 'number') && /otp|totp|2fa|mfa|two.?factor|verif|code|验证码|动态码/.test(hints(el)) &&
        !/post|zip|promo|coupon|country|area|discount|gift|captcha|invite|referr/.test(hints(el)));
    if (single && single !== username) otp = [single];
  }
  const found = { username, password, otp };
  if (op.op === 'scan') return { username: !!username, password: !!password, otp: otp ? otp.length : 0 };
  const list = op.field === 'otp' ? otp || [] : found[op.field] ? [found[op.field]] : [];
  const el = list[op.index || 0];
  if (!el) return op.op === 'length' ? -1 : false;
  if (op.op === 'focus') {
    el.focus();
    if (typeof el.select === 'function') el.select();
    return document.activeElement === el;
  }
  if (op.op === 'length') return (el.value || '').length;
  return false;
}`;

const finder = (op: { op: 'scan' } | { op: 'focus' | 'length'; field: Field; index: number }) =>
  `(${FINDER})(${JSON.stringify(op)})`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A code with a few seconds left is not worth typing: wait for the next one. */
async function freshCode(totp: string): Promise<string> {
  const now = currentTotp(totp);
  if (now.validForSec >= 4) return now.code;
  await sleep(now.validForSec * 1000 + 300);
  return currentTotp(totp).code;
}

/** Types the login into the page, following up to three sign-in pages on the login's sites. */
async function typeLogin(
  page: Page,
  origins: readonly string[],
  secrets: VaultSecrets,
  options: { submit: boolean; remember: (value: string) => void },
): Promise<{ fields: Field[]; submitted: boolean }> {
  const filled: Field[] = [];
  let submitted = false;
  for (let round = 0; round < 3; round++) {
    const main = await page.frame();
    if (!originMatches(origins, main.origin)) {
      if (round === 0) throw new FillStop('origin_mismatch', 'The page is not on one of the login’s sites.');
      break;
    }
    const scan = await page.run<{ username: boolean; password: boolean; otp: number }>(finder({ op: 'scan' }));
    const plan: Array<{ field: Field; values: string[] }> = [];
    if (scan.username && secrets.username && !filled.includes('username')) {
      plan.push({ field: 'username', values: [secrets.username] });
    }
    if (scan.password && secrets.password && !filled.includes('password')) {
      plan.push({ field: 'password', values: [secrets.password] });
    }
    if (scan.otp && secrets.totp && !filled.includes('otp')) {
      const code = await freshCode(secrets.totp);
      // One box per digit, or one field for the whole code.
      if (scan.otp > 1 && scan.otp !== code.length) {
        throw new FillStop('no_fields', 'The code boxes on the page do not match the length of this login’s codes.');
      }
      options.remember(code);
      plan.push({ field: 'otp', values: scan.otp > 1 ? [...code] : [code] });
    }
    if (!plan.length) break;
    let last: { field: Field; index: number } | null = null;
    for (const entry of plan) {
      for (let index = 0; index < entry.values.length; index++) {
        if (!(await page.stillOurs())) throw new BrowserRefusal('member_in_control', TAKEN_OVER);
        const now = await page.frame();
        if (now.loaderId !== main.loaderId || !originMatches(origins, now.origin)) {
          throw new FillStop('failed', 'The page changed during the sign-in.');
        }
        if (!(await page.run<boolean>(finder({ op: 'focus', field: entry.field, index })))) {
          throw new FillStop('no_fields', 'The sign-in field could not be focused.');
        }
        const value = entry.values[index]!;
        await page.send('Input.insertText', { text: value });
        if ((await page.run<number>(finder({ op: 'length', field: entry.field, index }))) < 1) {
          throw new FillStop('failed', 'The page did not take what was typed.');
        }
        last = { field: entry.field, index };
      }
      filled.push(entry.field);
    }
    if (!options.submit || !last) break;
    if (!(await page.stillOurs())) throw new BrowserRefusal('member_in_control', TAKEN_OVER);
    // Enter in the last field filled, as a person would submit.
    await page.run<boolean>(finder({ op: 'focus', field: last.field, index: last.index }));
    await pressKey(page);
    submitted = true;
    await page.settle();
  }
  if (!filled.length) throw new FillStop('no_fields', 'No sign-in fields for this login were found on the page.');
  return { fields: filled, submitted };
}

/**
 * Signs the Agent in with a login on the page its browser shows. Without `approvedSite` this is
 * the Agent's own call: an `ask` login answers `needs_card` (the caller raises it, outside the
 * browser's lease). With it, the member approved this login on that site.
 */
export async function signIn(
  deps: { vault: VaultService; browser: BrowserService },
  input: {
    memberId: string;
    agentId: string;
    conversationId: string | null;
    itemId: string;
    submit: boolean;
    approvedSite?: string;
    signal?: AbortSignal;
  },
): Promise<SignInOutcome> {
  let item: VaultItemRow;
  try {
    item = await deps.vault.forAgent(input.memberId, input.agentId, input.itemId);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'not_found') {
      return { status: 'refused', code: 'login_not_found', message: 'There is no such login for you. Use vault find.' };
    }
    throw error;
  }
  const record = (
    origin: string,
    outcome: Parameters<VaultService['record']>[0]['outcome'],
    approval: Parameters<VaultService['record']>[0]['approval'],
  ) =>
    deps.vault.record({
      memberId: input.memberId,
      item,
      agentId: input.agentId,
      conversationId: input.conversationId,
      origin,
      outcome,
      approval,
    });
  try {
    return await deps.browser.withPage(
      input.memberId,
      input.agentId,
      { approved: input.approvedSite !== undefined, ...(input.signal ? { signal: input.signal } : {}) },
      async (page): Promise<SignInOutcome> => {
        const { origin } = await page.frame();
        if (!origin) {
          return { status: 'refused', code: 'no_site', message: 'Open the site’s sign-in page in your browser first.' };
        }
        if (!originMatches(item.origins, origin) || (input.approvedSite && origin !== input.approvedSite)) {
          await record(origin, 'origin_mismatch', input.approvedSite ? 'member' : null);
          return {
            status: 'refused',
            code: 'origin_mismatch',
            message: input.approvedSite
              ? `The page moved to ${origin} after the member approved signing in to ${input.approvedSite}, so nothing was filled.`
              : `This login is for ${item.origins.join(', ')}, and the page is on ${origin}. Nothing was filled.`,
          };
        }
        const approval = input.approvedSite
          ? 'member'
          : item.policy === 'auto'
            ? 'auto'
            : item.alwaysOrigins.includes(origin)
              ? 'always'
              : null;
        if (!approval) return { status: 'needs_card', site: origin, item };
        try {
          const typed = await typeLogin(page, item.origins, deps.vault.reveal(item), {
            submit: input.submit,
            remember: (value) => deps.browser.remember(input.memberId, value),
          });
          await record(origin, 'filled', approval);
          if (!typed.submitted)
            await page
              .run(
                `{ const form = document.activeElement?.form; globalThis.__greenhouseApprovedLoginForm = form ? { form, action: form.action, method: form.method } : null; }`,
              )
              .catch(() => undefined);
          return { status: 'filled', site: origin, ...typed };
        } catch (error) {
          if (error instanceof FillStop) {
            await record(origin, error.outcome, approval);
            return { status: 'refused', code: error.outcome, message: error.message };
          }
          await record(origin, 'failed', approval);
          throw error;
        }
      },
    );
  } catch (error) {
    if (error instanceof BrowserRefusal) return { status: 'refused', code: error.code, message: error.message };
    if (error instanceof ApiError) return { status: 'refused', code: error.code, message: error.message };
    // Whatever failed, the message is about the browser, never about a value.
    logger.warn('[vault] a sign-in failed', { error: toErrorMessage(error).slice(0, 300) });
    return { status: 'refused', code: 'failed', message: 'The sign-in could not be completed in the browser.' };
  }
}
