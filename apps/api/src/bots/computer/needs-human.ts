/**
 * "Does a person need to step in?" — a cheap sniff after every navigation or
 * submit, so a Bot that lands on a sign-in wall, an OTP prompt or a CAPTCHA is
 * told the right next move (vault entry ids for this exact site, else
 * request_takeover) instead of guessing, typing into password fields, or
 * looping on a challenge it cannot pass.
 *
 * Signals are read from the DOM of the main frame (visible elements only — an
 * invisible reCAPTCHA v3 badge must not cry wolf on every page) plus the title.
 * A widget whose response token is already filled in counts as solved: a
 * reCAPTCHA v2 box stays on the page with its tick after the member passed it,
 * and the human-check watcher (human-check.ts) must see that page as clean.
 *
 * A human check (CAPTCHA, a challenge page that does not clear, a Cloudflare
 * block) is the member's to pass: the browser hands it over at once
 * (browser-session.ts) and nothing here ever tries to solve or bypass it.
 */

import type { Page } from 'playwright-core';
import { withTimeout } from './tab-leases.js';

export type NeedsHumanKind = 'captcha' | 'challenge' | 'otp' | 'login';

export interface NeedsHumanSignals {
  title: string;
  /** Leading visible text of the body (challenge interstitials say so). */
  text: string;
  captcha: number;
  otp: number;
  currentPassword: number;
}

/** Runs in the page (self-contained). */
function readSignals(): NeedsHumanSignals {
  const visible = (el: Element) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') > 0.05;
  };
  const all = (selector: string) => Array.from(document.querySelectorAll(selector)).filter(visible);
  // The token a widget writes into the host page once it was passed.
  const solved = Array.from(
    document.querySelectorAll(
      '[name="g-recaptcha-response"], [name="h-captcha-response"], [name="cf-turnstile-response"]',
    ),
  ).some((el) => ((el as HTMLInputElement).value || '').trim().length > 0);
  const captchaFrames = all('iframe').filter((frame) => {
    const src = (frame as HTMLIFrameElement).src || '';
    const title = frame.getAttribute('title') || '';
    if (/size=invisible/.test(src)) return false;
    return /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|captcha|arkoselabs|funcaptcha|geetest/i.test(
      `${src} ${title}`,
    );
  });
  const captchaWidgets = all(
    '.g-recaptcha, .h-captcha, .cf-turnstile, #cf-turnstile, #captcha, .captcha, .geetest_holder, [id^="captcha" i]',
  );
  const otp = all(
    [
      'input[autocomplete~="one-time-code"]',
      'input[name*="otp" i]',
      'input[id*="otp" i]',
      'input[name*="totp" i]',
      'input[name*="2fa" i]',
      'input[name*="mfa" i]',
      'input[name*="verification_code" i]',
      'input[name*="verificationcode" i]',
      'input[id*="verification-code" i]',
    ].join(', '),
  );
  const passwords = all('input[type="password"]').filter(
    (input) => (input.getAttribute('autocomplete') || '').toLowerCase() !== 'new-password',
  );
  return {
    title: document.title || '',
    text: (document.body?.innerText || '').slice(0, 400),
    captcha: solved ? 0 : captchaFrames.length + captchaWidgets.length,
    otp: otp.length,
    currentPassword: passwords.length,
  };
}

const CHALLENGE =
  /just a moment|attention required|verify you are human|verifying you are human|checking your browser|are you a robot|请稍候|安全验证|人机验证|验证您是真人/i;

/** Statuses a bot wall answers with (Cloudflare: 403 challenge / block, 429 rate limit, 503 "under attack"). */
const BLOCK_STATUSES: ReadonlySet<number> = new Set([403, 406, 429, 503]);

/** What browser-session.ts keeps of a main-frame navigation response. */
export interface NavigationResponse {
  status: number;
  /** Lower-cased header names (Playwright's `response.headers()`). */
  headers: Record<string, string>;
}

/**
 * A navigation Cloudflare answered with a human check: a blocking status plus
 * `cf-mitigated` (its challenge marker), or `server: cloudflare` with a
 * challenge title. Catches the challenge pages the DOM sniff misses (a
 * localized or empty title).
 */
export function isCloudflareBlock(response: NavigationResponse | null, title: string): boolean {
  if (!response || !BLOCK_STATUSES.has(response.status)) return false;
  if (response.headers['cf-mitigated']) return true;
  return /cloudflare/i.test(response.headers.server ?? '') && CHALLENGE.test(title);
}

/** Pure classification of the signals (most specific first). */
export function classifyNeedsHuman(signals: NeedsHumanSignals): NeedsHumanKind | null {
  if (CHALLENGE.test(signals.title) || CHALLENGE.test(signals.text.slice(0, 200))) return 'challenge';
  if (signals.captcha > 0) return 'captcha';
  if (signals.otp > 0) return 'otp';
  if (signals.currentPassword > 0) return 'login';
  return null;
}

/** Sniff the page; null when nothing needs a person (or the page could not be read). */
export async function sniffNeedsHuman(page: Page): Promise<NeedsHumanKind | null> {
  try {
    return classifyNeedsHuman(await withTimeout(page.mainFrame().evaluate(readSignals), 3_000));
  } catch {
    return null;
  }
}

export interface VaultMatch {
  id: string;
  label: string;
  username_hint: string;
  has_password: boolean;
  has_totp: boolean;
}

/**
 * The hint appended to a browser result. `vault` is null when the Bot has no
 * vault tool this turn (background, or the vault is not configured);
 * `canTakeover` is false for background turns, which cannot raise cards.
 */
export function needsHumanHint(
  kind: NeedsHumanKind,
  origin: string | null,
  vault: VaultMatch[] | null,
  canTakeover: boolean,
): string {
  const site = origin ?? 'this page';
  if (!canTakeover) {
    return kind === 'login' || kind === 'otp'
      ? `${site} wants a sign-in. A background task cannot sign in — note it in your report and continue with what you can read.`
      : `${site} shows a bot check a background task cannot pass — note it in your report and move on.`;
  }
  if (kind === 'challenge' || kind === 'captcha') {
    // Reached only when no verification card could be raised (humanCheckHint is the usual path).
    return `${site} asks for human verification. Do not try to solve it or another address on this site: call request_takeover with kind "captcha" and end your turn.`;
  }
  const want = kind === 'otp' ? (m: VaultMatch) => m.has_totp : (m: VaultMatch) => m.has_password || !!m.username_hint;
  const matches = (vault ?? []).filter(want);
  if (matches.length > 0) {
    const list = matches.map((m) => `${m.id} (${m.label}${m.username_hint ? `, ${m.username_hint}` : ''})`).join('; ');
    return kind === 'otp'
      ? `${site} asks for a one-time code. Vault entries with an authenticator for this site: ${list}. Use vault fill_totp {item_id}.`
      : `${site} is a sign-in page. Vault entries for this site: ${list}. Use vault fill_login {item_id} — never type a password yourself.`;
  }
  return kind === 'otp'
    ? `${site} asks for a one-time code${vault ? ' and the vault has no authenticator for it' : ''}. Call request_takeover with kind "otp" and end your turn.`
    : `${site} is a sign-in page${vault ? ' and the vault has no entry for it' : ''}. Call request_takeover with kind "login" (the member signs in on a secure card you never see) and end your turn. Never ask for a password in chat.`;
}

/**
 * The hint for a human check the browser handed to the member: a verification
 * card is up and the turn ends after this step. Left to itself a model routes
 * around a block — another URL on the site, curl, a search — so each is named.
 */
export function humanCheckHint(origin: string | null): string {
  return `${origin ?? 'This page'} asks for human verification. The member now has a card to complete it on the computer, and you will be woken automatically when they are done. End your turn NOW with one short line saying what you were doing. Never try to solve or bypass it, and do not try another address on this site or reach it with the shell or a search.`;
}

/** Why a second `open` of a site that asked for human verification in this turn is refused. */
export function humanCheckRefusal(origin: string, background: boolean): string {
  return background
    ? `${origin} asked for human verification, which a background task cannot pass. Do not try other addresses on this site: note it in your report and move on.`
    : `${origin} asked for human verification and is waiting for the member. Do not try other addresses on this site: end your turn with one short line.`;
}
